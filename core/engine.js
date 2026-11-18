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
 */

import { normalizeStatus, normalizeArtifacts } from './protocol.js';
import { evaluateStop } from './stops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {object} opts.adapter      page-side adapter (see protocol.js)
 * @param {object} opts.sink         { save(artifact) -> {path, bytes} }
 * @param {object} opts.recipe       { name, prompt(turn, state), stop }
 * @param {object} [opts.pacing]     { pollMs, settleMs, betweenTurnsMs, jitterMs, stallMs }
 * @param {object} [opts.manifest]   ManifestStore (or a compatible stub)
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

  const startedAt = Date.now();
  let turnsCompleted = manifest?.turnsCompleted ?? 0;
  let sendErrors = 0;
  let harvestErrors = 0;
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
    if (st.lastMessageId) {
      const adopted = await harvestInto({ adapter, sink, manifest, logger, messageId: st.lastMessageId, savedThisRun });
      if (adopted.saved > 0) logger.info?.(`bootstrap: adopted ${adopted.saved} existing file(s)`);
    }
  } catch (err) {
    logger.warn?.(`bootstrap skipped — ${err.message}`);
  }

  for (let n = turnsCompleted + 1; n <= maxTurns; n++) {
    if (aborted()) return finish('aborted', 'abort signal');

    // ── 1. send ───────────────────────────────────────────────────────────────
    const prompt = typeof recipe.prompt === 'function'
      ? recipe.prompt(n, state())
      : String(recipe.prompt ?? 'continue');

    try {
      // Never send into a page that is still producing; that is how two prompts
      // end up merged into one turn.
      await waitForIdle({ adapter, pacing: p, signal });
      await adapter.send(prompt);
      sendErrors = 0;
      logger.info?.(`turn ${n}: sent — ${preview(prompt)}`);
    } catch (err) {
      if (aborted()) return finish('aborted', 'abort signal');
      sendErrors += 1;
      logger.warn?.(`turn ${n}: send failed — ${err.message}`);
      if (sendErrors >= p.maxConsecutiveErrors) return finish('error', `send failed ${sendErrors}x: ${err.message}`);
      await sleep(p.betweenTurnsMs * 2);
      n -= 1;                                  // retry this turn number
      continue;
    }

    // ── 2. wait for the turn to settle ────────────────────────────────────────
    let st;
    try {
      st = normalizeStatus(await waitForIdle({ adapter, pacing: p, signal, logger }));
    } catch (err) {
      sendErrors += 1;
      logger.warn?.(`turn ${n}: never settled — ${err.message}`);
      if (sendErrors >= p.maxConsecutiveErrors) return finish('error', err.message);
      n -= 1;
      continue;
    }
    lastTail = st.tail;

    // ── 3. harvest ────────────────────────────────────────────────────────────
    try {
      const res = await harvestInto({
        adapter, sink, manifest, logger, messageId: st.lastMessageId, savedThisRun,
      });
      artifactsThisRun += res.saved;
      turnsWithoutArtifacts = res.saved > 0 ? 0 : turnsWithoutArtifacts + 1;
      harvestErrors = 0;
      logger.turn?.(n, { status: st, saved: res.saved, artifacts: res.found });
    } catch (err) {
      harvestErrors += 1;
      logger.warn?.(`turn ${n}: harvest failed — ${err.message}`);
      if (harvestErrors >= p.maxConsecutiveErrors) {
        return finish('error', `harvest failed ${harvestErrors}x: ${err.message}`);
      }
    }

    // ── 4. bookkeeping ────────────────────────────────────────────────────────
    lastMessageId = st.lastMessageId ?? lastMessageId;
    turnsCompleted = n;
    manifest?.noteTurn({ lastMessageId });
    await manifest?.saveIfDirty();

    // ── 5. stop conditions ────────────────────────────────────────────────────
    const stop = evaluateStop(recipe.stop, state());
    if (stop.stop) return finish('stopped', stop.reason, stop.code);

    if (aborted()) return finish('aborted', 'abort signal');

    // ── 6. pacing ─────────────────────────────────────────────────────────────
    const delay = p.betweenTurnsMs + Math.floor(Math.random() * p.jitterMs);
    logger.info?.(`  waiting ${(delay / 1000).toFixed(1)}s`);
    await sleep(delay);
  }

  return finish('stopped', `hit hard ceiling of ${maxTurns} turns`, 'max-turns');

  // ── helpers ─────────────────────────────────────────────────────────────────

  async function harvestInto({ adapter: a, sink: s, manifest: m, logger: lg, messageId, savedThisRun: acc }) {
    const raw = await a.harvest({ messageId });
    const artifacts = normalizeArtifacts(raw);
    let saved = 0;
    for (const art of artifacts) {
      if (m?.has(art.id)) continue;
      const res = await s.save(art);
      m?.record({ ...art, path: res.path, bytes: res.bytes });
      saved += 1;
      acc.push({ name: art.name, path: res.path, bytes: res.bytes });
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
