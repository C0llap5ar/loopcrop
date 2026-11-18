import test from 'node:test';
import assert from 'node:assert/strict';

import { createPageAdapter } from '../cli/loop.mjs';

/**
 * Regression test for a bug that live testing caught but unit tests did not:
 *
 *   send: (text) => call('send', { text })
 *
 * The adapter's signature is `send(text)`. Wrapping the argument in an object made
 * the page receive `{}`, and `execCommand('insertText', false, {})` types the
 * literal string "[object Object]" into the composer. ChatGPT dutifully replied
 * asking what we meant, so `send()` returned `{ok: true}` and the whole loop looked
 * healthy while sending garbage. It cost a real (wasted) Plus turn.
 *
 * The invariant: whatever the caller passes must reach the page function
 * positionally and unchanged.
 */

/** A transport that records the expression and returns whatever the page would. */
function fakeTransport(returnValue = { ok: true }) {
  const calls = [];
  return {
    calls,
    evaluate: async (tabId, expr) => {
      calls.push({ kind: 'install', tabId, expr });
      return true;
    },
    evaluateAsync: async (tabId, expr) => {
      calls.push({ kind: 'call', tabId, expr });
      return returnValue;
    },
  };
}

test('send passes the prompt as a positional string, never an object', async () => {
  const t = fakeTransport({ ok: true });
  const adapter = createPageAdapter(t, 42, console);

  await adapter.send('hello world');

  const call = t.calls.find((c) => c.kind === 'call');
  assert.ok(call, 'no evaluateAsync happened');

  // The exact expression must invoke the adapter with one string argument.
  assert.match(call.expr, /__loopcropAdapter\["send"\]\("hello world"\)/);
  // And the classic symptom must be absent.
  assert.ok(!call.expr.includes('{"text"'), 'prompt was wrapped in an object');
  assert.ok(!call.expr.includes('[object'), 'sanity: literal marker in expression');
});

test('send preserves quotes, newlines and unicode in the prompt', async () => {
  const t = fakeTransport({ ok: true });
  const adapter = createPageAdapter(t, 7, console);

  const prompt = '写第26章：他说「别动」\n然后走了';
  await adapter.send(prompt);

  const call = t.calls.find((c) => c.kind === 'call');
  // Expression shape: Promise.resolve(window.__loopcropAdapter["send"](<json>))
  const m = call.expr.match(/\["send"\]\((.*)\)\)$/s);
  assert.ok(m, `unexpected expression shape: ${call.expr}`);
  assert.equal(JSON.parse(m[1]), prompt);
});

test('probe takes no arguments', async () => {
  const t = fakeTransport({ ok: false });
  const adapter = createPageAdapter(t, 1, console);
  await adapter.probe();
  const call = t.calls.find((c) => c.kind === 'call');
  assert.match(call.expr, /__loopcropAdapter\["probe"\]\(\)/);
});

test('status and harvest receive one object argument', async () => {
  const t = fakeTransport({ phase: 'idle' });
  const adapter = createPageAdapter(t, 1, console);

  await adapter.status();
  await adapter.harvest({ messageId: 'abc' });

  const calls = t.calls.filter((c) => c.kind === 'call');
  assert.match(calls[0].expr, /\["status"\]\(\{\}\)/);
  assert.match(calls[1].expr, /\["harvest"\]\(\{"messageId":"abc"\}\)/);
});

test('adapter installation happens once and is reused', async () => {
  const t = fakeTransport({ ok: true });
  const adapter = createPageAdapter(t, 5, console);

  await adapter.probe();
  await adapter.probe();
  await adapter.send('x');

  const installs = t.calls.filter((c) => c.kind === 'install');
  assert.equal(installs.length, 1, 'adapter was installed more than once');
});
