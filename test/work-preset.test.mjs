import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWork, novelWork, workPresets } from '../core/recipes/index.js';
import { runWork, normalizeWork } from '../core/work.js';
import { createSession } from '../core/session.js';

/** A tiny in-memory journal so replay works without touching the filesystem. */
function memoryJournal() {
  const rows = new Map();
  return {
    get: (seq) => rows.get(seq) ?? null,
    maxSeq: () => (rows.size ? Math.max(...rows.keys()) : 0),
    size: () => rows.size,
    all: () => [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k)),
    append(event) { rows.set(event.seq, { ...rows.get(event.seq), ...event }); },
    truncateTo(seq) { for (const k of [...rows.keys()]) if (k > seq) rows.delete(k); },
  };
}

/** Drives runWork against a fake adapter that answers with canned text. */
async function drive(work, replies, { journal } = {}) {
  const sent = [];
  let i = 0;
  let msg = 0;
  const adapter = {
    id: 'fake',
    probe: async () => ({ ok: true, conversationId: 'c' }),
    send: async (text) => { sent.push(text); },
    status: async () => ({ phase: 'idle', lastMessageId: `m${msg}`, tail: replies[i - 1] ?? '' }),
    harvest: async () => ({ text: replies[i - 1] ?? '', blocks: [], artifacts: [] }),
  };
  // Every send advances the fake page to the next canned reply.
  const wrapped = { ...adapter, send: async (text) => { sent.push(text); msg += 1; i += 1; } };
  const sink = { save: async () => ({ path: 'x', bytes: 0 }) };
  const j = journal ?? memoryJournal();
  const session = createSession({ journal: j, now: () => 0 });
  const result = await runWork({
    work, adapter: wrapped, sink, session,
    logger: { info() {}, warn() {}, work() {} },
    pacing: { pollMs: 1, settleMs: 0, betweenTurnsMs: 0, jitterMs: 0, stallMs: 1000 },
  });
  return { result, sent, journal: j };
}

test('the novel work preset is three named stages with a usable outline prompt', () => {
  const work = novelWork({ chapters: 3, genre: '科幻' });
  assert.equal(work.name, 'novel');
  assert.deepEqual(work.stages.map((s) => s.name), ['outline', 'body', 'continuity']);
  assert.match(work.stages[0].prompt, /科幻/);
  assert.match(work.stages[0].prompt, /前 3 章/);
  assert.equal(work.stages[1].source.dynamic().length, 3);
  assert.equal(work.guards.failures, 3);
});

test('resolveWork accepts a preset name, an object and inline JSON', async () => {
  assert.equal((await resolveWork('novel', { chapters: 2 })).stages.length, 3);
  assert.deepEqual(Object.keys(workPresets), ['novel']);

  const inline = await resolveWork('{"name":"t","stages":[{"name":"s","source":{"single":true},"prompt":"hi"}]}');
  assert.equal(normalizeWork(inline).stages[0].prompt, 'hi');

  const object = await resolveWork({ name: 'o', stages: [{ name: 's', source: { single: true }, prompt: 'x' }] });
  assert.equal(object.name, 'o');

  await assert.rejects(() => resolveWork('nope'), /unknown work "nope"/);
});

test('a preset run sends the outline, one ask per chapter, then continuity', async () => {
  const work = novelWork({ chapters: 2 });
  const { result, sent } = await drive(work, [
    '大纲'.repeat(120),      // outline clears minLength 200
    '正文'.repeat(500),      // body clears minLength 800
    '正文'.repeat(500),
    '问题清单'.repeat(60),   // continuity clears minLength 100
  ]);
  assert.equal(result.code, 'done');
  assert.equal(result.turnsCompleted, 4);
  assert.equal(sent.length, 4);
  assert.match(sent[0], /分卷大纲/);
  assert.match(sent[1], /第 1 章/);
  assert.match(sent[2], /第 2 章/);
  assert.match(sent[3], /通读/);
});

test('{round} counts asks across stages while {item} follows the stage source', async () => {
  const work = {
    name: 'interp',
    stages: [
      { name: 'a', source: { list: ['x', 'y'] }, prompt: 'item={item} round={round}' },
      { name: 'b', source: { single: true }, prompt: 'second round={round}' },
    ],
  };
  const { sent } = await drive(work, ['1', '2', '3']);
  assert.deepEqual(sent, ['item=x round=1', 'item=y round=2', 'second round=3']);
});

test('repeat sends every round once even when a check passes', async () => {
  const work = { name: 'r', stages: [{ name: 's', source: { single: true }, repeat: 3, prompt: 'go', check: { minLength: 1 } }] };
  const { result, sent } = await drive(work, ['a', 'b', 'c']);
  assert.equal(result.code, 'done');
  assert.deepEqual(sent, ['go', 'go', 'go'], 'the ok check must not swallow the remaining rounds');
  assert.equal(result.turnsCompleted, 3);
});

test('a crash between rounds resumes at the next round, not the next item', async () => {
  const work = { name: 'r', stages: [{ name: 's', source: { single: true }, repeat: 4, prompt: 'go' }] };
  const first = await drive(work, ['a', 'b']);
  assert.equal(first.result.code, 'done');
  assert.equal(first.sent.length, 4);

  // Simulate a kill after two rounds: keep only the first two journal rows.
  const j = first.journal;
  j.truncateTo(2);
  const resumed = await drive(work, ['c', 'd'], { journal: j });
  assert.equal(resumed.result.code, 'done');
  assert.equal(resumed.sent.length, 2, 'only the two unrecorded rounds are sent');
  assert.equal(j.all().length, 4);
});

test('a crash inside a retry budget resumes at the retry slot, not a fresh round', async () => {
  const work = {
    name: 'rt',
    stages: [{ name: 's', source: { single: true }, repeat: 2, retry: 1, prompt: 'go', check: { minLength: 5 } }],
  };
  // Round 0: short (retry), then long enough (ok). Round 1: short (retry), then
  // short again — the retry budget is spent, so the run pauses.
  const first = await drive(work, ['x', 'okays', 'y', 'z']);
  assert.equal(first.result.code, 'paused');
  assert.equal(first.sent.length, 4);

  // Simulate a kill right after round 1's first try: keep the three rows up to and
  // including it, then confirm the resume spends round 1's remaining retry.
  const j = first.journal;
  j.truncateTo(3);
  const resumed = await drive(work, ['okay2'], { journal: j });
  assert.equal(resumed.result.code, 'done');
  assert.equal(resumed.sent.length, 1, 'only the retry of round 1 is sent, not round 0 again');
  assert.equal(j.all().length, 4);
});
