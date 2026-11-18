/**
 * Budget guards are deliberately separate from stop conditions: a stop is a planned
 * destination, a guard is a safe pause. They are observed between asks, so an active
 * model turn is always allowed to finish and be journaled before the run pauses.
 */
export function evaluateGuards(guards = {}, state = {}) {
  const limits = {
    asks: guards.asks,
    duration: guards.duration,
    artifacts: guards.artifacts,
    failures: guards.failures,
    silence: guards.silence,
  };
  for (const [name, limit] of Object.entries(limits)) {
    if (limit == null) continue;
    const value = name === 'duration' ? state.now - state.startedAt : state[name] ?? 0;
    if (value >= limit) return { stop: true, code: 'guard', reason: `${name} budget reached (${value}/${limit})`, budget: name };
  }
  return { stop: false };
}
