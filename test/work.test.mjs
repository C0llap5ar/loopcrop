import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runWork,
  compileWork,
  expandSource,
  evaluateCheck,
  evaluateGuards,
  normalizeWork,
} from '../core/work.js';
import { createSession } from '../core/session.js';

const quiet = { info() {}, warn() {}, error() {}, work() {} };
const fast = { pollMs: 0, settleMs: 0, betweenTurnsMs: 0, jitterMs: 0, stallMs: 1000 };

function memoryJournal(initial = []) {
  const events = new Map(initial.map((event) => [event.seq, event]));
  return {
    get: (seq) => events.get(Number(seq)) ?? null,
    maxSeq: () => Math.max(0, ...events.keys()),
    all: () => [...events.values()].sort((a, b) => a.seq - b.seq),
    append: async (event) => events.set(event.seq, event),
  };
}

function fakeAdapter(replies = []) {
  const sent = [];
  const shared = replies.shared ?? replies;
  let n = 0;
  let running = false;
  return {
    sent,
    async send(prompt) {
      sent.push(prompt);
      n += 1;
      running = true;
    },
    async status() {
      if (running) {
        running = false;
        return { phase: 'running' };
      }
      return { phase: 'idle', lastMessageId: n ? `m${n}` : null, tail: '' };
    },
    async harvest() {
      const raw = typeof shared === 'function'
        ? await shared(sent[n - 1], n)
        : shared[n - 1] ?? {};
      const reply = typeof raw === 'string' ? { text: raw } : raw;
      return {
        text: reply.text ?? '',
        blocks: reply.blocks ?? [],
        artifacts: reply.artifacts ?? [],
      };
    },
  };
}

function memorySink() {
  const saved = [];
  return {
    saved,
    async save(artifact) {
      saved.push(artifact);
      return { path: `memory://${artifact.name}`, bytes: artifact.bytes.length };
    },
  };
}

async function drive(work, replies, options = {}) {
  const adapter = fakeAdapter(replies);
  const journal = options.journal ?? memoryJournal();
  const sink = options.sink ?? memorySink();
  const result = await runWork({
    work,
    adapter,
    sink,
    session: createSession({ journal }),
    logger: quiet,
    pacing: fast,
    ...options,
  });
  return { result, adapter, journal, sink };
}

test('expandSource expands single, list, csv, jsonl and dynamic sources into stable items', async () => {
  const single = await expandSource({ single: 'chapter', id: 'one' });
  assert.deepEqual(single, [{ id: 'one', value: 'chapter' }]);

  const list = await expandSource({ list: ['a', { id: 'b', title: 'B' }] });
  assert.deepEqual(list, [
    { id: '1', value: 'a' },
    { id: 'b', value: { id: 'b', title: 'B' } },
  ]);

  const csv = await expandSource({ csv: 'name,ch\n"甲,一",1\n乙,2' });
  assert.deepEqual(csv.map(({ value }) => value), [
    { name: '甲,一', ch: '1' },
    { name: '乙', ch: '2' },
  ]);

  const jsonl = await expandSource({ jsonl: '{"id":"a","ch":1}\n\n{"id":"b","ch":2}\n' });
  assert.deepEqual(jsonl, [
    { id: 'a', value: { id: 'a', ch: 1 } },
    { id: 'b', value: { id: 'b', ch: 2 } },
  ]);

  let calls = 0;
  const dynamic = await expandSource({
    dynamic: async (ctx) => {
      calls += 1;
      assert.equal(ctx.prefix, 'item');
      return [`${ctx.prefix}-1`, `${ctx.prefix}-2`];
    },
  }, { prefix: 'item' });
  assert.equal(calls, 1);
  assert.deepEqual(dynamic.map(({ value }) => value), ['item-1', 'item-2']);
});

test('built-in checks distinguish ok, retry, pause and abort', async () => {
  assert.equal((await evaluateCheck({ minLength: 4 }, { event: { text: 'long enough' } })).status, 'ok');
  assert.equal((await evaluateCheck({ minLength: 20 }, { event: { text: 'short' } })).status, 'retry');
  assert.equal((await evaluateCheck({ mustMatch: '^ok$' }, { event: { text: 'no' } })).status, 'retry');
  assert.equal((await evaluateCheck({ jsonParseable: true }, { event: { text: '{"ok":true}' } })).status, 'ok');
  assert.equal((await evaluateCheck({ jsonParseable: true }, { event: { text: '{' } })).status, 'retry');
  assert.equal((await evaluateCheck({ noRefusal: true }, { event: { text: 'I cannot do that' } })).status, 'retry');
  assert.equal((await evaluateCheck({ hasFile: true }, { event: { text: '', files: [] } })).status, 'retry');
  assert.equal((await evaluateCheck({ hasFile: true }, { event: { files: [{ name: 'a.txt' }] } })).status, 'ok');
  assert.equal((await evaluateCheck({ hasBlock: 'code' }, { event: { blocks: [{ type: 'text' }] } })).status, 'retry');
  assert.equal((await evaluateCheck({ hasBlock: 'code' }, { event: { blocks: [{ type: 'code' }] } })).status, 'ok');
  assert.equal((await evaluateCheck({ minLength: 2, onFail: 'pause' }, { event: { text: 'x' } })).status, 'pause');
  assert.equal((await evaluateCheck({ minLength: 2, onFail: 'abort' }, { event: { text: 'x' } })).status, 'abort');
});

test('allOf and anyOf retain their boolean semantics for non-ok checks', async () => {
  const ctx = { event: { text: 'good', files: [], blocks: [] } };
  const all = await evaluateCheck({ allOf: [{ mustMatch: 'good' }, { minLength: 4 }] }, ctx);
  assert.equal(all.status, 'ok');
  assert.equal(all.results.length, 2);

  const any = await evaluateCheck({ anyOf: [{ minLength: 100 }, { mustMatch: 'good' }] }, ctx);
  assert.equal(any.status, 'ok');

  const neither = await evaluateCheck({ anyOf: [{ minLength: 100 }, { mustMatch: 'absent' }] }, ctx);
  assert.equal(neither.status, 'retry');
});

test('evaluateGuards covers asks, duration, artifacts, failures and silence budgets', () => {
  const base = { asks: 0, startedAt: 0, now: 0, artifacts: 0, failures: 0, silence: 0 };
  for (const [budget, state] of [
    ['asks', { asks: 2 }],
    ['duration', { now: 50 }],
    ['artifacts', { artifacts: 3 }],
    ['failures', { failures: 1 }],
    ['silence', { silence: 4 }],
  ]) {
    const guards = { [budget]: { asks: 2, duration: 50, artifacts: 3, failures: 1, silence: 4 }[budget] };
    assert.equal(evaluateGuards(guards, base).stop, false, `${budget} must not fire below budget`);
    const result = evaluateGuards(guards, { ...base, ...state });
    assert.equal(result.stop, true);
    assert.equal(result.code, 'guard');
    assert.equal(result.budget, budget);
  }
});

test('runWork advances stages in order and exposes the current stage and item', async () => {
  const work = {
    name: 'novel',
    stages: [
      { name: 'outline', source: { single: { title: 'Book' } }, prompt: ({ item }) => `outline:${item.title}` },
      { name: 'body', source: { list: ['1', '2'] }, prompt: ({ stage, item }) => `${stage}:${item}` },
      { name: 'continuity', source: { single: true }, prompt: 'continuity' },
    ],
  };
  const { result, adapter } = await drive(work, ['outline', 'body', 'body', 'continuity']);
  assert.equal(result.code, 'done');
  assert.equal(result.stopCode, 'done');
  assert.deepEqual(adapter.sent, ['outline:Book', 'body:1', 'body:2', 'continuity']);
  assert.equal(result.turnsCompleted, 4);
  assert.equal(result.stage, null, 'a completed work is no longer inside a stage');
  assert.equal(result.stageIndex, 3);
});

test('retry checks spend the allowed retries and pause rather than failing', async () => {
  const work = {
    name: 'retry',
    stages: [{
      name: 'body',
      source: { single: 'one' },
      prompt: ({ attempt }) => `attempt-${attempt}`,
      check: { minLength: 5 },
      retry: 2,
    }],
  };
  const { result, adapter } = await drive(work, ['x', 'xx', 'xxx']);
  assert.equal(result.code, 'paused');
  assert.equal(result.stopCode, 'check');
  assert.notEqual(result.code, 'failed');
  assert.deepEqual(adapter.sent, ['attempt-0', 'attempt-1', 'attempt-2']);
  assert.equal(result.turnsCompleted, 3);
});

test('a budget guard pauses only after the current stage ask has completed', async () => {
  const work = {
    name: 'budget',
    stages: [{ name: 'body', source: { list: ['a', 'b'] }, prompt: ({ item }) => item }],
    guards: { asks: 1 },
  };
  const { result, adapter, journal } = await drive(work, ['first', 'second']);
  assert.equal(result.code, 'paused');
  assert.equal(result.stopCode, 'asks');
  assert.notEqual(result.code, 'failed');
  assert.deepEqual(adapter.sent, ['a'], 'the completed ask is journaled and the next item is not sent');
  assert.equal(result.turnsCompleted, 1);
  assert.equal(journal.get(1).text, 'first');
  assert.equal(result.stage, 'body');
  assert.equal(result.itemIndex, 1, 'progress points at the next unsent item');
});

test('journal replay resumes stage progress without re-sending recorded asks', async () => {
  const work = {
    name: 'resume',
    stages: [
      { name: 'outline', source: { single: true }, prompt: 'outline' },
      { name: 'body', source: { list: ['a', 'b'] }, prompt: ({ item }) => `body:${item}` },
      { name: 'continuity', source: { single: true }, prompt: 'continuity' },
    ],
  };
  const first = await drive(work, ['outline', 'first body', 'second body', 'continuity']);
  assert.equal(first.result.code, 'done');

  const second = await drive(work, [], { journal: first.journal });
  assert.equal(second.result.code, 'done');
  assert.equal(second.result.turnsCompleted, 4);
  assert.deepEqual(second.adapter.sent, [], 'all stages and items replay from their stable seq');
  assert.equal(second.journal.all().length, 4);
  assert.deepEqual(second.journal.all().map((event) => event.prompt), first.adapter.sent);
});

test('legacy repeat work compiles to the same fixed-turn behavior as the repeat recipe', async () => {
  const work = normalizeWork({ name: 'repeat', prompt: '继续', times: 3 });
  assert.equal(work.name, 'repeat');
  assert.equal(work.stages.length, 1);
  assert.equal(work.stages[0].repeat, 3);
  assert.equal(work.stages[0].prompt, '继续');
  assert.deepEqual(compileWork({ name: 'repeat', prompt: '继续', times: 3 }), work);

  const { result, adapter } = await drive({ name: 'repeat', prompt: '继续', times: 3 }, ['1', '2', '3']);
  assert.equal(result.code, 'done');
  assert.equal(result.turnsCompleted, 3);
  assert.deepEqual(adapter.sent, ['继续', '继续', '继续']);
});
