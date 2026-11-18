// Regression guard for the bug where the CLI passed a params *object* to
// send(text), so ChatGPT received the literal string "[object Object]".
//
// The lesson: asserting "send returned ok" proves nothing. This test reads the
// conversation back through the site's own API and compares the user message to
// the prompt we meant to send.
import { createChatGptAdapter } from '../core/adapters/chatgpt.js';

const base = 'http://127.0.0.1:17318';
const health = await (await fetch(base + '/health')).json();
const t = health.targets.find((x) => x.state === 'ready');
if (!t) { console.log('NO READY TARGET'); process.exit(1); }
const { token } = await (await fetch(base + '/pair')).json();

const ws = new WebSocket(`ws://127.0.0.1:17318/ws?role=pi&token=${encodeURIComponent(token)}`);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const req = (method, params) => new Promise((res) => {
  const id = 'r' + (++seq);
  pending.set(id, res);
  ws.send(JSON.stringify({ type: 'request', id, method, params, target: {
    browserId: t.browserId, connectionId: t.connectionId, connectionGeneration: t.connectionGeneration,
  } }));
});

let activeTabId = null;
async function ev(expr) {
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    const r = await req('evaluate', { tabId: activeTabId, expression: `(async () => { return await (${expr}); })()`, awaitPromise: true });
    if (!r.error) return r.result?.result?.result?.value;
    lastErr = r.error.message;
    if (!/uncertain|not connected|No current window|stale/i.test(lastErr)) throw new Error(lastErr);
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error(lastErr);
}

const created = await req('new_tab', { url: 'https://chatgpt.com/?model=auto', active: true });
// new_tab returns { tab: { id, ... }, ... } — reading `.tabId` yields undefined and
// silently makes every later call fall back to whatever tab is focused.
activeTabId = created.result?.tab?.id ?? created.result?.tabId ?? null;
if (!activeTabId) { console.log('could not determine new tab id:', JSON.stringify(created.result).slice(0, 300)); process.exit(1); }
console.log('test tab =', activeTabId);
await new Promise((r) => setTimeout(r, 6000));

const factorySrc = createChatGptAdapter.toString();
await ev(`(() => { window.__a = (${factorySrc})({ serializeBytes: 'base64' }); return true; })()`);

const PROMPT = '请原样重复这句话，不要加任何别的字：测试通过';
console.log('sending:', JSON.stringify(PROMPT));
// Positional call — exactly how the CLI must invoke it.
console.log('send ->', JSON.stringify(await ev(`window.__a.send(${JSON.stringify(PROMPT)})`)));

// wait for settle
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await ev('window.__a.status()');
  if (s.phase === 'idle' && s.textLength > 0) break;
}

// read the conversation back and find OUR user message
const check = await ev(`(async () => {
  const s = await fetch('/api/auth/session').then(r => r.json());
  const id = location.pathname.match(/\\/c\\/([0-9a-f-]{16,})/i)?.[1];
  const r = await fetch('/backend-api/conversation/' + id, { headers: { Authorization: 'Bearer ' + s.accessToken } });
  const j = await r.json();
  const msgs = Object.values(j.mapping).map(n => n.message).filter(Boolean)
    .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
  const users = msgs.filter(m => m.author?.role === 'user');
  const last = users[users.length - 1];
  const assistant = msgs.filter(m => m.author?.role === 'assistant').pop();
  return {
    userText: last ? (last.content?.parts || []).join('') : null,
    assistantText: assistant ? (assistant.content?.parts || []).join('').slice(0, 200) : null,
  };
})()`);

console.log('\nuser message received by ChatGPT:', JSON.stringify(check.userText));
console.log('assistant reply:', JSON.stringify(check.assistantText));

const pass = check.userText === PROMPT && !check.userText.includes('[object');
console.log('\n' + (pass ? 'PASS  prompt arrived verbatim' : 'FAIL  prompt corrupted in transit'));

// clean up the tab we created
await req('close_tab', { tabId: activeTabId });
ws.close();
process.exit(pass ? 0 : 1);
