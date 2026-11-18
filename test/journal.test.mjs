/**
 * Journal + session unit tests — the 0.2.0 heart.
 *
 * The one property that matters most is tested at the end: a crashed run must
 * replay recorded asks instead of re-sending them. Everything else is the plumbing
 * that makes that property hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../core/journal.js';
import { createSession } from '../core/session.js';

const tmp = () => mkdtemp(join(tmpdir(), 'loopcrop-journal-'));

test('journal appends and reads events back by seq', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: 'novel' });

  await j.append({ v: 2, t: 'ask', seq: 1, prompt: '继续', text: '第一章', files: [] });
  await j.append({ v: 2, t: 'ask', seq: 2, prompt: '继续', text: '第二章', files: [] });

  assert.equal(j.size(), 2);
  assert.equal(j.maxSeq(), 2);
  assert.equal(j.get(1).text, '第一章');
  assert.equal(j.get(3), null);
});

test('journal survives a reopen (persistence, not just memory)', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: 'novel' });
  await j.append({ v: 2, t: 'ask', seq: 1, prompt: '继续', text: 'body' });

  const j2 = await Journal.open({ dir, workId: 'novel' });
  assert.equal(j2.get(1).text, 'body');
  assert.equal(j2.maxSeq(), 1);
});

test('journal summaries omit the full text but keep lengths', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: 'novel' });
  await j.append({
    v: 2, t: 'ask', seq: 1, prompt: '继续', text: 'x'.repeat(5000),
    files: [{ id: 'f1', name: 'a.txt', bytes: 12 }],
  });

  const s = j.summaries()[0];
  assert.equal(s.textLength, 5000);
  assert.equal(s.text, undefined, 'summary must not ship the body');
  assert.equal(s.files[0].name, 'a.txt');
});

test('journal skips a torn final line instead of crashing', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: 'novel' });
  await j.append({ v: 2, t: 'ask', seq: 1, text: 'ok' });

  // Simulate a crash mid-append: a half-written line at the tail.
  const file = j.file;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, '{"v":2,"t":"ask","seq":2,"te');

  const j2 = await Journal.open({ dir, workId: 'novel' });
  assert.equal(j2.maxSeq(), 1, 'torn tail must be ignored, not trusted');
  assert.equal(j2.get(2), null);
});

test('journal truncateTo drops later seqs and keeps earlier ones', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: 'novel' });
  for (const seq of [1, 2, 3, 4]) {
    await j.append({ v: 2, t: 'ask', seq, prompt: `p${seq}`, text: `t${seq}` });
  }

  await j.truncateTo(2);
  assert.equal(j.maxSeq(), 2);
  assert.equal(j.get(3), null);

  const raw = await readFile(j.file, 'utf8');
  assert.ok(!raw.includes('"seq":4'), 'truncation must rewrite the file');
});

test('workId is sanitised so it cannot escape the journal dir', async () => {
  const dir = await tmp();
  const j = await Journal.open({ dir, workId: '../../evil' });
  // Strip the single leading separator the path join adds, then assert no separator
  // survives and the name does not start with a dot.
  const rel = j.file.replace(dir, '').replace(/^[\\/]+/, '');
  assert.ok(!rel.includes('/'), `workId kept a slash: ${rel}`);
  assert.ok(!rel.includes('\\'), `workId kept a backslash: ${rel}`);
  assert.ok(!rel.startsWith('.'), `workId still starts with a dot: ${rel}`);
});

test('session replays a recorded ask without calling doAsk again', async () => {
  const dir = await tmp();
  const journal = await Journal.open({ dir, workId: 'w' });
  let calls = 0;

  const session = createSession({ journal, now: () => 1000 });
  const first = await session.ask(1, '继续', async () => { calls += 1; return { text: 'r1', files: [] }; });
  const second = await session.ask(1, '继续', async () => { calls += 1; return { text: 'r2', files: [] }; });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls, 1, 'second ask must not re-run doAsk');
  assert.equal(second.event.text, 'r1', 'replay returns the recorded result, not a fresh one');
});

test('session without a journal always asks (userscript path)', async () => {
  const session = createSession();
  let calls = 0;
  const a = await session.ask(1, 'x', async () => { calls += 1; return { text: 'a' }; });
  const b = await session.ask(1, 'x', async () => { calls += 1; return { text: 'b' }; });
  assert.equal(calls, 2);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
});

test('session records the prompt verbatim and stamps time via now()', async () => {
  const dir = await tmp();
  const journal = await Journal.open({ dir, workId: 'w' });
  let tick = 0;
  const session = createSession({ journal, now: () => (tick += 1000) });

  const { event } = await session.ask(7, '写第7章', async () => ({ text: '正文' }));
  assert.equal(event.seq, 7);
  assert.equal(event.prompt, '写第7章');
  assert.equal(event.at, 1000, 'time must come from session.now(), not Date.now()');
});
