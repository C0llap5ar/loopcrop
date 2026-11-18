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
export const never = () => ({ stop: false });

/** Stop after `n` completed turns. */
export function maxTurns(n) {
  return (s) => (s.turnsCompleted >= n
    ? { stop: true, reason: `reached ${n} turns`, code: 'max-turns' }
    : { stop: false });
}

/** Stop when the newest reply ends with any of the given markers. */
export function sawText(...needles) {
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
export function sawPattern(re) {
  return (s) => (re.test(String(s.tail ?? ''))
    ? { stop: true, reason: `reply matched ${re}`, code: 'pattern' }
    : { stop: false });
}

/** Stop after N consecutive failed turns — the site is probably blocking us. */
export function tooManyErrors(n = 3) {
  return (s) => (s.consecutiveErrors >= n
    ? { stop: true, reason: `${n} consecutive errors`, code: 'errors' }
    : { stop: false });
}

/** Stop after a wall-clock budget, e.g. maxDuration(8 * 3600_000). */
export function maxDuration(ms) {
  return (s) => (s.now - s.startedAt >= ms
    ? { stop: true, reason: `ran for ${Math.round((s.now - s.startedAt) / 60000)} min`, code: 'duration' }
    : { stop: false });
}

/** Combine conditions: stop as soon as any of them fires. First match wins. */
export function anyOf(...conds) {
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
export function noArtifactsFor(n = 5) {
  return (s) => (s.turnsWithoutArtifacts >= n
    ? { stop: true, reason: `${n} turns produced no files`, code: 'dry' }
    : { stop: false });
}

export function evaluateStop(cond, state) {
  if (typeof cond !== 'function') return { stop: false };
  try {
    const r = cond(state);
    return r && typeof r === 'object' ? r : { stop: false };
  } catch (err) {
    return { stop: true, reason: `stop condition threw: ${err.message}`, code: 'stop-error' };
  }
}
