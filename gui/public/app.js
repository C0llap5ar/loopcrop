/**
 * loopcrop GUI — thin client. All it does is mirror server state over SSE and
 * forward the user's four intents: probe, start, stop, and read a file.
 */

const $ = (id) => document.getElementById(id);

const els = {
  conn: $('conn'), connText: $('connText'),
  tab: $('tab'), btnProbe: $('btnProbe'),
  preset: $('preset'), prompt: $('prompt'),
  out: $('out'), turns: $('turns'), between: $('between'),
  btnStart: $('btnStart'), btnStop: $('btnStop'),
  status: $('status'), statusPhase: $('statusPhase'), statusElapsed: $('statusElapsed'),
  statusTurn: $('statusTurn'), statusTarget: $('statusTarget'),
  statusBar: $('statusBar'), statusHint: $('statusHint'),
  filesMeta: $('filesMeta'), filesList: $('filesList'),
  logLines: $('logLines'), btnClear: $('btnClear'),
};

const PRESETS = {
  novel: '继续',
  translate: '把上一轮的文件翻译成中文，保存成新文件，文件名保持不变但加 _zh 后缀。',
  repeat: '重复执行上面的任务。',
};

// ── live clock ────────────────────────────────────────────────────────────────

let startedAt = null;
let clockTimer = null;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function tickClock() {
  if (startedAt) els.statusElapsed.textContent = fmtElapsed(Date.now() - startedAt);
}

function setClock(ms) {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (ms) {
    startedAt = ms;
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  } else {
    startedAt = null;
    els.statusElapsed.textContent = '';
  }
}

// ── render ────────────────────────────────────────────────────────────────────

const PHASE_TEXT = {
  idle: '待机', connecting: '连接中…', running: '运行中',
  stopping: '停止中…', done: '已完成', error: '出错',
};

function renderState(s) {
  // connection
  const up = s.connection?.ok;
  els.conn.dataset.state = s.phase === 'running' || s.phase === 'connecting' || s.phase === 'stopping'
    ? 'busy' : (up ? 'up' : 'down');
  els.connText.textContent = up ? `已连接 · ${s.connection.bridge ?? ''}` : (s.connection?.error ?? '未连接');

  // tabs
  const tabs = s.tabs ?? [];
  const prevTab = els.tab.value;
  els.tab.innerHTML = '<option value="">选择一个标签页…</option>'
    + tabs.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  if (prevTab && tabs.some((t) => String(t.id) === prevTab)) els.tab.value = prevTab;
  else if (s.tab) els.tab.value = String(s.tab.id);

  // config
  if (s.config) {
    els.prompt.value = s.config.prompt ?? '继续';
    els.out.value = s.config.out ?? './out';
    els.turns.value = s.config.turns ?? 10;
    els.between.value = (s.config.between ?? 5000) / 1000;
    els.preset.value = s.config.preset ?? '';
  }

  // status
  const running = s.phase === 'running' || s.phase === 'stopping';
  els.status.dataset.phase = s.phase;
  els.statusPhase.textContent = PHASE_TEXT[s.phase] ?? s.phase;

  const turn = s.turn ?? 0, target = s.turnsTarget ?? 0;
  els.statusTurn.textContent = String(turn);
  els.statusTarget.textContent = String(target);
  const pct = target ? Math.min(100, Math.round((turn / target) * 100)) : 0;
  els.statusBar.querySelector('i').style.width = pct + '%';

  const live = s.live;
  if (running && live) {
    const words = live.textLength ? ` · ${fmtBytes(live.textLength)} 字符` : '';
    els.statusHint.textContent = `正在生成${words}`;
  } else if (s.phase === 'done' && s.lastResult) {
    els.statusHint.textContent = `结束 · ${s.lastResult.turns} 轮 · ${s.lastResult.files} 个文件`;
  } else if (s.phase === 'error' && s.lastError) {
    els.statusHint.textContent = s.lastError;
  } else {
    els.statusHint.textContent = '';
  }

  setClock(running ? s.startedAt : s.endedAt ?? null);

  // buttons
  els.btnStart.disabled = !(up && tabs.length) || running;
  els.btnStop.disabled = !running;
  els.btnStart.textContent = s.phase === 'done' ? '再来一轮' : '开始';
}

function renderLog(lines) {
  els.logLines.innerHTML = lines.map((l) => {
    const t = new Date(l.t).toTimeString().slice(0, 8);
    return `<li data-level="${esc(l.level)}"><time>${t}</time><span>${esc(l.message)}</span></li>`;
  }).join('');
  els.logLines.scrollTop = els.logLines.scrollHeight;
}

function renderFiles(files) {
  const list = files ?? [];
  els.filesMeta.textContent = list.length
    ? `${list.length} 个文件 · ${fmtBytes(list.reduce((a, f) => a + f.bytes, 0))}`
    : '—';

  const empty = list.length
    ? ''
    : '<li class="files__empty">还没有文件落地。连上浏览器、填好提示词，点「开始」。</li>';

  const items = list.map((f) => `
    <li class="file">
      <button class="file__name" type="button" data-name="${escAttr(f.name)}">${esc(f.name)}</button>
      <span class="file__bytes">${fmtBytes(f.bytes)}</span>
    </li>`).join('');

  els.filesList.innerHTML = empty + items;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s).replace(/`/g, '&#96;'); }

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ── actions ───────────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function collectConfig() {
  return {
    tab: els.tab.value,
    prompt: els.prompt.value,
    out: els.out.value,
    turns: Number(els.turns.value) || 10,
    between: Math.round((Number(els.between.value) || 5) * 1000),
    preset: els.preset.value,
  };
}

els.btnProbe.addEventListener('click', () => post('/api/probe'));
els.btnStart.addEventListener('click', () => post('/api/start', collectConfig()));
els.btnStop.addEventListener('click', () => post('/api/stop'));
els.btnClear.addEventListener('click', () => { els.logLines.innerHTML = ''; });

els.preset.addEventListener('change', () => {
  const v = els.preset.value;
  if (v && PRESETS[v] != null) els.prompt.value = PRESETS[v];
});

// persist config on change (debounced, fire-and-forget)
let cfgTimer = null;
for (const el of [els.prompt, els.out, els.turns, els.between, els.preset, els.tab]) {
  el.addEventListener('change', () => {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => post('/api/config', collectConfig()), 300);
  });
}

// file preview → open in a new tab via a data: URL (the text is already local)
els.filesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.file__name');
  if (!btn) return;
  const name = btn.dataset.name;
  const res = await fetch(`/api/file?name=${encodeURIComponent(name)}`);
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  const w = window.open('', '_blank');
  w.document.write(`<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:16px;line-height:1.6">${esc(data.text)}</pre>`);
  w.document.title = name;
});

// ── bootstrap ─────────────────────────────────────────────────────────────────

async function refreshFiles() {
  const res = await fetch('/api/files').then((r) => r.json());
  renderFiles(res.files ?? []);
}

async function init() {
  const res = await fetch('/api/state').then((r) => r.json());
  renderState(res);
  renderLog(res.log ?? []);
  refreshFiles();
}

// SSE: server pushes authoritative state, logs, and file-list nudges.
const es = new EventSource('/api/events');
es.addEventListener('state', (e) => renderState(JSON.parse(e.data)));
es.addEventListener('log', (e) => {
  const line = JSON.parse(e.data);
  els.logLines.insertAdjacentHTML('beforeend',
    `<li data-level="${esc(line.level)}"><time>${new Date(line.t).toTimeString().slice(0, 8)}</time><span>${esc(line.message)}</span></li>`);
  while (els.logLines.children.length > 400) els.logLines.firstChild.remove();
  els.logLines.scrollTop = els.logLines.scrollHeight;
});
es.addEventListener('refresh-files', refreshFiles);

init();
