import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeArtifacts, normalizeStatus, validateAdapter, base64ToBytes } from '../core/protocol.js';
import { anyOf, maxTurns, sawText, noArtifactsFor, tooManyErrors, evaluateStop } from '../core/stops.js';
import { sanitizeFilename } from '../core/manifest.js';

const state = (over = {}) => ({
  turn: 1,
  turnsCompleted: 0,
  consecutiveErrors: 0,
  turnsWithoutArtifacts: 0,
  artifactsThisRun: 0,
  startedAt: 0,
  now: 0,
  tail: '',
  ...over,
});

test('normalizeStatus defaults a garbage phase to idle', () => {
  assert.equal(normalizeStatus({ phase: 'exploded' }).phase, 'idle');
  assert.equal(normalizeStatus(null).phase, 'idle');
  assert.equal(normalizeStatus({ phase: 'running', textLength: 'x' }).textLength, 0);
});

test('normalizeArtifacts keeps base64 bytes and drops malformed entries', () => {
  const b64 = Buffer.from('hello').toString('base64');
  const out = normalizeArtifacts([
    { id: 'a', name: 'a.txt', bytes: b64 },
    { id: 'b', name: 'b.txt', bytes: new Uint8Array([1, 2, 3]) },
    { id: 'c', bytes: b64 },                    // no name
    { id: 'd', name: 'd.txt', bytes: null },    // no bytes
    { id: 'e', name: 'e.txt', bytes: 'not base64!!' },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.equal(Buffer.from(out[0].bytes).toString(), 'hello');
  assert.deepEqual([...out[1].bytes], [1, 2, 3]);
});

test('base64ToBytes round-trips binary payloads', () => {
  const raw = new Uint8Array(2048).map((_, i) => i % 256);
  const back = base64ToBytes(Buffer.from(raw).toString('base64'));
  assert.deepEqual([...back], [...raw]);
});

test('validateAdapter reports every missing method at once', () => {
  const r = validateAdapter({ id: 'x' });
  assert.equal(r.ok, false);
  for (const m of ['probe', 'send', 'status', 'harvest']) {
    assert.ok(r.problems.some((p) => p.includes(m)), `expected a problem for ${m}`);
  }
});

test('maxTurns fires exactly at the boundary', () => {
  assert.equal(maxTurns(3)(state({ turnsCompleted: 2 })).stop, false);
  assert.equal(maxTurns(3)(state({ turnsCompleted: 3 })).stop, true);
});

test('sawText is case-insensitive and matches inside the tail', () => {
  assert.equal(sawText('全书完')(state({ tail: '……全书完' })).stop, true);
  assert.equal(sawText('THE END')(state({ tail: 'the end' })).stop, true);
  assert.equal(sawText('全书完')(state({ tail: '继续' })).stop, false);
});

test('noArtifactsFor guards a loop that stopped producing files', () => {
  assert.equal(noArtifactsFor(5)(state({ turnsWithoutArtifacts: 4 })).stop, false);
  assert.equal(noArtifactsFor(5)(state({ turnsWithoutArtifacts: 5 })).stop, true);
});

test('anyOf short-circuits and reports the first matching reason', () => {
  const cond = anyOf(maxTurns(10), sawText('完'));
  const r = cond(state({ turnsCompleted: 10, tail: '完' }));
  assert.equal(r.stop, true);
  assert.equal(r.code, 'max-turns');
});

test('tooManyErrors needs consecutive, not cumulative, failures', () => {
  assert.equal(tooManyErrors(3)(state({ consecutiveErrors: 2 })).stop, false);
  assert.equal(tooManyErrors(3)(state({ consecutiveErrors: 3 })).stop, true);
});

test('evaluateStop turns a throwing condition into a stop, not a crash', () => {
  const r = evaluateStop(() => { throw new Error('boom'); }, state());
  assert.equal(r.stop, true);
  assert.equal(r.code, 'stop-error');
});

test('evaluateStop ignores a non-function condition', () => {
  assert.equal(evaluateStop(undefined, state()).stop, false);
});

test('sanitizeFilename strips path separators and control characters', () => {
  // The security property is what matters: no separator survives, and no leading
  // dots that could turn the name into a relative path.
  for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', 'C:\\x\\y.txt', '/etc/shadow']) {
    const out = sanitizeFilename(hostile);
    assert.ok(!out.includes('/'), `${hostile} -> ${out} kept a slash`);
    assert.ok(!out.includes('\\'), `${hostile} -> ${out} kept a backslash`);
    assert.ok(!out.startsWith('.'), `${hostile} -> ${out} still starts with a dot`);
  }
  assert.equal(sanitizeFilename('a\u0000b.txt'), 'a_b.txt');
  assert.equal(sanitizeFilename('   '), 'artifact');
  assert.equal(sanitizeFilename('第025章_标题.txt'), '第025章_标题.txt');
});
