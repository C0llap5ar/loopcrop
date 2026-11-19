// Send one bridge method over the documented WebSocket protocol and print the
// whole response envelope. Used to exercise methods the loopcrop transport does
// not expose (reload_extension, devtools_*, ...).
import { readFileSync } from 'node:fs';
// Node 22+ ships a global WebSocket, so this probe needs no dependency.

const BRIDGE = 'http://127.0.0.1:17318';
const WS = 'ws://127.0.0.1:17318/ws';
const TOKEN_FILE = `${process.env.USERPROFILE}\\.pi\\agent\\pi-control-chrome.token`;

const method = process.argv[2];
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const budgetMs = Number(process.argv[4] ?? 30000);
if (!method) {
  console.log('usage: node reload-probe.mjs <method> [jsonParams] [budgetMs]');
  process.exit(1);
}

const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const health = await (await fetch(`${BRIDGE}/health`)).json();
const route = {
  browserId: health.browserId,
  connectionId: health.connectionId,
  connectionGeneration: health.connectionGeneration,
};
console.log('route', JSON.stringify(route));

const socket = new WebSocket(`${WS}?role=pi&token=${encodeURIComponent(token)}`);
const id = `probe-${Date.now()}`;

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  socket.addEventListener('open', () => {
    console.log('ws open, sending', method);
    socket.send(JSON.stringify({ type: 'request', id, method, params, target: route }));
  });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== id) return;
    clearTimeout(timer);
    resolve(msg);
  });
  socket.addEventListener('error', (event) => {
    clearTimeout(timer);
    resolve({ socketError: event.message ?? String(event) });
  });
});

const result = await done;
console.log(JSON.stringify(result, null, 2).slice(0, 2000));
try { socket.close(); } catch {}
process.exit(0);
