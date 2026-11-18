/**
 * loopcrop GUI — thin client.
 *
 * Mirrors server state over SSE and forwards the user's intents: probe, start, stop,
 * read a file, open one ask, redo from a point. The timeline only ever holds one
 * expanded reply at a time; long ones go to the slide-over instead of into the DOM,
 * because a 12-chapter journal is six hundred thousand characters.
 */

const $ = (id) => document.getElementById(id);

const els = {
  phasePill: $('phasePill'), clock: $('clock'),
  statAsks: $('statAsks'), statFiles: $('statFiles'),
  btnProbe: $('btnProbe'), conn: $('conn'), connText: $('connText'),

  railTabs: Array.from(document.querySelectorAll('.rail__tab')),
  viewFiles: $('viewFiles'), viewStages: $('viewStages'),
  filesMeta: $('filesMeta'), filesList: $('filesList'), stagesList: $('stagesList'),

  runnerToggle: $('runnerToggle'), runnerBody: $('runnerBody'), runnerSummary: $('runnerSummary'),
  tab: $('tab'), mode: $('mode'), recipeRow: $('recipeRow'), workRow: $('workRow'),
  prompt: $('prompt'), work: $('work'), genre: $('genre'), chapters: $('chapters'), maxAsks: $('maxAsks'),
  out: $('out'), turns: $('turns'), turnsField: $('turnsField'), between: $('between'),
  btnStart: $('btnStart'), btnStop: $('btnStop'), runNote: $('runNote'),

  search: $('search'), timelineCount: $('timelineCount'),
  asks: $('asks'), asksEmpty: $('asksEmpty'),

  logToggle: $('logToggle'), logLines: $('logLines'), logHint: $('logHint'),

  scrim: $('scrim'), detail: $('detail'),
  detailSeq: $('detailSeq'), detailTag: $('detailTag'), detailMeta: $('detailMeta'),
  detailPrompt: $('detailPrompt'), detailText: $('detailText'),
  btnDetailClose: $('btnDetailClose'), btnRedo: $('btnRedo'),
};

const PHASE_TEXT = {
  idle: '待机', connecting: '连接中…', running: '运行中',
  stopping: '停止中…', done: '已完成', paused: '已暂停', error: '出错',
};

const PRESETS = {
  novel: '继续',
  translate: '把上一轮的文件翻译成中文，保存成新文件，文件名保持不变但加 _zh 后缀。',
  repeat: '重复执行上面的任务。',
};

/** Which ask is currently expanded in the slide-over (null = none). */
let openSeq = null;
/** Last journal payload, so search and re-render don't refetch. */
let journalItems = [];
/** Cached full text per seq, so reopening a row is instant. */
const textCache = new Map();

// ── live clock ────────────────────────────────────────────────────────────────

let startedAt = null;
let clockTimer = null;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function tickClock() {
  if (startedAt) els.clock.textContent = fmtElapsed(Date.now() - startedAt);
}

function setClock(ms) {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (ms) {
    startedAt = ms;
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  } else {
    startedAt = null;
    els.clock.textContent = '';
  }
}

// ── render: state ─────────────────────────────────────────────────────────────

function renderState(s) {
  const up = s.connection?.ok;
  const busy = ['running', 'connecting', 'stopping'].includes(s.phase);
  els.conn.dataset.state = busy ? 'busy' : (up ? 'up' : 'down');
  els.connText.textContent = up ? 'bridge' : (s.connection?.error ? '未连接' : '未连接');
  els.conn.title = up ? (s.connection.bridge ?? '') : (s.connection?.error ?? '');

  els.phasePill.dataset.phase = s.phase ?? 'idle';
  els.phasePill.textContent = PHASE_TEXT[s.phase] ?? s.phase;

  els.statAsks.textContent = `${s.turn ?? 0} ask`;
  els.statFiles.textContent = `${s.artifactsThisRun ?? 0} 文件`;

  // tabs
  const tabs = s.tabs ?? [];
  const prevTab = els.tab.value;
  els.tab.innerHTML = '<option value="">选择一个标签页…</option>'
    + tabs.map((t) => `<option value="${escAttr(t.id)}">${esc(t.title || t.url)}</option>`).join('');
  if (prevTab && tabs.some((t) => String(t.id) === prevTab)) els.tab.value = prevTab;
  else if (s.config?.tab && tabs.some((t) => String(t.id) === String(s.config.tab))) els.tab.value = String(s.config.tab);
  else if (s.tab) els.tab.value = String(s.tab.id);

  // config (only when the field is not focused — otherwise typing fights the stream)
  const cfg = s.config ?? {};
  setIfIdle(els.prompt, cfg.prompt ?? '继续');
  setIfIdle(els.out, cfg.out ?? './chapters');
  setIfIdle(els.turns, cfg.turns ?? 10);
  setIfIdle(els.between, (cfg.between ?? 5000) / 1000);
  setIfIdle(els.genre, cfg.genre ?? '悬疑');
  setIfIdle(els.chapters, cfg.chapters ?? 12);
  setIfIdle(els.maxAsks, cfg.maxAsks ?? 40);
  if (document.activeElement !== els.mode && !els.mode.dataset.touched) els.mode.value = cfg.mode ?? 'recipe';
  if (document.activeElement !== els.work) els.work.value = cfg.work ?? 'novel';

  syncMode();

  // buttons
  const running = s.phase === 'running' || s.phase === 'stopping';
  els.btnStart.disabled = !(up && tabs.length) || running;
  els.btnStop.disabled = !running;
  els.btnStart.textContent = s.phase === 'done' || s.phase === 'paused' ? '继续' : '开始';

  setClock(running ? s.startedAt : s.endedAt ?? null);

  // runner summary line
  const mode = els.mode.value;
  els.runnerSummary.textContent = mode === 'work'
    ? `work:${els.work.value} · ${els.chapters.value} 章 · ${els.genre.value} · ${els.out.value}`
    : `${truncate(els.prompt.value.replace(/\s+/g, ' '), 40)} · ${els.turns.value} 轮 · ${els.out.value}`;

  // stop note reflects the actual phase
  if (s.phase === 'paused') {
    els.runNote.textContent = s.lastResult?.reason
      ? `已暂停：${s.lastResult.reason}。再点「继续」会从 journal 接着跑。`
      : '已暂停。再点「继续」会从 journal 接着跑。';
  } else if (s.phase === 'done' && s.lastResult) {
    els.runNote.textContent = `结束 · ${s.lastResult.turns ?? 0} ask · ${s.lastResult.files ?? 0} 个文件`;
  } else if (s.phase === 'error' && s.lastError) {
    els.runNote.textContent = s.lastError;
  } else {
    els.runNote.textContent = '停止只在当前这一轮写完之后生效。';
  }

  renderStages(s);
  renderLog(s.log ?? []);
}

function setIfIdle(el, value) {
  if (!el || document.activeElement === el) return;
  const next = String(value ?? '');
  if (el.value !== next) el.value = next;
}

function syncMode() {
  const isWork = els.mode.value === 'work';
  els.recipeRow.hidden = isWork;
  els.workRow.hidden = !isWork;
  els.turnsField.hidden = isWork;
}

// ── render: stages ────────────────────────────────────────────────────────────

function renderStages(s) {
  const rows = s.stageProgress;
  if (!rows || !rows.length) {
    els.stagesList.innerHTML = '<li class="tree__empty">这是单阶段运行，没有阶段划分。</li>';
    return;
  }
  els.stagesList.innerHTML = rows.map((r) => {
    const pct = r.items ? Math.min(100, Math.round((r.passed / r.items) * 100)) : 0;
    return `<li class="stage" data-state="${r.state}">
      <span class="stage__idx">${r.index + 1}</span>
      <span class="stage__name">${esc(r.name)}</span>
      <span class="stage__meta">${r.passed}/${r.items} · ${r.asks} ask${r.retry ? ` · retry ${r.retry}` : ''}</span>
      <span class="stage__bar"><i style="width:${pct}%"></i></span>
    </li>`;
  }).join('');
}

// ── render: timeline ──────────────────────────────────────────────────────────

const CHECK_MARK = { ok: '✓', retry: '↻', pause: '⏸', abort: '✕' };

function renderJournal(payload) {
  journalItems = payload?.items ?? [];
  paintAsks();
}

function paintAsks() {
  const q = els.search.value.trim().toLowerCase();
  const items = q
    ? journalItems.filter((r) => matches(r, q))
    : journalItems;

  els.timelineCount.textContent = q
    ? `${items.length} / ${journalItems.length}`
    : (journalItems.length ? `${journalItems.length} ask` : '');

  if (!items.length) {
    els.asks.innerHTML = journalItems.length
      ? '<li class="asks__empty">没有匹配的 ask。</li>'
      : '<li class="asks__empty" id="asksEmpty">还没有 ask。连上浏览器、配置好，点「开始」。</li>';
    return;
  }

  els.asks.innerHTML = items.map((r) => {
    const mark = CHECK_MARK[r.check] ?? (r.check ? '·' : '✓');
    const stage = r.stage ? `<span class="ask__stage">${esc(r.stage)}${r.itemId ? ` ${esc(r.itemId)}` : ''}</span>` : '';
    const files = (r.files ?? []).length
      ? `<p class="ask__files">${r.files.map((f) => `<span>${esc(f.name)}</span>`).join('')}</p>`
      : '';
    return `<li class="ask${r.seq === openSeq ? ' is-open' : ''}" data-seq="${r.seq}" data-check="${escAttr(r.check ?? '')}">
      <span class="ask__seq">#${r.seq}</span>
      <div class="ask__main">
        <div class="ask__line">
          <span class="ask__mark">${mark}</span>
          ${stage}
          <span class="ask__prompt" title="${escAttr(r.prompt)}">${esc(truncate(r.prompt.replace(/\s+/g, ' '), 90))}</span>
          <span class="ask__meta">
            <span>${fmtDur(r.dur)}</span>
            <span>${(r.textLength ?? 0).toLocaleString()} 字</span>
          </span>
        </div>
        ${files}
      </div>
      <button class="ask__open" type="button" data-open="${r.seq}">打开</button>
    </li>`;
  }).join('');
}

function matches(r, q) {
  if (String(r.seq).includes(q)) return true;
  if ((r.prompt ?? '').toLowerCase().includes(q)) return true;
  if ((r.stage ?? '').toLowerCase().includes(q)) return true;
  if ((r.files ?? []).some((f) => f.name.toLowerCase().includes(q))) return true;
  // Full-text search across cached bodies only. We never ship every body just to
  // search — that would be megabytes on each keystroke.
  const cached = textCache.get(r.seq);
  return cached ? cached.toLowerCase().includes(q) : false;
}

// ── render: files ─────────────────────────────────────────────────────────────

function renderFiles(files) {
  const list = files ?? [];
  els.filesMeta.textContent = list.length
    ? `${list.length} 个文件 · ${fmtBytes(list.reduce((a, f) => a + f.bytes, 0))}`
    : '—';

  if (!list.length) {
    els.filesList.innerHTML = '<li class="tree__empty">还没有文件落地。</li>';
    return;
  }

  els.filesList.innerHTML = list.map((f) => {
    const ext = (f.name.split('.').pop() ?? '').slice(0, 3).toLowerCase();
    return `<li class="file">
      <button class="file__name" type="button" data-name="${escAttr(f.name)}" title="${escAttr(f.name)}">
        <span class="file__icon">${esc(ext)}</span>
        <span>${esc(f.name)}</span>
      </button>
      <span class="file__bytes">${fmtBytes(f.bytes)}</span>
    </li>`;
  }).join('');
}

// ── render: log ───────────────────────────────────────────────────────────────

function logLineHtml(l) {
  const t = new Date(l.t).toTimeString().slice(0, 8);
  return `<li data-level="${escAttr(l.level)}"><time>${t}</time><span>${esc(l.message)}</span></li>`;
}

function renderLog(lines) {
  els.logLines.innerHTML = (lines ?? []).map(logLineHtml).join('');
  els.logLines.scrollTop = els.logLines.scrollHeight;
  const last = lines?.[lines.length - 1];
  els.logHint.textContent = last ? `${last.message}` : '';
}

// ── detail slide-over ─────────────────────────────────────────────────────────

async function openDetail(seq) {
  const summary = journalItems.find((r) => r.seq === seq);
  if (!summary) return;

  openSeq = seq;
  paintAsks();

  els.detailSeq.textContent = `#${seq}`;
  els.detailTag.textContent = summary.stage
    ? `${summary.stage}${summary.itemId ? ` · ${summary.itemId}` : ''}`
    : (summary.check ? `check: ${summary.check}` : 'ask');
  els.detailMeta.innerHTML = [
    summary.at ? new Date(summary.at).toLocaleString('zh-CN') : '',
    summary.dur ? `耗时 ${fmtDur(summary.dur)}` : '',
    `${(summary.textLength ?? 0).toLocaleString()} 字`,
    summary.files?.length ? `${summary.files.length} 个文件` : '',
    summary.check ? `check ${summary.check}${summary.checkReason ? `: ${summary.checkReason}` : ''}` : '',
  ].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');

  els.detailPrompt.textContent = summary.prompt ?? '';
  els.btnRedo.disabled = false;

  const cached = textCache.get(seq);
  if (cached != null) {
    els.detailText.textContent = cached;
  } else {
    els.detailText.textContent = '载入中…';
    try {
      const res = await fetch(`/api/journal/entry?seq=${seq}`).then((r) => r.json());
      if (res.error) { els.detailText.textContent = res.error; return; }
      const text = res.text || '(这一条没有正文)';
      textCache.set(seq, text);
      if (openSeq === seq) els.detailText.textContent = text;
    } catch (err) {
      els.detailText.textContent = `读取失败：${err.message}`;
    }
  }

  els.detail.setAttribute('aria-hidden', 'false');
  els.scrim.hidden = false;
  els.detailText.scrollTop = 0;
}

function closeDetail() {
  openSeq = null;
  els.detail.setAttribute('aria-hidden', 'true');
  els.scrim.hidden = true;
  paintAsks();
}

// file preview → its own tab via a data: URL (the text is already local)
async function openFile(name) {
  const res = await fetch(`/api/file?name=${encodeURIComponent(name)}`);
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<title>${esc(name)}</title><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:18px;line-height:1.75;font-size:13px">${esc(data.text)}</pre>`);
  w.document.close();
}

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s).replace(/`/g, '&#96;'); }

function truncate(s, n) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

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
    mode: els.mode.value,
    prompt: els.prompt.value,
    work: els.work.value,
    genre: els.genre.value,
    chapters: Number(els.chapters.value) || 12,
    maxAsks: Number(els.maxAsks.value) || 40,
    out: els.out.value,
    turns: Number(els.turns.value) || 10,
    between: Math.round((Number(els.between.value) || 5) * 1000),
    preset: els.prompt.value === PRESETS.novel ? 'novel' : '',
  };
}

els.btnProbe.addEventListener('click', () => post('/api/probe'));
els.btnStart.addEventListener('click', () => post('/api/start', collectConfig()));
els.btnStop.addEventListener('click', () => post('/api/stop'));

els.mode.addEventListener('change', () => { syncMode(); saveSoon(); });
els.work.addEventListener('change', saveSoon);

// rail tabs
for (const btn of els.railTabs) {
  btn.addEventListener('click', () => {
    for (const b of els.railTabs) b.classList.toggle('is-on', b === btn);
    els.viewFiles.classList.toggle('is-hidden', btn.dataset.view !== 'files');
    els.viewStages.classList.toggle('is-hidden', btn.dataset.view !== 'stages');
  });
}

// runner collapse
els.runnerToggle.addEventListener('click', () => {
  const open = els.runnerToggle.getAttribute('aria-expanded') !== 'false';
  els.runnerToggle.setAttribute('aria-expanded', String(!open));
  els.runnerBody.hidden = open;
});

// log drawer
els.logToggle.addEventListener('click', () => {
  const open = document.body.dataset.log === 'open';
  document.body.dataset.log = open ? 'closed' : 'open';
  els.logToggle.setAttribute('aria-expanded', String(!open));
  if (!open) els.logLines.scrollTop = els.logLines.scrollHeight;
});

// timeline: open one ask
els.asks.addEventListener('click', (e) => {
  const btn = e.target.closest('.ask__open');
  if (btn) { openDetail(Number(btn.dataset.open)); return; }
  const row = e.target.closest('.ask');
  if (row) openDetail(Number(row.dataset.seq));
});

els.search.addEventListener('input', () => {
  // Warm the cache for the rows that survive the filter, so full-text search sees
  // real bodies for anything the user has already looked at.
  paintAsks();
});

// files
els.filesList.addEventListener('click', (e) => {
  const btn = e.target.closest('.file__name');
  if (btn) openFile(btn.dataset.name);
});

// detail
els.btnDetailClose.addEventListener('click', closeDetail);
els.scrim.addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openSeq != null) closeDetail();
});

els.btnRedo.addEventListener('click', async () => {
  if (openSeq == null) return;
  const seq = Number(openSeq);
  const ok = confirm(`截断 journal 到 #${seq} 之前？\n\n#${seq} 及之后的 ask 会从历史里删掉，下次运行会重新发这些提示词（会花配额）。`);
  if (!ok) return;
  const res = await post('/api/journal/truncate', { seq: seq - 1 });
  if (res.error) { alert(res.error); return; }
  textCache.clear();
  closeDetail();
});

// persist config on change (debounced, fire-and-forget)
let cfgTimer = null;
function saveSoon() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => post('/api/config', collectConfig()), 350);
}
for (const el of [els.prompt, els.out, els.turns, els.between, els.genre, els.chapters, els.maxAsks, els.tab]) {
  el.addEventListener('change', saveSoon);
}

// ── bootstrap ─────────────────────────────────────────────────────────────────

async function refreshFiles() {
  const res = await fetch('/api/files').then((r) => r.json()).catch(() => ({ files: [] }));
  renderFiles(res.files ?? []);
}

async function init() {
  const res = await fetch('/api/state').then((r) => r.json());
  renderState(res);
  renderLog(res.log ?? []);
  await refreshFiles();
  const j = await fetch('/api/journal').then((r) => r.json()).catch(() => ({ items: [] }));
  renderJournal(j);
}

// SSE: server pushes authoritative state, logs, journal and file-list nudges.
const es = new EventSource('/api/events');
es.addEventListener('state', (e) => renderState(JSON.parse(e.data)));
es.addEventListener('journal', (e) => renderJournal(JSON.parse(e.data)));
es.addEventListener('log', (e) => {
  const line = JSON.parse(e.data);
  els.logLines.insertAdjacentHTML('beforeend', logLineHtml(line));
  while (els.logLines.children.length > 500) els.logLines.firstChild.remove();
  els.logLines.scrollTop = els.logLines.scrollHeight;
  els.logHint.textContent = line.message;
});
es.addEventListener('refresh-files', refreshFiles);

init();
