/**
 * Engine × session integration tests — the 0.2.0 acceptance criterion.
 *
 * The headline property: a crashed run resumes from the journal and **never re-sends
 * a prompt whose result was already recorded**. It can only re-send a turn whose
 * result was lost (sent but not harvested), because that result was never captured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLoop } from '../core/engine.js';
import { createMemorySink } from '../core/sinks.js';
import { maxTurns } from '../core/stops.js';
import { Journal } from '../core/journal.js';
import { createSession } from '../core/session.js';

const quiet = { info() {}, warn() {}, error() {}, turn() {}, summary() {} };
const fast = { pollMs: 1, settleMs: 1, betweenTurnsMs: 1, jitterMs: 0, stallMs: 5000 };

/**
 * A fake page whose `send` records the prompt and whose `status` settles after
 * `thinkPolls` polls. `harvest` returns the new `{ text, blocks, artifacts }` shape
 * so text persistence is exercised, and optionally throws to model a site change.
 *
 * `counter` is shared across runs to model the real world: a message id comes from
 * the *page*, which keeps counting across a tool restart. Two adapters driving the
 * same conversation must therefore agree on ids, or a replayed run would produce an
 * id that collides with an earlier turn's file.
 */
function fakeAdapter({ thinkPolls = 2, counter = { n: 0 }, onSend } = {}) {
  let streaming = false;
  const sent = [];

  return {
    sent,
    id: 'fake',
    async probe() { return { ok: true, site: 'fake', conversationId: 'c1', url: 'http://x', title: 't' }; },
    async send(text) {
      if (streaming) throw new Error('already streaming');
      sent.push(text);
      counter.n += 1;
      onSend?.(text, counter.n);
      streaming = true;
      return { ok: true };
    },
    async status() {
      if (!streaming) {
        return { phase: 'idle', lastMessageId: counter.n ? `m${counter.n}` : null, tail: `body ${counter.n}` };
      }
      streaming = false;
      return { phase: 'running', lastMessageId: null, tail: '' };
    },
    async harvest({ messageId }) {
      const n = counter.n;
      return {
        text: `正文第${n}章`,
        blocks: [{ i: 0, text: `正文第${n}章` }],
        artifacts: [{
          id: `m${n}-f0`,
          name: `ch${n}.txt`,
          mime: 'text/plain',
          bytes: new TextEncoder().encode(`content ${n}`),
          messageId,
        }],
      };
    },
  };
}

test('a crashed 100-ask run resumes and never re-sends a completed prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopcrop-replay-'));

  // One shared page identity: the message counter keeps counting across the crash,
  // exactly as a real conversation does across a tool restart.
  const counter = { n: 0 };

  // ── run 1: abort right before turn 51 would send ────────────────────────────
  const ac1 = new AbortController();
  const adapter1 = fakeAdapter({ counter });
  const run1 = await runLoop({
    adapter: adapter1,
    sink: createMemorySink(),
    recipe: {
      name: 'novel',
      prompt: (n) => { if (n === 51) ac1.abort(); return `p${n}`; },
      stop: maxTurns(100),
    },
    session: createSession({ journal: await Journal.open({ dir, workId: 'novel' }) }),
    pacing: fast,
    signal: ac1.signal,
    logger: quiet,
  });

  assert.equal(run1.code, 'aborted');
  assert.equal(adapter1.sent.length, 50, 'turns 1..50 completed before the crash');
  assert.deepEqual(adapter1.sent, Array.from({ length: 50 }, (_, i) => `p${i + 1}`));

  // ── run 2: fresh adapter + fresh journal, same dir ──────────────────────────
  const adapter2 = fakeAdapter({ counter });
  const journal2 = await Journal.open({ dir, workId: 'novel' });
  assert.equal(journal2.maxSeq(), 50, 'journal persisted exactly the completed turns');

  const run2 = await runLoop({
    adapter: adapter2,
    sink: createMemorySink(),
    recipe: { name: 'novel', prompt: (n) => `p${n}`, stop: maxTurns(100) },
    session: createSession({ journal: journal2 }),
    pacing: fast,
    logger: quiet,
  });

  assert.equal(run2.code, 'stopped');
  assert.equal(run2.stopCode, 'max-turns');

  // The critical assertion: the two runs together sent p1..p100 exactly once each.
  const combined = [...adapter1.sent, ...adapter2.sent];
  assert.equal(combined.length, 100, 'no prompt was ever re-sent or skipped');
  assert.deepEqual(combined, Array.from({ length: 100 }, (_, i) => `p${i + 1}`));

  // And the journal holds exactly one record per seq, 1..100.
  const j3 = await Journal.open({ dir, workId: 'novel' });
  assert.equal(j3.size(), 100);
  for (let seq = 1; seq <= 100; seq++) assert.ok(j3.get(seq), `seq ${seq} missing`);
});

test('a replayed run re-syncs the manifest without re-saving files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loopcrop-replay-sync-'));
  const counter = { n: 0 };

  // Run 1 completes 2 turns with a manifest that records the files.
  const adapter1 = fakeAdapter({ counter });
  const manifest1 = {
    turnsCompleted: 0, lastMessageId: null,
    has: () => false,
    record(a) { this.seen = (this.seen ?? []).concat(String(a.id)); return true; },
    noteTurn() { this.turnsCompleted += 1; },
    saveIfDirty: async () => {},
  };
  await runLoop({
    adapter: adapter1,
    sink: createMemorySink(),
    recipe: { name: 'novel', prompt: 'p', stop: maxTurns(2) },
    manifest: manifest1,
    session: createSession({ journal: await Journal.open({ dir, workId: 'novel' }) }),
    pacing: fast,
    logger: quiet,
  });
  assert.equal(manifest1.seen.length, 2);

  // Run 2 uses a *fresh, empty* manifest (as if manifest.json was lost mid-kill) but
  // the same journal. The engine must re-sync the manifest from the journal without
  // re-writing files, and resume at turn 3.
  const adapter2 = fakeAdapter({ counter });
  let sinkWrites = 0;
  const manifest2 = {
    turnsCompleted: 0, lastMessageId: null, seen: [],
    has(id) { return this.seen.includes(String(id)); },
    record(a) { this.seen.push(String(a.id)); return true; },
    noteTurn() { this.turnsCompleted += 1; },
    saveIfDirty: async () => {},
  };
  const sink2 = {
    kind: 'memory',
    async save(art) { sinkWrites += 1; return { path: `mem://${art.name}`, bytes: art.bytes.length }; },
  };

  const run2 = await runLoop({
    adapter: adapter2,
    sink: sink2,
    recipe: { name: 'novel', prompt: 'p', stop: maxTurns(3) },
    manifest: manifest2,
    session: createSession({ journal: await Journal.open({ dir, workId: 'novel' }) }),
    pacing: fast,
    logger: quiet,
  });

  assert.equal(run2.turnsCompleted, 3);
  assert.equal(manifest2.seen.length, 3, 'replay re-synced the two prior files + the one new');
  assert.equal(sinkWrites, 1, 'only turn 3 was actually written; 1..2 came from the journal');
  assert.deepEqual(adapter2.sent, ['p'], 'only turn 3 was sent');
});
