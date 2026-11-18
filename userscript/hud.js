/** Floating panel: start/stop, live status, and a tail of the log. */

const CSS = `
#loopcrop-hud { position: fixed; right: 16px; bottom: 16px; width: 320px; z-index: 2147483000;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e6e6e6;
  background: #16181d; border: 1px solid #2c3038; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
#loopcrop-hud[hidden] { display: none; }
#loopcrop-hud .pl-head { display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; background: #1d2027; border-bottom: 1px solid #2c3038; cursor: move; }
#loopcrop-hud .pl-title { flex: 1; font-weight: 600; letter-spacing: .02em; }
#loopcrop-hud .pl-dot { width: 8px; height: 8px; border-radius: 50%; background: #4b5563; }
#loopcrop-hud.running .pl-dot { background: #22c55e; animation: pl-pulse 1.4s ease-in-out infinite; }
#loopcrop-hud.error .pl-dot { background: #ef4444; }
@keyframes pl-pulse { 50% { opacity: .35; } }
#loopcrop-hud .pl-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
#loopcrop-hud .pl-row { display: flex; gap: 6px; }
#loopcrop-hud button { flex: 1; padding: 6px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid #343945; background: #23272f; color: #e6e6e6; font: inherit; }
#loopcrop-hud button:hover:not(:disabled) { background: #2b3038; }
#loopcrop-hud button:disabled { opacity: .4; cursor: default; }
#loopcrop-hud button.primary { background: #1f6feb; border-color: #1f6feb; }
#loopcrop-hud button.primary:hover:not(:disabled) { background: #2b7bf3; }
#loopcrop-hud .pl-log { height: 132px; overflow-y: auto; padding: 6px 8px; border-radius: 6px;
  background: #0f1115; border: 1px solid #23272f; white-space: pre-wrap; word-break: break-all; }
#loopcrop-hud .pl-log .warn { color: #f5c451; }
#loopcrop-hud .pl-log .error { color: #f87171; }
#loopcrop-hud .pl-log .dim { color: #7d8590; }
#loopcrop-hud .pl-status { color: #9aa4b2; }
`;

export function createHud({ onStart, onStop }) {
  let root, logEl, statusEl, startBtn, stopBtn;
  const lines = [];

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function build() {
    if (root) return;
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root = el('div');
    root.id = 'loopcrop-hud';

    const head = el('div', 'pl-head');
    head.append(el('span', 'pl-dot'), el('span', 'pl-title', 'loopcrop'),
      (() => { const b = el('button', '', '×'); b.style.flex = '0 0 auto';
        b.style.padding = '0 6px'; b.onclick = () => show(false); return b; })());

    const body = el('div', 'pl-body');
    statusEl = el('div', 'pl-status', 'idle');
    logEl = el('div', 'pl-log');

    const row = el('div', 'pl-row');
    startBtn = el('button', 'primary', 'Start');
    stopBtn = el('button', '', 'Stop');
    stopBtn.disabled = true;
    startBtn.onclick = () => { onStart(); };
    stopBtn.onclick = () => { onStop(); };
    row.append(startBtn, stopBtn);

    body.append(statusEl, row, logEl);
    root.append(head, body);
    document.body.appendChild(root);

    makeDraggable(root, head);
  }

  function setState(state, text) {
    build();
    root.classList.toggle('running', state === 'running');
    root.classList.toggle('error', state === 'error');
    if (text) statusEl.textContent = text;
    startBtn.disabled = state === 'running';
    stopBtn.disabled = state !== 'running';
    if (state === 'running') statusEl.textContent = 'running…';
    if (state === 'idle') statusEl.textContent = 'idle';
  }

  function log(level, msg) {
    build();
    const cls = level === 'warn' ? 'warn' : level === 'error' ? 'error' : '';
    const line = el('div', cls, `${new Date().toTimeString().slice(0, 8)}  ${msg}`);
    logEl.appendChild(line);
    lines.push(line);
    while (lines.length > 200) lines.shift().remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  function finish(result) {
    setState(result.code === 'error' ? 'error' : 'idle');
    statusEl.textContent = `${result.code} · ${result.turnsCompleted} turns · ${result.artifactsThisRun} files`;
  }

  function error(msg) {
    setState('error', `error: ${msg}`);
    log('error', msg);
  }

  function show(visible) {
    if (visible) build();
    if (root) root.hidden = !visible;
  }

  return { setState, log, finish, error, show };
}

function makeDraggable(root, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = root.getBoundingClientRect();
    ox = r.left; oy = r.top;
    root.style.right = 'auto'; root.style.bottom = 'auto';
    root.style.left = `${ox}px`; root.style.top = `${oy}px`;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    root.style.left = `${ox + e.clientX - sx}px`;
    root.style.top = `${oy + e.clientY - sy}px`;
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
}
