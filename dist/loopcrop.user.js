// ==UserScript==
// @name         loopcrop
// @namespace    https://github.com/C0llap5ar/loopcrop
// @version      0.1.0
// @description  Drive an AI chat web UI in a loop: send a prompt, wait for the turn to settle, harvest the files it produced, repeat.
// @author       C0llap5ar
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ── core/protocol.js ────────────────────────────
  /**
   * loopcrop — adapter protocol v1
   *
   * An *adapter* is the only site-specific piece. It runs **inside the chat page**
   * (same origin), so it can touch the DOM and call the site's own private APIs with
   * the user's real session.
   *
   * It is deliberately tiny: 4 methods. Everything else — the loop, the pacing, the
   * dedupe, the disk writes, the stop conditions — lives in transport-agnostic code
   * (`core/engine.js`) so a single adapter is all it takes to support a new site.
   *
   * ── Contract ───────────────────────────────────────────────────────────────────
   *
   *  probe()                -> { ok, site, conversationId, url, title, model? }
   *      Cheap, side-effect free. Answers "am I on a page I understand?".
   *
   *  send(text)             -> { ok }
   *      Put `text` in the composer and submit it. Must go through the real UI path
   *      (native input events) so the site's own state machine updates.
   *
   *  status({ sinceId })    -> TurnStatus
   *      Read the authoritative turn state. `phase` is one of:
   *        "idle"       nothing running, last turn is settled
   *        "running"    the model is still producing
   *        "stalled"    no progress for longer than `stallMs` (caller decides)
   *      `lastMessageId` identifies the newest assistant message; `sinceId` lets the
   *      adapter return only what changed.
   *
   *  harvest({ messageId }) -> Artifact[]
   *      Everything the assistant produced that is worth persisting. The adapter
   *      resolves them to real bytes (see Artifact.bytes).
   *
   * ── TurnStatus ─────────────────────────────────────────────────────────────────
   *   {
   *     phase: "idle" | "running" | "stalled",
   *     lastMessageId: string | null,
   *     lastMessageAt: number | null,   // epoch ms
   *     model: string | null,
   *     textLength: number,             // chars in the newest assistant message
   *     tail: string,                   // last ~200 chars, for logging / stop rules
   *     error?: string
   *   }
   *
   * ── Artifact ───────────────────────────────────────────────────────────────────
   *   {
   *     id: string,            // stable for dedupe — prefer the site's own file id
   *     name: string,          // filename as the model named it
   *     mime: string,
   *     bytes: Uint8Array,     // the real content, already fetched
   *     messageId: string,
   *     source: string         // human-readable origin, for logs
   *   }
   *
   * Adapters never write to disk and never decide when to stop. They answer four
   * questions and stay out of the way.
   */
  const PROTOCOL_VERSION = 1;
  const REQUIRED_METHODS = Object.freeze(['probe', 'send', 'status', 'harvest']);
  const PHASES = Object.freeze(['idle', 'running', 'stalled']);

  /** Validate an adapter before the engine trusts it with a conversation. */
  function validateAdapter(adapter) {
    const problems = [];
    if (!adapter || typeof adapter !== 'object') {
      return { ok: false, problems: ['adapter is not an object'] };
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof adapter[method] !== 'function') problems.push(`missing method: ${method}`);
    }
    if (typeof adapter.id !== 'string' || !adapter.id) problems.push('missing string field: id');
    if (typeof adapter.displayName !== 'string') problems.push('missing string field: displayName');
    if (adapter.protocolVersion !== undefined && adapter.protocolVersion !== PROTOCOL_VERSION) {
      problems.push(`protocolVersion ${adapter.protocolVersion} != ${PROTOCOL_VERSION}`);
    }
    return { ok: problems.length === 0, problems };
  }

  /** Normalize whatever an adapter returned into a TurnStatus the engine can act on. */
  function normalizeStatus(raw) {
    const phase = PHASES.includes(raw?.phase) ? raw.phase : 'idle';
    return {
      phase,
      lastMessageId: raw?.lastMessageId ?? null,
      lastMessageAt: Number.isFinite(raw?.lastMessageAt) ? raw.lastMessageAt : null,
      model: raw?.model ?? null,
      textLength: Number.isFinite(raw?.textLength) ? raw.textLength : 0,
      tail: typeof raw?.tail === 'string' ? raw.tail : '',
      error: raw?.error,
    };
  }

  /**
   * Turn an adapter's harvest output into artifacts the sink can persist,
   * dropping anything malformed instead of crashing mid-run.
   *
   * Bytes arrive in one of two shapes:
   *   Uint8Array  — userscript path, same realm, no serialization
   *   base64      — CLI path, the value crossed a CDP boundary where typed arrays
   *                 degrade into plain objects
   * Both are normalized to Uint8Array so sinks only ever see one thing.
   */
  function normalizeArtifacts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      if (typeof a.name !== 'string' || !a.name) continue;

      let bytes = null;
      if (a.bytes instanceof Uint8Array) {
        bytes = a.bytes;
      } else if (typeof a.bytes === 'string') {
        bytes = base64ToBytes(a.bytes);
      }
      if (!bytes) continue;

      out.push({
        id: String(a.id ?? a.name),
        name: a.name,
        mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
        bytes,
        messageId: a.messageId == null ? null : String(a.messageId),
        source: typeof a.source === 'string' ? a.source : 'unknown',
      });
    }
    return out;
  }

  /**
   * Normalize whatever an adapter's `harvest` returned into the three things the
   * engine now persists: the full reply text, its structural blocks, and the
   * artifacts.
   *
   * Backward compatible: an adapter that still returns a bare `Artifact[]` is treated
   * as "no text, no blocks". A newer adapter returns `{ text, blocks, artifacts }`.
   */
  function normalizeHarvest(raw) {
    if (Array.isArray(raw)) {
      return { text: '', blocks: [], artifacts: normalizeArtifacts(raw) };
    }
    return {
      text: typeof raw?.text === 'string' ? raw.text : '',
      blocks: Array.isArray(raw?.blocks) ? raw.blocks : [],
      artifacts: normalizeArtifacts(raw?.artifacts),
    };
  }
  function base64ToBytes(b64) {
    try {
      if (typeof atob === 'function') {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      return new Uint8Array(Buffer.from(b64, 'base64'));
    } catch {
      return null;
    }
  }

  // ── core/stops.js ───────────────────────────────
  /**
   * Stop conditions decide when a loop is finished. They are pure predicates over
   * the run state, so they are trivially testable and easy to combine.
   *
   *   import { anyOf, maxTurns, sawText } from './core/stops.js'
   *   recipe.stop = anyOf(maxTurns(30), sawText('全书完'))
   */

  /**
   * @typedef {object} RunState
   * @property {number} turn         1-based index of the turn that just settled
   * @property {number} turnsCompleted
   * @property {number} consecutiveErrors
   * @property {string} tail         last chars of the newest assistant message
   * @property {number} startedAt
   * @property {number} now
   * @property {number} artifactsThisRun   total files saved so far
   */

  const norm = (s) => String(s ?? '').toLowerCase();

  /** Never stop on its own. */
  const never = () => ({ stop: false });

  /** Stop after `n` completed turns. */
  function maxTurns(n) {
    return (s) => (s.turnsCompleted >= n
      ? { stop: true, reason: `reached ${n} turns`, code: 'max-turns' }
      : { stop: false });
  }

  /** Stop when the newest reply ends with any of the given markers. */
  function sawText(...needles) {
    const list = needles.flat().map(norm).filter(Boolean);
    return (s) => {
      const hay = norm(s.tail);
      const hit = list.find((n) => hay.includes(n));
      return hit
        ? { stop: true, reason: `reply matched "${hit}"`, code: 'marker' }
        : { stop: false };
    };
  }

  /** Stop when a regex matches the newest reply's tail. */
  function sawPattern(re) {
    return (s) => (re.test(String(s.tail ?? ''))
      ? { stop: true, reason: `reply matched ${re}`, code: 'pattern' }
      : { stop: false });
  }

  /** Stop after N consecutive failed turns — the site is probably blocking us. */
  function tooManyErrors(n = 3) {
    return (s) => (s.consecutiveErrors >= n
      ? { stop: true, reason: `${n} consecutive errors`, code: 'errors' }
      : { stop: false });
  }

  /** Stop after a wall-clock budget, e.g. maxDuration(8 * 3600_000). */
  function maxDuration(ms) {
    return (s) => (s.now - s.startedAt >= ms
      ? { stop: true, reason: `ran for ${Math.round((s.now - s.startedAt) / 60000)} min`, code: 'duration' }
      : { stop: false });
  }

  /** Combine conditions: stop as soon as any of them fires. First match wins. */
  function anyOf(...conds) {
    const list = conds.flat().filter(Boolean);
    return (s) => {
      for (const c of list) {
        const r = c(s);
        if (r?.stop) return r;
      }
      return { stop: false };
    };
  }

  /** Guard rail: always stop if turns stop producing files for a long stretch. */
  function noArtifactsFor(n = 5) {
    return (s) => (s.turnsWithoutArtifacts >= n
      ? { stop: true, reason: `${n} turns produced no files`, code: 'dry' }
      : { stop: false });
  }
  function evaluateStop(cond, state) {
    if (typeof cond !== 'function') return { stop: false };
    try {
      const r = cond(state);
      return r && typeof r === 'object' ? r : { stop: false };
    } catch (err) {
      return { stop: true, reason: `stop condition threw: ${err.message}`, code: 'stop-error' };
    }
  }

  // ── core/session.js ─────────────────────────────
  /**
   * Session — the idempotent ask boundary.
   *
   * This is the one place that decides "have we already done this ask?" and, if so,
   * hands back the recorded result instead of sending again. It is deliberately free
   * of any Node built-in: the *journal* is injected, so a userscript can pass null and
   * get a session that always asks, while the CLI/GUI pass a real `Journal` and get
   * crash-safe replay.
   *
   *   const session = createSession({ journal });
   *   const { event, replayed } = await session.ask(12, '继续', doAsk);
   *   // replayed === true  -> doAsk was NOT called; `event` is the prior result
   *   // replayed === false -> doAsk ran; `event` is the freshly recorded result
   *
   * The seq is the idempotence key. "Idempotent" here means precisely: **a prompt is
   * sent at most once per seq**. If doAsk throws (send failed, or sent-but-harvest
   * failed), nothing is recorded, and the next run re-issues that seq — the correct
   * recovery, because the result of that ask was never captured.
   */
  function createSession({ journal = null, now = () => Date.now() } = {}) {
    return {
      /** Replayable clock. Work that stamps time must use this, not Date.now(). */
      now,

      /** Highest completed ask, or 0. The engine resumes at this + 1. */
      maxSeq: () => journal?.maxSeq?.() ?? 0,

      /** The recorded event for an ask, or null. */
      get: (seq) => journal?.get?.(seq) ?? null,

      /**
       * Run `doAsk` at most once for `seq`.
       *
       * @param {number} seq    1-based ask number
       * @param {string} prompt what is about to be sent (recorded verbatim)
       * @param {() => Promise<object>} doAsk  performs send→settle→harvest, returns
       *        { messageId, dur, text, blocks, files, artifacts, saved }
       * @returns {Promise<{ event: object, replayed: boolean }>}
       */
      async ask(seq, prompt, doAsk) {
        const cached = journal?.get?.(seq) ?? null;
        if (cached) return { event: cached, replayed: true };

        const {
          messageId = null,
          dur = null,
          text = '',
          blocks = [],
          files = [],
          artifacts = 0,
          saved = 0,
          ...rest
        } = await doAsk();

        const event = {
          v: 2,
          t: 'ask',
          seq,
          prompt,
          at: now(),
          messageId,
          dur,
          text,
          blocks,
          files,
          artifacts,
          saved,
          ...rest,
        };

        await journal?.append?.(event);
        return { event, replayed: false };
      },
    };
  }

  // ── core/engine.js ──────────────────────────────
  /**
   * The engine — the entire loop, and the only file that knows the order of things.
   *
   * It is transport-agnostic on purpose: it never touches the DOM, never opens a
   * socket, never calls fetch. It takes an *adapter* (page-side, site-specific) and a
   * *sink* (host-side, where files go) and drives them.
   *
   * Turn accounting is the subtle part, so it is defined here once:
   *
   *   A "turn" is one prompt that we sent **and** whose result we harvested.
   *   Therefore `turnsCompleted` after a run equals the number of prompts sent.
   *
   * The bootstrap step is deliberately outside that count. When you point the tool at
   * a conversation that is already open, whatever is already sitting in it gets saved
   * first — that is an adoption, not a turn, and counting it would make the next
   * prompt number off by one and silently skip a chapter.
   *
   *   bootstrap:  harvest what already exists (deduped by manifest)
   *   loop n:     prompt(n) -> send -> wait for settle -> harvest -> stop? -> pace
   *
   * Since 0.2.0 the loop also drives a *session* (see core/session.js). When a real
   * journal-backed session is supplied, each turn is idempotent by its seq: a restart
   * replays recorded turns instead of re-sending their prompts. When no session is
   * supplied (userscript path), the engine behaves exactly as it always did — it asks
   * every time. The session is injected, never imported, so `node:fs`-backed journals
   * never leak into the browser bundle.
   */



  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * @param {object} opts
   * @param {object} opts.adapter      page-side adapter (see protocol.js)
   * @param {object} opts.sink         { save(artifact) -> {path, bytes} }
   * @param {object} opts.recipe       { name, prompt(turn, state), stop }
   * @param {object} [opts.pacing]     { pollMs, settleMs, betweenTurnsMs, jitterMs, stallMs }
   * @param {object} [opts.manifest]   ManifestStore (or a compatible stub)
   * @param {object} [opts.session]    Session (see core/session.js); defaults to ask-always
   * @param {object} [opts.logger]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.maxTurns]   hard ceiling, independent of recipe.stop
   */
  async function runLoop({
    adapter,
    sink,
    recipe,
    pacing = {},
    manifest,
    session,
    logger = console,
    signal,
    maxTurns = 200,
  }) {
    const p = {
      pollMs: 2000,
      settleMs: 1200,
      betweenTurnsMs: 4000,
      jitterMs: 2500,
      stallMs: 15 * 60 * 1000,
      maxConsecutiveErrors: 3,
      ...pacing,
    };

    // The session is the ask gate. A null-journal session still asks every time, so
    // the userscript path is byte-for-byte the old behavior.
    session ??= createSession();
    const now = session.now.bind(session);

    const startedAt = Date.now();
    // Resuming starts from the manifest's position. The *journal* does not advance
    // this counter directly — instead the loop replays every recorded seq through
    // session.ask(), which returns the cached result without re-sending. That replay
    // is what re-syncs a manifest that fell behind the journal in a kill-window, and
    // it is O(1) per turn because a cached hit never touches the page.
    let turnsCompleted = manifest?.turnsCompleted ?? 0;
    let sendErrors = 0;
    let harvestErrors = 0;
    let lastHarvestError = null;
    let turnsWithoutArtifacts = 0;
    let artifactsThisRun = 0;
    let lastMessageId = manifest?.lastMessageId ?? null;
    let lastTail = '';
    const savedThisRun = [];

    const state = () => ({
      turn: turnsCompleted + 1,
      turnsCompleted,
      consecutiveErrors: Math.max(sendErrors, harvestErrors),
      turnsWithoutArtifacts,
      artifactsThisRun,
      startedAt,
      now: Date.now(),
      tail: lastTail,
    });

    const aborted = () => signal?.aborted === true;

    logger.info?.(`loop start · recipe=${recipe.name} · next turn=${turnsCompleted + 1}`);

    // ── bootstrap: adopt whatever the conversation already contains ─────────────
    try {
      const st = normalizeStatus(await waitForIdle({ adapter, pacing: p, signal }));
      lastTail = st.tail;
      lastMessageId = st.lastMessageId ?? lastMessageId;
      // Adopt only a turn the journal does *not* already cover. When the journal is
      // intact (e.g. the manifest was lost but the journal survived), the latest
      // message is already fully recorded and re-adopting it would re-save a file that
      // is already on disk — a duplicate. When the journal is empty (first run, or
      // userscript with no journal), adopt proceeds as it always has.
      const latest = session.get(session.maxSeq());
      const alreadyRecorded = latest && latest.messageId && latest.messageId === st.lastMessageId;
      if (st.lastMessageId && !alreadyRecorded) {
        const adopted = await adoptExisting({ adapter, sink, manifest, logger, messageId: st.lastMessageId });
        if (adopted.saved > 0) logger.info?.(`bootstrap: adopted ${adopted.saved} existing file(s)`);
      }
    } catch (err) {
      logger.warn?.(`bootstrap skipped — ${err.message}`);
    }

    for (let n = turnsCompleted + 1; n <= maxTurns; n++) {
      if (aborted()) return finish('aborted', 'abort signal');

      // ── 0. prompt ─────────────────────────────────────────────────────────────
      const prompt = typeof recipe.prompt === 'function'
        ? recipe.prompt(n, state())
        : String(recipe.prompt ?? 'continue');

      // ── 1. the turn, idempotent by seq ────────────────────────────────────────
      let event;
      let replayed;
      try {
        ({ event, replayed } = await session.ask(n, prompt, () => performTurn(n, prompt)));
      } catch (err) {
        if (aborted()) return finish('aborted', 'abort signal');
        // Only send/settle failures propagate here (harvest failures are absorbed
        // inside performTurn and recorded, so a restart never re-sends them).
        sendErrors += 1;
        logger.warn?.(`turn ${n}: ${err.message}`);
        if (sendErrors >= p.maxConsecutiveErrors) return finish('error', `send failed ${sendErrors}x: ${err.message}`);
        await sleep(p.betweenTurnsMs * 2);
        n -= 1;                                  // retry this turn number
        continue;
      }

      // ── 2. reconcile + bookkeeping (runs for fresh *and* replayed turns) ─────
      if (replayed) {
        // The kill-window between journal.append and manifest.save could leave the
        // manifest unaware of files that are already on disk. Re-sync it without
        // re-saving: the bytes are already where event.files says they are.
        for (const f of event.files ?? []) {
          if (f.id && !manifest?.has(f.id)) {
            manifest?.record({ id: f.id, name: f.name, path: f.path, bytes: f.bytes });
          }
        }
        logger.info?.(`turn ${n}: replayed from journal (${preview(prompt)})`);
      }

      lastMessageId = event.messageId ?? lastMessageId;
      lastTail = typeof event.tail === 'string' && event.tail
        ? event.tail
        : (typeof event.text === 'string' ? event.text.slice(-200) : '');
      turnsCompleted = n;
      manifest?.noteTurn({ lastMessageId });
      await manifest?.saveIfDirty();

      if (harvestErrors >= p.maxConsecutiveErrors) {
        return finish('error', `harvest failed ${harvestErrors}x: ${lastHarvestError ?? ''}`);
      }

      // ── 3. stop conditions ────────────────────────────────────────────────────
      const stop = evaluateStop(recipe.stop, state());
      if (stop.stop) return finish('stopped', stop.reason, stop.code);

      if (aborted()) return finish('aborted', 'abort signal');

      // ── 4. pacing ─────────────────────────────────────────────────────────────
      const delay = p.betweenTurnsMs + Math.floor(Math.random() * p.jitterMs);
      logger.info?.(`  waiting ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }

    return finish('stopped', `hit hard ceiling of ${maxTurns} turns`, 'max-turns');

    // ── helpers ─────────────────────────────────────────────────────────────────

    /**
     * Do one real turn: send, settle, harvest, persist. Returns the fields the
     * session records. Throws on send/settle failure (the caller retries the seq);
     * absorbs harvest failure (records text-less, files-less) so a restart skips
     * the turn instead of re-spending quota on it.
     */
    async function performTurn(n, prompt) {
      // Never send into a page that is still producing; that is how two prompts
      // end up merged into one turn.
      await waitForIdle({ adapter, pacing: p, signal });
      const sendStartedAt = now();
      await adapter.send(prompt);
      sendErrors = 0;
      logger.info?.(`turn ${n}: sent — ${preview(prompt)}`);

      const st = normalizeStatus(await waitForIdle({ adapter, pacing: p, signal, logger }));
      lastTail = st.tail;

      let text = '';
      let blocks = [];
      let artifacts = [];
      let saved = 0;
      const files = [];
      try {
        ({ text, blocks, artifacts } = normalizeHarvest(await adapter.harvest({ messageId: st.lastMessageId })));
        for (const art of artifacts) {
          if (manifest?.has(art.id)) continue;
          const res = await sink.save(art);
          manifest?.record({ ...art, path: res.path, bytes: res.bytes });
          saved += 1;
          files.push({ id: art.id, name: art.name, path: res.path, bytes: res.bytes });
          savedThisRun.push({ name: art.name, path: res.path, bytes: res.bytes });
          logger.info?.(`  saved ${art.name} (${res.bytes} B) -> ${res.path}`);
        }
        harvestErrors = 0;
      } catch (err) {
        harvestErrors += 1;
        lastHarvestError = err.message;
        logger.warn?.(`turn ${n}: harvest failed — ${err.message}`);
      }
      artifactsThisRun += saved;
      turnsWithoutArtifacts = saved > 0 ? 0 : turnsWithoutArtifacts + 1;
      logger.turn?.(n, { status: st, saved, artifacts: artifacts.length });

      return {
        messageId: st.lastMessageId ?? null,
        dur: now() - sendStartedAt,
        tail: st.tail,
        text,
        blocks,
        files,
        artifacts: artifacts.length,
        saved,
      };
    }

    /** Adopt a turn that already finished before we started (no send, no journal). */
    async function adoptExisting({ adapter: a, sink: s, manifest: m, logger: lg, messageId }) {
      const { artifacts } = normalizeHarvest(await a.harvest({ messageId }));
      let saved = 0;
      for (const art of artifacts) {
        if (m?.has(art.id)) continue;
        const res = await s.save(art);
        m?.record({ ...art, path: res.path, bytes: res.bytes });
        saved += 1;
        lg.info?.(`  saved ${art.name} (${res.bytes} B) -> ${res.path}`);
      }
      return { found: artifacts.length, saved };
    }

    function finish(code, reason, stopCode) {
      logger.info?.(`loop end · ${code} · ${reason ?? ''}`);
      return {
        code,
        stopCode: stopCode ?? code,
        reason: reason ?? null,
        turnsCompleted,
        artifactsThisRun,
        saved: savedThisRun,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Block until the page reports a settled turn.
   *
   * "Settled" means: idle, and observed idle for `settleMs`. That observation window
   * is not padding — sites flicker to idle between the thinking phase and the writing
   * phase, and sending during that flicker is exactly how one prompt gets split into
   * two, or two get merged into one.
   */
  async function waitForIdle({ adapter, pacing, signal, logger }) {
    const deadline = Date.now() + pacing.stallMs;
    let sawRunning = false;
    let idleSince = 0;
    let polls = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted');
      const st = normalizeStatus(await adapter.status({}));
      if (st.error && st.phase === 'idle') throw new Error(st.error);
      polls += 1;
      // A turn can take minutes. Without this the caller has no idea whether the
      // model is thinking, writing, or wedged — which is the whole point of a HUD.
      logger?.poll?.(st, { polls, elapsedMs: Date.now() - deadline + pacing.stallMs });

      if (st.phase === 'running' || st.phase === 'stalled') {
        sawRunning = true;
        idleSince = 0;
      } else if (!sawRunning) {
        return st;                                  // nothing was ever running
      } else {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= pacing.settleMs) return st;
      }

      await sleep(pacing.pollMs);
    }
    throw new Error(`page stayed busy for over ${Math.round(pacing.stallMs / 60000)} min (${polls} polls)`);
  }

  function preview(s) {
    const one = String(s).replace(/\s+/g, ' ').trim();
    return one.length > 70 ? `${one.slice(0, 70)}…` : one;
  }

  // ── core/adapters/chatgpt.js ────────────────────
  /**
   * chatgpt adapter — v1
   *
   * Everything site-specific about ChatGPT in one file. It runs **inside the page**, so
   * it inherits the user's real session and can use the site's own private endpoints.
   *
   * Why private endpoints instead of the DOM for reads and downloads:
   *   • The message list is virtualised — older turns scroll out of existence, so
   *     hunting for "download" buttons silently misses everything above the fold.
   *   • The download button is a two-hop signed-URL fetch. Calling the first hop
   *     ourselves yields a `download_url` whose bytes we can hold, verify and write,
   *     instead of a browser download we cannot observe.
   *   • Message identity and completion status are already in the API payload, so
   *     "is it still typing?" never has to be inferred from pixels.
   *
   * ⚠ SELF-CONTAINMENT REQUIREMENT
   *   The CLI serialises this factory with `Function.prototype.toString()` and injects
   *   it into the page. Therefore it must not close over module scope: every constant
   *   and helper lives *inside* the function body. If you move something out, the CLI
   *   path breaks while the userscript path keeps working — the worst kind of bug.
   *
   * Measured against Edge 157 / ChatGPT 2026-11. When the site changes, only this
   * file needs fixing; the engine, sinks and recipes stay untouched.
   */
  function createChatGptAdapter(options) {
    // ── constants (inside on purpose, see SELF-CONTAINMENT above) ──────────────
    const OPTS = options || {};
    const LOGGER = OPTS.logger || (typeof console !== 'undefined' ? console : { info() {}, warn() {} });
    const PROTOCOL_VERSION = 1;

    /**
     * How to hand bytes back.
     *
     * "typed"  → a real Uint8Array (userscript: the sink writes a Blob directly)
     * "base64" → a JSON-safe string (CLI: the value crosses a CDP boundary, and a
     *            Uint8Array degrades to `{"0":1,"1":2,...}` there — huge and lossy)
     */
    const BYTES_MODE = OPTS.serializeBytes === 'base64' ? 'base64' : 'typed';

    function toBase64(bytes) {
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(s);
    }


    const API = {
      session: '/api/auth/session',
      conversation: (id) => '/backend-api/conversation/' + id,
      interpreterDownload: (convId, messageId, sandboxPath) =>
        '/backend-api/conversation/' + convId + '/interpreter/download'
        + '?download_intent=true'
        + '&message_id=' + encodeURIComponent(messageId)
        + '&sandbox_path=' + encodeURIComponent(sandboxPath),
    };

    /** Localised aria-labels accepted as "the send button". */
    const SEND_LABELS = /^(send|发送|送信|보내기|enviar|envoyer|senden)$/i;
    const STOP_LABELS = /^(stop|停止|停止生成|停止响应|中止|中断)/i;
    const SANDBOX_LINK = /\[([^\]]*)\]\(sandbox:([^)]+)\)/g;

    let cachedToken = null;
    let cachedTokenExpiry = 0;

    // ── helpers ────────────────────────────────────────────────────────────────

    function conversationId() {
      const g = location.pathname.match(/\/g\/[^/]+\/c\/([0-9a-f-]{16,})/i);
      if (g) return g[1];
      const m = location.pathname.match(/\/c\/([0-9a-f-]{16,})/i);
      return m ? m[1] : null;
    }

    async function authToken() {
      const now = Date.now();
      if (cachedToken && now < cachedTokenExpiry - 60_000) return cachedToken;
      const s = await fetch(API.session, { credentials: 'include' }).then((r) => r.json());
      if (!s || !s.accessToken) {
        throw new Error('not signed in — /api/auth/session returned no accessToken');
      }
      cachedToken = s.accessToken;
      cachedTokenExpiry = s.expires ? Date.parse(s.expires) : now + 10 * 60_000;
      return cachedToken;
    }

    async function apiGet(url) {
      const token = await authToken();
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        credentials: 'include',
      });
      if (!r.ok) throw new Error('GET ' + url.split('?')[0] + ' -> HTTP ' + r.status);
      return r;
    }

    function composer() {
      return document.querySelector('div.ProseMirror[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"]');
    }

    function findButton(re) {
      const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      // Exact aria-label first, then data-testid, so a stray "Stop generating" in the
      // sidebar can never shadow the composer's own button.
      const byAria = btns.filter((b) => re.test((b.getAttribute('aria-label') || '').trim()));
      const visible = byAria.filter((b) => b.offsetParent !== null);
      if (visible.length) return visible[0];
      if (byAria.length) return byAria[0];
      return btns.find((b) => re.test(b.getAttribute('data-testid') || '')) || null;
    }

    function isStreaming() {
      const stop = findButton(STOP_LABELS);
      if (stop && !stop.disabled && stop.offsetParent !== null) return true;
      const c = composer();
      if (c && c.getAttribute('contenteditable') === 'false') return true;
      return false;
    }

    function textOf(message) {
      const parts = (message && message.content && message.content.parts) || [];
      return parts.map((p) => (typeof p === 'string' ? p : '')).join('');
    }

    // ── adapter ────────────────────────────────────────────────────────────────

    return {
      id: 'chatgpt',
      displayName: 'ChatGPT',
      protocolVersion: PROTOCOL_VERSION,

      probe() {
        const id = conversationId();
        const box = composer();
        // A brand-new chat lives at /?model=... and has no id yet — the id appears in
        // the URL only after the first message is sent. Requiring it here would make
        // the tool unable to start a fresh conversation, which is the common case.
        return {
          ok: Boolean(box) && /(^|\.)chatgpt\.com$/.test(location.host),
          site: 'chatgpt',
          conversationId: id,
          isNewChat: !id,
          url: location.href,
          title: document.title,
        };
      },

      async send(text) {
        const box = composer();
        if (!box) throw new Error('composer not found — is the chat fully loaded?');
        if (isStreaming()) throw new Error('a turn is still running; refusing to queue another prompt');

        box.focus();
        // Replace the contents through the native input path. execCommand keeps
        // ProseMirror's internal document in sync; writing innerHTML does not, and the
        // site then submits an empty message.
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        document.execCommand('insertText', false, text);

        // The send button is rendered by React only after the first character lands.
        // Measured on Edge 157 / ChatGPT 2026-11: ~600 ms. Poll instead of guessing.
        const deadline = Date.now() + 4000;
        let btn = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          const typed = (box.innerText || '').trim();
          if (!typed) throw new Error('composer stayed empty after typing');
          btn = findButton(SEND_LABELS);
          if (btn && !btn.disabled) break;
          btn = null;
        }

        if (btn) {
          btn.click();
        } else {
          // Fallback for localised builds whose label is not in SEND_LABELS.
          box.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          }));
        }

        // Confirm the turn actually started: a click that misses leaves the text in
        // place, and retrying then would double-send. Verify the composer drained.
        const confirmBy = Date.now() + 3000;
        let drained = false;
        while (Date.now() < confirmBy) {
          await new Promise((r) => setTimeout(r, 100));
          if ((box.innerText || '').trim().length === 0) { drained = true; break; }
        }
        if (!drained) throw new Error('send did not take — composer still holds the text');

        // A fresh chat only gains its conversation id after the server accepts the
        // message. Wait for the turn to visibly start (id in URL, or streaming), so
        // the caller's first status() cannot mistake "not started yet" for "settled".
        const startBy = Date.now() + 5000;
        while (Date.now() < startBy) {
          if (conversationId() || isStreaming()) break;
          await new Promise((r) => setTimeout(r, 120));
        }

        return { ok: true, typed: text.length, via: btn ? 'button' : 'enter' };
      },

      async status() {
        // A brand-new chat has no id in the URL until the first message is accepted,
        // and the id appears a few hundred ms after sending. Returning "idle" during
        // that window would make the engine think the turn already settled, harvest
        // would fail, and the retry would send the prompt a second time. So: wait
        // briefly for the id, then decide.
        let id = conversationId();
        if (!id) {
          const deadline = Date.now() + (isStreaming() ? 4000 : 1200);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 120));
            id = conversationId();
            if (id) break;
          }
        }

        if (isStreaming()) {
          return { phase: 'running', lastMessageId: null, lastMessageAt: Date.now(), model: null, textLength: 0, tail: '' };
        }

        if (!id) {
          // Still a fresh, empty chat: nothing has been sent, nothing to harvest.
          return { phase: 'idle', lastMessageId: null, lastMessageAt: null, model: null, textLength: 0, tail: '' };
        }

        // Settled, or never started. Ask the API which message is current so the engine
        // can tell "same turn seen twice" apart from "a new turn arrived".
        const r = await apiGet(API.conversation(id));
        const j = await r.json();
        const node = j.mapping && j.mapping[j.current_node];
        const msg = node && node.message;
        if (!msg) {
          return { phase: 'idle', lastMessageId: null, lastMessageAt: null, model: null, textLength: 0, tail: '' };
        }
        const text = textOf(msg);
        const finished = msg.status === 'finished_successfully';
        return {
          phase: finished ? 'idle' : 'running',
          lastMessageId: msg.id || j.current_node || null,
          lastMessageAt: msg.create_time ? msg.create_time * 1000 : null,
          model: (msg.metadata && msg.metadata.model_slug) || null,
          textLength: text.length,
          tail: text.slice(-200),
          error: finished ? undefined : 'message status=' + msg.status,
        };
      },

      async harvest(args) {
        const a = args || {};
        const convId = conversationId();
        if (!convId) throw new Error('no conversation id in URL');

        const r = await apiGet(API.conversation(convId));
        const j = await r.json();
        const targetId = a.messageId || j.current_node;
        const node = j.mapping && j.mapping[targetId];
        const msg = node && node.message;
        if (!msg) throw new Error('message ' + targetId + ' not found in conversation');

        const text = textOf(msg);
        const blocks = (msg.content && msg.content.parts)
          ? msg.content.parts.map((p, i) => ({ i, text: typeof p === 'string' ? p : '' })).filter((b) => b.text.length)
          : [];

        // sandbox links are the only reliable pointer to generated files: the artifact
        // cards in the DOM are rendered from exactly these markdown links.
        const refs = [];
        let m;
        SANDBOX_LINK.lastIndex = 0;
        while ((m = SANDBOX_LINK.exec(text)) !== null) {
          refs.push({ label: m[1], sandboxPath: decodeURIComponent(m[2]) });
        }
        if (!refs.length) return { text, blocks, artifacts: [] };

        const out = [];
        for (const ref of refs) {
          const metaRes = await apiGet(API.interpreterDownload(convId, msg.id, ref.sandboxPath));
          const meta = await metaRes.json();
          if (!meta || !meta.download_url) {
            LOGGER.warn('no download_url for ' + ref.sandboxPath);
            continue;
          }
          const fileRes = await apiGet(meta.download_url);
          const bytes = new Uint8Array(await fileRes.arrayBuffer());
          out.push({
            // file_id is stable across re-renders; the sandbox path covers the (rare)
            // case where the API omits it.
            id: (meta.metadata && meta.metadata.file_id) || (msg.id + ':' + ref.sandboxPath),
            name: meta.file_name || ref.sandboxPath.split('/').pop(),
            mime: meta.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream',
            bytes: BYTES_MODE === 'base64' ? toBase64(bytes) : bytes,
            byteLength: bytes.length,
            bytesEncoding: BYTES_MODE,
            messageId: msg.id,
            source: 'sandbox:' + ref.sandboxPath,
          });
        }
        return { text, blocks, artifacts: out };
      },
    };
  }
  createChatGptAdapter;

  // ── core/sinks.js ───────────────────────────────
  /**
   * Browser-side sinks. No Node built-ins may be imported from this file — it is
   * bundled into the userscript, where `node:fs` does not exist.
   *
   * Two ship in the box: `downloadSink` (routes through the browser's download
   * manager) and `memorySink` (for dry runs and tests). The engine never knows which
   * one it got.
   */

  /**
   * Hand the bytes to the browser's download manager.
   *
   * Browsers rate-limit programmatic downloads — Chrome/Edge ask "allow multiple
   * downloads?" the first time. That prompt is unavoidable from a userscript, so it
   * is documented rather than worked around.
   */
  function createDownloadSink({ subdir = 'loopcrop', logger = console } = {}) {
    return {
      kind: 'download',
      async save(artifact) {
        const label = `${subdir}/${artifact.name}`.replace(/\/+/g, '/');
        const blob = new Blob([artifact.bytes], { type: artifact.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = artifact.name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the download manager time to start before the blob is revoked.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        logger.info?.(`download started: ${label} (${artifact.bytes.length} B)`);
        return { path: label, bytes: artifact.bytes.length };
      },
    };
  }

  /** Sink that remembers instead of writing — for dry runs and tests. */
  function createMemorySink() {
    const files = [];
    return {
      kind: 'memory',
      files,
      async save(artifact) {
        files.push({ name: artifact.name, bytes: artifact.bytes.length });
        return { path: `memory://${artifact.name}`, bytes: artifact.bytes.length };
      },
    };
  }

  // ── core/recipes/index.js ───────────────────────
  /**
   * Recipes bundle the three things a user actually cares about: what to say each
   * turn, when to stop, and where the output goes. They are plain data, so a recipe
   * can be written in a README and pasted into a config.
   */

  // sawPattern is re-exported for recipe authors building their own stop set.
  { sawPattern };

  /**
   * A prompt may be a string or a function of (turn, state). Returning a function is
   * how a recipe injects the chapter number without the user re-typing it every turn.
   */
  const recipeSchema = {
    name: 'string — shown in logs and the manifest',
    prompt: 'string | (turn, state) => string',
    stop: 'stop condition (see core/stops.js)',
    outDir: 'string — where the sink writes',
  };

  const normalize = (r) => ({
    name: r.name ?? 'unnamed',
    prompt: r.prompt ?? 'continue',
    stop: r.stop ?? neverStop,
    outDir: r.outDir ?? './out',
    pollMs: r.pollMs,
    betweenTurnsMs: r.betweenTurnsMs,
    stallMs: r.stallMs,
    description: r.description ?? '',
  });

  const neverStop = () => ({ stop: false });

  // ── Built-in recipes ───────────────────────────────────────────────────────────

  /**
   * Serialized long-form writing. One turn = one chapter.
   *
   * The prompt is deliberately as short as possible: "继续". In a conversation that
   * already knows what it is doing, every extra word is a chance to confuse it — and
   * a chapter number typed by the tool is a chapter number that can drift out of sync
   * with the book. The model owns the numbering; the tool just keeps the loop running
   * and harvests the files.
   */
  const novel = (opts = {}) => normalize({
    name: 'novel',
    description: 'Long-form serialized writing: one chapter per turn, files harvested each round.',
    outDir: opts.outDir ?? './chapters',
    prompt: opts.prompt ?? '继续',
    stop: opts.stop ?? anyOf(
      sawText('全书完', '全文完', '【完结】'),
      tooManyErrors(3),
      noArtifactsFor(5),
      opts.maxTurns ? maxTurns(opts.maxTurns) : null,
    ),
  });

  /** Batch translation: same instruction each turn, driven by the source files. */
  const translate = (opts = {}) => normalize({
    name: 'translate',
    description: 'Batch translation of the files the model produced last turn.',
    outDir: opts.outDir ?? './translated',
    prompt: opts.prompt ?? '把上一轮的文件翻译成中文，保存成新文件，文件名保持不变但加 _zh 后缀。',
    stop: opts.stop ?? anyOf(tooManyErrors(3), noArtifactsFor(3), opts.maxTurns ? maxTurns(opts.maxTurns) : null),
  });

  /** Do the same thing N times, no per-turn adaptation. */
  const repeat = (prompt, opts = {}) => normalize({
    name: opts.name ?? 'repeat',
    description: 'Repeat one instruction a fixed number of times.',
    outDir: opts.outDir ?? './out',
    prompt,
    stop: anyOf(maxTurns(opts.times ?? 10), tooManyErrors(3)),
  });

  /** Escape hatch: bring your own prompt/stop/outDir. */
  const custom = (opts) => normalize(opts);
  const builtins = { novel, translate, repeat, custom };

  /** Resolve `--recipe novel` / `--recipe ./my-recipe.mjs` / inline JSON. */
  async function resolveRecipe(spec, opts = {}) {
    if (spec && typeof spec === 'object') return normalize(spec);
    const name = String(spec ?? 'repeat');
    if (builtins[name]) return builtins[name](opts);
    if (/\.(mjs|js|json)$/i.test(name)) {
      const mod = await import(new URL(name, `file://${process.cwd()}/`).href);
      return normalize(mod.default ?? mod);
    }
    if (name.trim().startsWith('{')) return normalize(JSON.parse(name));
    throw new Error(`unknown recipe "${name}". built-ins: ${Object.keys(builtins).join(', ')}`);
  }

  // ── userscript/manifest-lite.js ─────────────────
  /**
   * Browser-side manifest.
   *
   * The CLI writes a manifest.json next to the files, because a crashed run has to be
   * resumable. A userscript cannot write arbitrary JSON to disk, so it keeps the same
   * shape in GM storage instead — enough to survive a page reload mid-run.
   */
  function createInMemoryManifest() {
    const KEY = 'loopcrop:manifest';
    const load = () => {
      try {
        return typeof GM_getValue === 'function' ? (GM_getValue(KEY, null) ?? null) : null;
      } catch { return null; }
    };
    const persist = () => {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(KEY, data);
      } catch { /* storage may be full or disabled; the loop still works this session */ }
    };

    let data = load() ?? {
      version: 1,
      turnsCompleted: 0,
      lastMessageId: null,
      seenIds: [],
      artifacts: [],
    };
    const seen = new Set(data.seenIds ?? []);

    return {
      get data() { return data; },
      get turnsCompleted() { return data.turnsCompleted ?? 0; },
      get lastMessageId() { return data.lastMessageId ?? null; },
      get artifactCount() { return seen.size; },
      has: (id) => seen.has(String(id)),
      record(artifact) {
        const id = String(artifact.id);
        if (seen.has(id)) return false;
        seen.add(id);
        data.seenIds.push(id);
        data.artifacts.push({ id, name: artifact.name, bytes: artifact.bytes, savedAt: new Date().toISOString() });
        persist();
        return true;
      },
      noteTurn({ lastMessageId, error = null } = {}) {
        data.turnsCompleted = (data.turnsCompleted ?? 0) + 1;
        if (lastMessageId) data.lastMessageId = lastMessageId;
        data.lastError = error;
        persist();
      },
      async save() { persist(); },
      async saveIfDirty() { persist(); },
    };
  }

  // ── userscript/hud.js ───────────────────────────
  /** Floating panel: start/stop, live status, and a tail of the log. */

  const CSS = `
  #loopcrop-hud { position: fixed; right: 16px; bottom: 16px; width: 320px; z-index: 2147483000;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e6e6e6;
    background: #16181d; border: 1px solid #2c3038; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
  #loopcrop-hud[hidden] { display: none; }
  #loopcrop-hud .pl-head { display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; background: #1d2027; border-bottom: 1px solid #2c3038; cursor: move; }
  #loopcrop-hud .pl-title { flex: 1; font-weight: 600; letter-spacing: .02em; }
  #loopcrop-hud .pl-dot { width: 8px; height: 8px; border-radius: 50%; background: #4b5563; }
  #loopcrop-hud.running .pl-dot { background: #22c55e; animation: pl-pulse 1.4s ease-in-out infinite; }
  #loopcrop-hud.error .pl-dot { background: #ef4444; }
  @keyframes pl-pulse { 50% { opacity: .35; } }
  #loopcrop-hud .pl-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
  #loopcrop-hud .pl-row { display: flex; gap: 6px; }
  #loopcrop-hud button { flex: 1; padding: 6px 8px; border-radius: 6px; cursor: pointer;
    border: 1px solid #343945; background: #23272f; color: #e6e6e6; font: inherit; }
  #loopcrop-hud button:hover:not(:disabled) { background: #2b3038; }
  #loopcrop-hud button:disabled { opacity: .4; cursor: default; }
  #loopcrop-hud button.primary { background: #1f6feb; border-color: #1f6feb; }
  #loopcrop-hud button.primary:hover:not(:disabled) { background: #2b7bf3; }
  #loopcrop-hud .pl-log { height: 132px; overflow-y: auto; padding: 6px 8px; border-radius: 6px;
    background: #0f1115; border: 1px solid #23272f; white-space: pre-wrap; word-break: break-all; }
  #loopcrop-hud .pl-log .warn { color: #f5c451; }
  #loopcrop-hud .pl-log .error { color: #f87171; }
  #loopcrop-hud .pl-log .dim { color: #7d8590; }
  #loopcrop-hud .pl-status { color: #9aa4b2; }
  `;
  function createHud({ onStart, onStop }) {
    let root, logEl, statusEl, startBtn, stopBtn;
    const lines = [];

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    function build() {
      if (root) return;
      const style = el('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      root = el('div');
      root.id = 'loopcrop-hud';

      const head = el('div', 'pl-head');
      head.append(el('span', 'pl-dot'), el('span', 'pl-title', 'loopcrop'),
        (() => { const b = el('button', '', '×'); b.style.flex = '0 0 auto';
          b.style.padding = '0 6px'; b.onclick = () => show(false); return b; })());

      const body = el('div', 'pl-body');
      statusEl = el('div', 'pl-status', 'idle');
      logEl = el('div', 'pl-log');

      const row = el('div', 'pl-row');
      startBtn = el('button', 'primary', 'Start');
      stopBtn = el('button', '', 'Stop');
      stopBtn.disabled = true;
      startBtn.onclick = () => { onStart(); };
      stopBtn.onclick = () => { onStop(); };
      row.append(startBtn, stopBtn);

      body.append(statusEl, row, logEl);
      root.append(head, body);
      document.body.appendChild(root);

      makeDraggable(root, head);
    }

    function setState(state, text) {
      build();
      root.classList.toggle('running', state === 'running');
      root.classList.toggle('error', state === 'error');
      if (text) statusEl.textContent = text;
      startBtn.disabled = state === 'running';
      stopBtn.disabled = state !== 'running';
      if (state === 'running') statusEl.textContent = 'running…';
      if (state === 'idle') statusEl.textContent = 'idle';
    }

    function log(level, msg) {
      build();
      const cls = level === 'warn' ? 'warn' : level === 'error' ? 'error' : '';
      const line = el('div', cls, `${new Date().toTimeString().slice(0, 8)}  ${msg}`);
      logEl.appendChild(line);
      lines.push(line);
      while (lines.length > 200) lines.shift().remove();
      logEl.scrollTop = logEl.scrollHeight;
    }

    function finish(result) {
      setState(result.code === 'error' ? 'error' : 'idle');
      statusEl.textContent = `${result.code} · ${result.turnsCompleted} turns · ${result.artifactsThisRun} files`;
    }

    function error(msg) {
      setState('error', `error: ${msg}`);
      log('error', msg);
    }

    function show(visible) {
      if (visible) build();
      if (root) root.hidden = !visible;
    }

    return { setState, log, finish, error, show };
  }

  function makeDraggable(root, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = `${ox}px`; root.style.top = `${oy}px`;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      root.style.left = `${ox + e.clientX - sx}px`;
      root.style.top = `${oy + e.clientY - sy}px`;
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
  }

  // ── userscript/config.js ────────────────────────
  /**
   * Config for the userscript front-end: defaults, then whatever the user stored via
   * GM_setValue, then anything in the URL hash (handy for one-off runs).
   */

  const DEFAULTS = {
    recipe: 'novel',
    outDir: './chapters',
    subdir: 'loopcrop',
    maxTurns: 40,
    pollMs: 2500,
    betweenTurnsMs: 5000,
    jitterMs: 3000,
    stallMin: 20,
  };
  async function loadConfig() {
    const stored = readStored();
    const fromHash = readHash();
    return { ...DEFAULTS, ...stored, ...fromHash };
  }

  function readStored() {
    try {
      if (typeof GM_getValue !== 'function') return {};
      return JSON.parse(GM_getValue('loopcrop:config', '{}')) ?? {};
    } catch { return {}; }
  }
  function saveConfig(patch) {
    try {
      if (typeof GM_setValue !== 'function') return;
      const cur = readStored();
      GM_setValue('loopcrop:config', JSON.stringify({ ...cur, ...patch }));
    } catch { /* ignore unavailable storage */ }
  }

  function readHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h.includes('loopcrop')) return {};
    const out = {};
    for (const part of h.split('&')) {
      const [k, v] = part.split('=');
      if (!k || v === undefined) continue;
      if (k.startsWith('pl.')) out[k.slice(3)] = /^\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }

  // ── userscript/entry.js ─────────────────────────
  /**
   * userscript front-end — the same engine, running inside the tab you already have.
   *
   * This is the zero-install path: paste one file into Tampermonkey/Violentmonkey
   * and you get the loop with no Node, no CLI, no extension bridge. It reaches the
   * engine through the adapter protocol and the browser sink.
   */







  function startLoopCrop() {
    const adapter = createChatGptAdapter({ logger: createConsoleShim() });
    const probe = adapter.probe();
    if (!probe.ok) return;                     // not a conversation page, stay quiet

    const hud = createHud({ onStart, onStop });
    let controller = null;
    let running = false;

    async function onStart() {
      if (running) return;
      const cfg = await loadConfig();
      running = true;
      controller = new AbortController();
      hud.setState('running');

      try {
        const recipe = await resolveRecipe(cfg.recipe, { outDir: cfg.outDir, maxTurns: cfg.maxTurns });
        const manifest = createInMemoryManifest();

        const result = await runLoop({
          adapter,
          sink: createDownloadSink({ subdir: cfg.subdir, logger: createConsoleShim(hud) }),
          recipe,
          manifest,
          logger: createConsoleShim(hud),
          signal: controller.signal,
          maxTurns: cfg.maxTurns,
          pacing: {
            pollMs: cfg.pollMs,
            betweenTurnsMs: cfg.betweenTurnsMs,
            jitterMs: cfg.jitterMs,
            stallMs: cfg.stallMin * 60_000,
          },
        });

        hud.finish(result);
      } catch (err) {
        hud.error(err.message);
      } finally {
        running = false;
        controller = null;
      }
    }

    function onStop() {
      controller?.abort();
    }

    // One convenient entry point from the userscript manager's menu.
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('loopcrop: start loop', onStart);
      GM_registerMenuCommand('loopcrop: stop loop', onStop);
      GM_registerMenuCommand('loopcrop: show panel', () => hud.show(true));
    }

    hud.show(true);
  }

  /** Route engine logs into both the page console and the floating panel. */
  function createConsoleShim(hud) {
    const line = (level, msg) => {
      (console[level] ?? console.log)(`[loopcrop] ${msg}`);
      hud?.log?.(level, msg);
    };
    return {
      info: (m) => line('log', m),
      warn: (m) => line('warn', m),
      error: (m) => line('error', m),
      turn: (n, info) => line('log', `turn ${n} settled · ${info.saved} new file(s) of ${info.artifacts} seen`),
    };
  }
  { startLoopCrop };


  // ── bootstrap ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startLoopCrop());
  } else {
    startLoopCrop();
  }
})();
