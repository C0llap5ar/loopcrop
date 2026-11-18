/**
 * Integration tests for the loop itself.
 *
 * These drive the real engine with a fake adapter and a memory sink, which is where
 * the subtle bugs actually live: double-submits, re-harvesting a turn that was
 * already saved, and stop conditions firing one turn too late or too early.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runLoop } from '../core/engine.js';
import { createMemorySink } from '../core/sinks.js';
import { anyOf, maxTurns, sawText } from '../core/stops.js';

const quiet = { info() {}, warn() {}, error() {}, turn() {}, summary() {} };

/**
 * A fake page: `send` advances the turn, `status` reports running for `thinkPolls`
 * polls and then settles. `filesPerTurn` controls what each turn produces.
 */
function fakeAdapter({ thinkPolls = 2, filesPerTurn = 1, tailFor = (n) => `turn ${n}` } = {}) {
  let turn = 0;
  let polls = 0;
  let streaming = false;
  const sent = [];

  return {
    sent,
    id: 'fake',
    async probe() { return { ok: true, site: 'fake', conversationId: 'c1', url: 'http://x', title: 't' }; },
    async send(text) {
      if (streaming) throw new Error('already streaming');
      sent.push(text);
      turn += 1;
      polls = 0;
      streaming = true;
      return { ok: true };
    },
    async status() {
      if (!streaming) {
        return { phase: 'idle', lastMessageId: turn ? `m${turn}` : null, tail: turn ? tailFor(turn) : '' };
      }
      polls += 1;
      if (polls > thinkPolls) {
        streaming = false;
        return { phase: 'idle', lastMessageId: `m${turn}`, tail: tailFor(turn) };
      }
      return { phase: 'running', lastMessageId: null, tail: '' };
    },
    async harvest() {
      return Array.from({ length: filesPerTurn }, (_, i) => ({
        id: `m${turn}-f${i}`,
        name: `ch${turn}-${i}.txt`,
        mime: 'text/plain',
        bytes: new TextEncoder().encode(`content ${turn}-${i}`),
        messageId: `m${turn}`,
      }));
    },
  };
}

const fast = { pollMs: 1, settleMs: 1, betweenTurnsMs: 1, jitterMs: 0, stallMs: 5000 };

test('sends one prompt per turn and stops at maxTurns', async () => {
  const adapter = fakeAdapter();
  const sink = createMemorySink();
  const result = await runLoop({
    adapter,
    sink,
    recipe: { name: 't', prompt: (turn) => `go ${turn}`, stop: maxTurns(3) },
    pacing: fast,
    logger: quiet,
  });

  assert.equal(result.code, 'stopped');
  assert.equal(result.stopCode, 'max-turns');
  assert.equal(result.turnsCompleted, 3);
  assert.equal(sink.files.length, 3);
  // A turn means "sent a prompt and harvested its result", so the first prompt is
  // numbered 1 — an off-by-one here silently skips a chapter.
  assert.deepEqual(adapter.sent, ['go 1', 'go 2', 'go 3']);
});

test('bootstrap adopts existing files without consuming a turn number', async () => {
  // A conversation that already has a finished turn in it.
  const adapter = fakeAdapter();
  adapter.status = async () => ({ phase: 'idle', lastMessageId: 'm0', tail: 'previous work' });
  adapter.harvest = async ({ messageId }) => [{
    id: `old-${messageId}`,
    name: 'already-there.txt',
    mime: 'text/plain',
    bytes: new TextEncoder().encode('prior'),
    messageId,
  }];

  const sink = createMemorySink();
  const result = await runLoop({
    adapter,
    sink,
    recipe: { name: 't', prompt: (turn) => `go ${turn}`, stop: maxTurns(1) },
    pacing: fast,
    logger: quiet,
  });

  assert.equal(result.turnsCompleted, 1);
  assert.deepEqual(adapter.sent, ['go 1'], 'the adopt must not advance the turn counter');
  // 1 adopted file + 1 from the single real turn (same id, so it dedupes to 1 each).
  assert.ok(sink.files.length >= 1);
});

test('never sends while the page is still streaming', async () => {
  const adapter = fakeAdapter({ thinkPolls: 5 });
  const result = await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: { name: 't', prompt: 'x', stop: maxTurns(2) },
    pacing: fast,
    logger: quiet,
  });
  assert.equal(result.code, 'stopped');
  assert.equal(adapter.sent.length, 2);   // no extra sends from polling too early
});

test('does not re-harvest an artifact the manifest already knows', async () => {
  const adapter = fakeAdapter({ filesPerTurn: 2 });

  // Stand up a manifest that already claims one of turn 1's files.
  const seen = new Set(['m1-f0']);
  const manifest = {
    turnsCompleted: 0,
    get lastMessageId() { return null; },
    has: (id) => seen.has(id),
    record: (a) => { seen.add(String(a.id)); return true; },
    noteTurn() {},
    saveIfDirty: async () => {},
  };

  const sink = createMemorySink();
  await runLoop({
    adapter,
    sink,
    recipe: { name: 't', prompt: 'x', stop: maxTurns(1) },
    manifest,
    pacing: fast,
    logger: quiet,
  });

  assert.equal(sink.files.length, 1, 'only the unknown file should be saved');
  assert.equal(sink.files[0].name, 'ch1-1.txt');
});

test('a marker in the reply stops the loop before another send', async () => {
  const adapter = fakeAdapter({ tailFor: (n) => (n === 2 ? '……全书完' : `第${n}章`) });
  const result = await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: { name: 't', prompt: 'go', stop: anyOf(sawText('全书完'), maxTurns(10)) },
    pacing: fast,
    logger: quiet,
  });
  assert.equal(result.stopCode, 'marker');
  assert.equal(result.turnsCompleted, 2);
  assert.equal(adapter.sent.length, 2, 'stopped before sending turn 3');
});

test('a send failure is retried and does not lose a turn', async () => {
  let failures = 1;
  const adapter = fakeAdapter();
  const realSend = adapter.send.bind(adapter);
  adapter.send = async (text) => {
    if (failures-- > 0) throw new Error('transient');
    return realSend(text);
  };

  const result = await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: { name: 't', prompt: 'go', stop: maxTurns(2) },
    pacing: fast,
    logger: quiet,
  });

  assert.equal(result.code, 'stopped');
  assert.equal(result.turnsCompleted, 2, 'the retried turn still counted');
  assert.equal(adapter.sent.length, 2);
});

test('repeated harvest failures abort instead of looping forever', async () => {
  const adapter = fakeAdapter();
  adapter.harvest = async () => { throw new Error('site changed'); };

  const result = await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: { name: 't', prompt: 'go', stop: maxTurns(50) },
    pacing: fast,
    logger: quiet,
  });

  assert.equal(result.code, 'error');
  assert.match(result.reason, /site changed/);
  assert.ok(result.turnsCompleted < 50);
});

test('an aborted signal ends the run', async () => {
  const adapter = fakeAdapter();
  const ac = new AbortController();
  ac.abort();

  const result = await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: { name: 't', prompt: 'go', stop: maxTurns(50) },
    pacing: fast,
    signal: ac.signal,
    logger: quiet,
  });

  assert.equal(result.code, 'aborted');
  assert.equal(adapter.sent.length, 0);
});

test('a prompt function receives the turn number it is about to send', async () => {
  const adapter = fakeAdapter();
  const prompts = [];
  await runLoop({
    adapter,
    sink: createMemorySink(),
    recipe: {
      name: 't',
      prompt: (turn) => { prompts.push(turn); return `go ${turn}`; },
      stop: maxTurns(2),
    },
    pacing: fast,
    logger: quiet,
  });
  assert.deepEqual(prompts, [1, 2]);
});
