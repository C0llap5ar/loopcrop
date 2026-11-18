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

import { normalizeStatus, normalizeHarvest } from './protocol.js';
import { evaluateStop } from './stops.js';
import { createSession } from './session.js';

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
export async function runLoop({
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
