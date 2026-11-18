/**
 * Work = ordered stages of asks, not a second loop implementation.
 *
 * Every actual send/settle/harvest still goes through runLoop(). This module owns
 * only stage expansion, checks, and budget bookkeeping. Because every attempt has a
 * stable seq, the injected session replays it instead of re-sending after a crash.
 */
import { runLoop } from './engine.js';
import { expandSource } from './sources.js';
import { evaluateCheck } from './checks.js';
import { evaluateGuards } from './guards.js';

const interpolate = (template, ctx) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => {
  const value = ctx[key] !== undefined ? ctx[key] : ctx.item?.[key];
  return typeof value === 'object' ? JSON.stringify(value) : String(value ?? `{${key}}`);
});

export function normalizeWork(work) {
  if (!work || typeof work !== 'object') throw new Error('work must be an object');
  return {
    name: work.name ?? 'work',
    stages: work.stages ?? [{ name: 'repeat', source: { single: true }, repeat: work.times ?? 1, prompt: work.prompt ?? 'continue' }],
    guards: work.guards ?? {},
    outDir: work.outDir ?? './out',
  };
}

export function compileWork(work) {
  return normalizeWork(work);
}

export { expandSource, evaluateCheck, evaluateGuards };

export async function runWork({
  work,
  adapter,
  sink,
  session,
  logger = console,
  signal,
  pacing,
  manifest,
  maxTurns = 200,
  engine = runLoop,
}) {
  work = normalizeWork(work);
  const startedAt = Date.now();
  const history = session?.all?.() ?? [];
  let seq = manifest?.turnsCompleted ?? 0;
  let artifacts = 0;
  let failures = 0;
  let silence = 0;
  const saved = [];
  let stageIndex = 0;
  let itemIndex = 0;
  let attempt = 0;
  let lastEvent = null;

  // Stages and items keep their positions across restarts. The journal is keyed by
  // seq, so no prompt content hash is involved and editing a recipe never invents a
  // new work id. The cursor points at the *next* ask, not at the last recorded one.
  // `round`/`tryIndex` are recorded explicitly because a flat `attempt` cannot be
  // inverted without knowing `repeat` and `retry`, and those may have been edited
  // between runs.
  for (const ev of history) {
    if (!ev.stage) continue;
    const i = work.stages.findIndex((s) => s.name === ev.stage);
    if (i < 0) continue;
    if (i > stageIndex) { stageIndex = i; itemIndex = 0; attempt = 0; lastEvent = null; }
    if (i === stageIndex) {
      const sameItem = (ev.itemIndex ?? 0) === itemIndex;
      itemIndex = Math.max(itemIndex, ev.itemIndex ?? 0);
      attempt = sameItem ? Math.max(attempt, ev.attempt ?? 0) : attempt;
      lastEvent = ev;
    }
    seq = Math.max(seq, ev.seq);
  }
  if (lastEvent) {
    const stage = work.stages[stageIndex];
    const maxAttempts = 1 + (stage?.retry ?? 0);
    const baseRound = lastEvent.round ?? Math.floor((lastEvent.attempt ?? 0) / maxAttempts);
    const lastTry = lastEvent.tryIndex ?? (lastEvent.attempt ?? 0) % maxAttempts;
    if (lastEvent.check === 'ok') {
      // A finished round never repeats its own retry budget; it either moves to the
      // next repetition of this item, or (when repeats are exhausted) the next item.
      const limit = stage?.repeat ?? 1;
      if (baseRound + 1 < limit) {
        attempt = (baseRound + 1) * maxAttempts;
        itemIndex = lastEvent.itemIndex ?? 0;
      } else {
        itemIndex = (lastEvent.itemIndex ?? 0) + 1;
        attempt = 0;
      }
    } else {
      // A failed round resumes at its own retry slot, so a retry left in the budget
      // is spent before the item is declared paused.
      attempt = baseRound * maxAttempts + lastTry + 1;
      itemIndex = lastEvent.itemIndex ?? 0;
    }
    lastEvent = null;
  }

  const state = () => ({
    asks: seq,
    duration: Date.now() - startedAt,
    artifacts,
    failures,
    silence,
    startedAt,
    now: Date.now(),
  });

  for (; stageIndex < work.stages.length; stageIndex++, itemIndex = 0, attempt = 0) {
    const stage = work.stages[stageIndex];
    const items = await expandSource(stage.source, { session, work, stage, stageIndex });
    for (; itemIndex < items.length; itemIndex++, attempt = 0) {
      const item = items[itemIndex];
      const limit = stage.repeat ?? 1;
      const maxAttempts = 1 + (stage.retry ?? 0);
      const totalAttempts = limit * maxAttempts;
      for (; attempt < totalAttempts; attempt++) {
        if (signal?.aborted) return finish('aborted', 'abort signal');
        const guard = evaluateGuards(work.guards, state());
        if (guard.stop) return finish('paused', guard.reason, guard.budget);

        const itemId = item.id;
        // One flat counter spans both dimensions, because that counter is what the
        // journal stores and what a restart resumes from. `round` is the repetition
        // index, `turn` the retry index inside it.
        const round = Math.floor(attempt / maxAttempts);
        const tryIndex = attempt % maxAttempts;
        const turn = tryIndex + 1;
        // `round` in a prompt means the global ask ordinal across every stage, which
        // is what "write chapter {round}" actually wants. `item` is the source value.
        const ctx = {
          item: item.value, itemId, stage: stage.name, stageIndex, itemIndex,
          turn, attempt, repeat: round, round: seq + 1, total: items.length, seq: seq + 1,
        };
        const prompt = typeof stage.prompt === 'function'
          ? await stage.prompt(ctx)
          : interpolate(stage.prompt ?? work.prompt ?? 'continue', ctx);
        const attemptSeq = seq + 1;
        let result;
        try {
          result = await engine({
            adapter, sink, session, logger, signal, pacing, manifest,
            maxTurns: attemptSeq,
            recipe: {
              name: work.name,
              prompt: () => prompt,
              stop: (s) => s.turnsCompleted >= attemptSeq
                ? { stop: true, code: 'work-ask', reason: 'work ask complete' }
                : { stop: false },
            },
          });
        } catch (err) {
          failures++;
          logger.warn?.(`${stage.name}/${itemId}: ${err.message}`);
          if (failures >= (stage.maxFailures ?? 3)) return finish('paused', err.message, 'failures');
          continue;
        }
        seq = attemptSeq;
        const event = session?.get?.(seq) ?? null;
        const made = event?.saved ?? result.artifactsThisRun ?? 0;
        artifacts += made;
        silence = made > 0 ? 0 : silence + 1;
        logger.work?.({ stage: stage.name, itemId, seq, event, result });

        const check = await evaluateCheck(stage.check, { ...ctx, seq, event, result, session });
        await session?.annotate?.(seq, {
          work: work.name,
          stage: stage.name,
          stageIndex,
          itemIndex,
          itemId,
          attempt,
          round,
          tryIndex,
          check: check.status,
          checkReason: check.reason,
        });
        if (check.status === 'retry') {
          // Retries are budgeted *per repetition*, not across the whole item. Spending
          // them inside the current round is the only reading that keeps
          // `repeat: 3, retry: 1` meaning "three chapters, each allowed one retry".
          if (tryIndex + 1 < maxAttempts) {
            logger.warn?.(`${stage.name}/${itemId}: ${check.reason}; retry ${tryIndex + 1}`);
            continue;
          }
          return finish('paused', check.reason, 'check');
        }
        if (check.status === 'pause') return finish('paused', check.reason, 'check');
        if (check.status === 'abort') return finish('aborted', check.reason, 'check');
        // ok: this round is finished. Jump past the round's unused retry budget so a
        // good reply is not re-sent, while `repeat` still runs every round.
        if (stage.done && evaluateCheck(stage.done, { ...ctx, event, result })) break;
        attempt = (round + 1) * maxAttempts - 1;
      }
    }
  }
  return finish('done', 'all stages complete');

  function finish(code, reason, stopCode) {
    logger.info?.(`work end · ${code} · ${reason ?? ''}`);
    return {
      code, stopCode: stopCode ?? code, reason: reason ?? null,
      workId: work.name, turnsCompleted: seq, artifactsThisRun: artifacts,
      saved, durationMs: Date.now() - startedAt, stage: work.stages[stageIndex]?.name ?? null,
      stageIndex, itemIndex, attempt,
    };
  }
}
