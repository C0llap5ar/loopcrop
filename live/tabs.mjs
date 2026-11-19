// Print every tab the extension can see, one per line, no bridge noise.
// Usage: node live/tabs.mjs
import { readFileSync } from 'node:fs';

const BRIDGE = 'http://127.0.0.1:17318';
const TOKEN_FILE = `${process.env.USERPROFILE}\\.pi\\agent\\pi-control-chrome.token`;
const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const health = await (await fetch(`${BRIDGE}/health`)).json();

const socket = new WebSocket(`ws://127.0.0.1:17318/ws?role=pi&token=${encodeURIComponent(token)}`);
const route = {
  browserId: health.browserId,
  connectionId: health.connectionId,
  connectionGeneration: health.connectionGeneration,
};

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 15000);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'request', id: 'tabs', method: 'list_tabs', params: {}, target: route }));
  });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== 'tabs') return;
    clearTimeout(timer);
    resolve(msg);
  });
  socket.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
});

if (!result) {
  console.log('list_tabs failed or timed out');
  process.exit(1);
}

const tabs = result.result?.tabs ?? [];
console.log(`gen ${health.connectionGeneration} · ${tabs.length} tab(s)`);
for (const t of tabs) {
  const flags = [t.active ? 'active' : '      ', String(t.status ?? '').padEnd(9)].join(' ');
  console.log(`${String(t.id).padEnd(11)} ${flags} ${(t.url ?? '').slice(0, 90)}`);
}
process.exit(0);
