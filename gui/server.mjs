/**
 * Local web GUI — the third front-end.
 *
 * Same engine, same adapter, same recipes and works as the CLI. What changes is the
 * driver: instead of arguments arriving from a shell, they arrive from a browser form,
 * and progress goes out over SSE instead of stdout.
 *
 * Deliberately no framework and no build step: `node gui/server.mjs` and open the URL.
 * A tool that spends your subscription quota should be inspectable, and four readable
 * files beat a bundler for that.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, basename, extname, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLoop } from '../core/engine.js';
import { runWork } from '../core/work.js';
import { expandSource } from '../core/sources.js';
import { resolveRecipe, resolveWork, builtins } from '../core/recipes/index.js';
import { maxTurns } from '../core/stops.js';
import { ManifestStore } from '../core/manifest.js';
import { Journal } from '../core/journal.js';
import { createSession } from '../core/session.js';
import { createFsSink } from '../core/sinks-node.js';
import { openTransport, createPageAdapter } from '../cli/loop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const CONFIG_FILE = join(HERE, '..', '.loopcrop-gui.json');

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';

// ── run state ─────────────────────────────────────────────────────────────────

/** Everything the page needs to render, in one object. */
const state = {
  phase: 'idle',              // idle | connecting | running | stopping | done | paused | error
  startedAt: null,
  endedAt: null,
  turn: 0,
  turnsTarget: 0,
  artifactsThisRun: 0,
  lastResult: null,
  lastError: null,
  connection: { ok: false, bridge: null, error: null },
  tab: null,
  tabs: [],
  outDir: null,
  runName: null,
  config: {
    prompt: '继续',
    out: './chapters',
    turns: 10,
    tab: '',
    between: 5000,
    preset: '',
    mode: 'recipe',           // recipe | work
    work: 'novel',
    genre: '悬疑',
    chapters: 12,
    maxAsks: 40,
  },
  // The shape of the current staged run, so the sidebar can show stage progress
  // before a single ask exists.
  stages: null,
  live: null,                 // { phase, textLength, tail, polls }
};

/** Log lines kept in memory so a page refresh doesn't lose the story. */
const LOG_LIMIT = 500;
const log = [];

const clients = new Set();
let abortController = null;
/** The journal of the run currently displayed; null before the first run. */
let journal = null;
/** Declared stages of the current run, with resolved item counts. */
let runStages = null;

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function pushLog(level, message, extra) {
  const line = { t: Date.now(), level, message, ...extra };
  log.push(line);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  emit('log', line);
}

function setState(patch) {
  Object.assign(state, patch);
  emit('state', publicState());
}

function publicState() {
  return {
    ...state,
    log: log.slice(-160),
    recipes: Object.keys(builtins),
    stageProgress: stageProgress(),
  };
}

/** Push the current journal summaries to every page. */
function emitJournal() {
  if (!journal) { emit('journal', { workId: null, items: [] }); return; }
  emit('journal', { workId: journal.workId, items: journal.summaries() });
}

/**
 * Per-stage progress for the left rail. Totals come from the declared work (source
 * expansion is cheap and local), done counts come from the journal — a stage is
 * "done" only when an ask in it passed its check, not merely because a later stage
 * exists.
 */
function stageProgress() {
  if (!runStages) return null;
  const rows = (journal?.summaries() ?? []).filter((r) => r.stage);
  return runStages.map((s, i) => {
    const mine = rows.filter((r) => r.stage === s.name);
    const ok = mine.filter((r) => r.check === 'ok');
    const passedItems = new Set(ok.map((r) => r.itemIndex)).size;
    const last = mine[mine.length - 1] ?? null;
    const active = last && last.stage === s.name && last.check !== 'ok';
    return {
      name: s.name,
      index: i,
      items: s.items ?? 1,
      repeat: s.repeat ?? 1,
      retry: s.retry ?? 0,
      passed: passedItems,
      asks: mine.length,
      state: passedItems >= (s.items ?? 1) ? 'done' : (active ? 'active' : (mine.length ? 'active' : 'pending')),
    };
  });
}

// ── config persistence ────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(raw);
    state.config = { ...state.config, ...saved };
  } catch { /* first run — defaults are fine */ }
}

/**
 * On boot, reopen the most recent journal for the configured output directory.
 *
 * Without this the timeline is blank after a server restart even though the asks are
 * all on disk — and the whole point of the journal is that a restart is not a reset.
 */
async function restoreJournal() {
  const outDir = resolve(process.cwd(), state.config.out || './chapters');
  const dir = journalDir(outDir);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch { return; }

  const stamped = [];
  for (const name of names) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (st) stamped.push({ name, mtime: st.mtimeMs });
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  if (!stamped.length) return;

  const workId = stamped[0].name.replace(/\.jsonl$/, '');
  const opened = await Journal.open({ dir, workId }).catch(() => null);
  if (!opened || !opened.size()) return;

  journal = opened;
  Object.assign(state, {
    outDir,
    runName: workId,
    turn: opened.maxSeq(),
    // The header counts files produced by this run, and after a restart the only
    // evidence of that is the journal itself. Recount instead of showing 0.
    artifactsThisRun: opened.summaries().reduce((n, r) => n + (r.saved ?? 0), 0),
    phase: 'idle',
  });

  // Rebuild the stage rail from the declared work, so the denominators are the ones
  // the run actually had rather than a guess from the journal. If the work can't be
  // rebuilt (edited recipe, deleted source), fall back to what the journal observed.
  if (state.config.mode === 'work') {
    try {
      const work = await resolveWork(state.config.work || 'novel', {
        outDir,
        genre: state.config.genre,
        chapters: Number(state.config.chapters) || 12,
        maxAsks: Number(state.config.maxAsks) || 40,
      });
      runStages = [];
      for (let i = 0; i < work.stages.length; i++) {
        const s = work.stages[i];
        let items = 1;
        try {
          items = (await expandSource(s.source, { work, stage: s, stageIndex: i })).length;
        } catch { /* dynamic source needs a session */ }
        runStages.push({ name: s.name, items, repeat: s.repeat ?? 1, retry: s.retry ?? 0 });
      }
      state.stages = runStages;
    } catch { /* fall through to the journal-derived list below */ }
  }

  if (!runStages) {
    const order = [];
    for (const row of opened.summaries()) {
      if (row.stage && !order.some((o) => o.name === row.stage)) {
        order.push({ name: row.stage, items: (row.itemIndex ?? 0) + 1, repeat: 1, retry: 0 });
      }
    }
    if (order.length) {
      // Widen each stage's denominator to the highest item index it reached.
      for (const o of order) {
        for (const row of opened.summaries()) {
          if (row.stage === o.name) o.items = Math.max(o.items, (row.itemIndex ?? 0) + 1);
        }
      }
      runStages = order;
      state.stages = order;
    }
  }

  log.push({ t: Date.now(), level: 'info', message: `已载入 journal「${workId}」· ${opened.size()} 条 ask` });
}

async function saveConfig(patch) {
  state.config = { ...state.config, ...patch };
  await writeFile(CONFIG_FILE, JSON.stringify(state.config, null, 2), 'utf8').catch(() => {});
}

// ── bridge operations ─────────────────────────────────────────────────────────

async function probe() {
  setState({ phase: 'connecting', lastError: null });
  const base = 'http://127.0.0.1:17318';
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    if (!health.extensionConnected) {
      throw new Error('Bridge 在跑，但扩展没连上。在 Edge 里加载扩展，然后刷新那个标签页。');
    }
    const target = (health.targets ?? []).find((x) => x.state === 'ready');
    if (!target) throw new Error('扩展连上了，但没有可用标签页。打开一个对话页。');

    // Listing tabs goes through the transport so the picker shows real titles. Only
    // `list_tabs` is used here — no page evaluation, so probing stays read-only.
    const transport = await openTransport({});
    let tabs = [];
    try {
      tabs = await transport.listTabs();
    } finally {
      await transport.close();
    }

    setState({
      phase: 'idle',
      connection: { ok: true, bridge: base, error: null },
      tabs,
      tab: tabs.find((t) => /chatgpt\.com/.test(t.url)) ?? tabs.find((t) => t.active) ?? tabs[0] ?? null,
    });
    pushLog('info', `已连接 ${base} — 可见 ${tabs.length} 个标签页`);
    return true;
  } catch (err) {
    setState({
      phase: 'error',
      connection: { ok: false, bridge: base, error: err.message },
      lastError: err.message,
    });
    pushLog('error', err.message);
    return false;
  }
}

// ── the run ───────────────────────────────────────────────────────────────────

function journalDir(outDir) {
  return join(outDir, '.loopcrop', 'journal');
}

async function startRun() {
  if (state.phase === 'running' || state.phase === 'stopping') {
    throw new Error('已有任务在跑');
  }

  const cfg = state.config;
  const tabId = cfg.tab || state.tab?.id;
  if (!tabId) throw new Error('先选一个标签页');

  const outDir = resolve(process.cwd(), cfg.out || './chapters');
  await mkdir(outDir, { recursive: true });

  const mode = cfg.mode === 'work' ? 'work' : 'recipe';

  // Build the work up front so its name drives the journal id, and so a bad spec
  // fails before any browser work happens.
  const work = mode === 'work'
    ? await resolveWork(cfg.work || 'novel', {
      outDir,
      genre: cfg.genre,
      chapters: Number(cfg.chapters) || 12,
      maxAsks: Number(cfg.maxAsks) || 40,
      maxTurns: Number(cfg.turns) || 200,
    })
    : null;

  // Expand each stage's source now so the rail can show real denominators ("3/12
  // chapters") instead of guessing. Expansion is local and side-effect free.
  if (work) {
    runStages = [];
    for (let i = 0; i < work.stages.length; i++) {
      const s = work.stages[i];
      let items = 1;
      try {
        items = (await expandSource(s.source, { work, stage: s, stageIndex: i })).length;
      } catch { /* a dynamic source may need a session; fall back to 1 */ }
      runStages.push({ name: s.name, items, repeat: s.repeat ?? 1, retry: s.retry ?? 0 });
    }
  } else {
    runStages = null;
  }

  setState({
    phase: 'running',
    startedAt: Date.now(),
    endedAt: null,
    turn: 0,
    turnsTarget: mode === 'work' ? (Number(cfg.maxAsks) || 40) : (Number(cfg.turns) || 0),
    artifactsThisRun: 0,
    lastResult: null,
    lastError: null,
    live: null,
    outDir,
    runName: work ? work.name : (cfg.preset || 'custom'),
    stages: runStages,
  });
  log.length = 0;

  abortController = new AbortController();

  // The logger is the engine's only window out. Everything it says becomes both an
  // SSE line and a state update, so the UI never has to poll.
  const logger = {
    info: (m) => pushLog('info', m),
    warn: (m) => pushLog('warn', m),
    error: (m) => pushLog('error', m),
    turn: (n, info) => {
      pushLog('turn', `第 ${n} 轮结束 · 新增 ${info.saved} 个文件`, { turn: n });
      setState({ turn: n, artifactsThisRun: state.artifactsThisRun + info.saved });
      emit('refresh-files');
      emitJournal();
    },
    work: ({ stage, itemId, seq, event, result }) => {
      const chars = typeof event?.text === 'string' ? event.text.length : 0;
      pushLog('turn', `[${stage}] ${itemId} · ask #${seq} · ${fmtMs(event?.dur)} · ${chars.toLocaleString()} 字`,
        { turn: seq });
      setState({ turn: seq, artifactsThisRun: state.artifactsThisRun + (event?.saved ?? 0) });
      void result;
      emit('refresh-files');
      emitJournal();
    },
    poll: (st, meta) => {
      // Throttled: one update per ~1s is plenty for a human watching a 7-minute turn.
      const now = Date.now();
      if (now - (logger._lastPoll ?? 0) < 900) return;
      logger._lastPoll = now;
      setState({ live: { phase: st.phase, textLength: st.textLength, tail: st.tail, polls: meta.polls } });
    },
    summary: (r) => pushLog('info', `结束 — ${r.code}${r.reason ? ` · ${r.reason}` : ''}`),
  };

  let transport = null;
  try {
    transport = await openTransport({});
    const tab = await transport.pickTab(tabId);
    if (!tab) throw new Error(`标签页 ${tabId} 已经关了 — 重新打开再选一次`);

    pushLog('info', `目标标签页：${tab.title}`);
    const adapter = createPageAdapter(transport, tab.id, logger);

    const probeResult = await adapter.probe();
    if (!probeResult.ok) throw new Error(`这不是受支持的对话页：${probeResult.url}`);
    pushLog('info', `会话 ${probeResult.conversationId ?? '(新会话)'} · 模型 ${probeResult.model ?? '?'}`);

    const runName = work ? work.name : (cfg.preset || 'custom');

    // The journal is the progress truth: it makes a crashed run resumable without
    // re-sending prompts, and it is what the timeline renders.
    journal = await Journal.open({ dir: journalDir(outDir), workId: runName });
    const session = createSession({ journal });
    const resumed = journal.size();
    if (resumed) pushLog('info', `journal 已有 ${resumed} 条 ask，已完成的会本地重放，不重发`);
    emitJournal();

    const pacing = {
      pollMs: 2500,
      betweenTurnsMs: Number(cfg.between) || 5000,
      jitterMs: 3000,
      stallMs: 20 * 60_000,
    };
    const sink = createFsSink({ dir: outDir, logger });

    const manifest = await ManifestStore.open({
      dir: outDir,
      runId: new Date().toISOString().replace(/[:.]/g, '-'),
      recipe: { name: runName },
    });

    let result;
    if (work) {
      pushLog('info', `work「${runName}」· ${work.stages.length} 个阶段 · 输出 ${outDir}`);
      result = await runWork({
        work, adapter, sink, session, manifest, logger,
        signal: abortController.signal,
        pacing,
        maxTurns: Number(cfg.turns) || 200,
      });
    } else {
      // The prompt is first-class. A preset just seeds the textarea; the run itself
      // always uses the current text verbatim (with {turn} substituted per round).
      const promptText = String(cfg.prompt ?? '继续').trim() || '继续';
      pushLog('info', `提示词「${promptText}」`);

      const recipe = await resolveRecipe({
        name: cfg.preset || 'custom',
        outDir,
        prompt: (n) => promptText.replaceAll('{turn}', String(n)),
        stop: maxTurns(Number(cfg.turns) || 10),
      });

      result = await runLoop({
        adapter, sink, recipe, manifest, session, logger,
        signal: abortController.signal,
        maxTurns: Number(cfg.turns) || 200,
        pacing,
      });
    }

    const phase = result.code === 'error' ? 'error' : (result.code === 'paused' ? 'paused' : 'done');
    setState({
      phase,
      endedAt: Date.now(),
      lastResult: {
        code: result.code,
        reason: result.reason,
        turns: result.turnsCompleted,
        files: result.artifactsThisRun,
        stage: result.stage ?? null,
      },
      lastError: phase === 'error' ? (result.reason ?? 'run failed') : null,
    });
    emit('refresh-files');
    emitJournal();
  } catch (err) {
    const aborted = /aborted/i.test(err.message);
    setState({
      phase: aborted ? 'done' : 'error',
      endedAt: Date.now(),
      lastError: aborted ? null : err.message,
    });
    if (!aborted) pushLog('error', err.message);
  } finally {
    abortController = null;
    if (transport) await transport.close().catch(() => {});
    emit('refresh-files');
  }
}

function stopRun() {
  if (!abortController) return;
  setState({ phase: 'stopping' });
  pushLog('warn', '正在停止 — 当前这一轮会写完再停');
  abortController.abort();
}

function fmtMs(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// ── files ─────────────────────────────────────────────────────────────────────

async function listFiles() {
  const dir = state.outDir ?? resolve(process.cwd(), state.config.out || './chapters');
  try {
    const names = await readdir(dir);
    const out = [];
    for (const name of names) {
      if (name === 'manifest.json' || name.startsWith('.')) continue;
      const full = join(dir, name);
      const st = await stat(full);
      if (!st.isFile()) continue;
      out.push({ name, bytes: st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return { dir, files: out };
  } catch (err) {
    return { dir, files: [], error: err.message };
  }
}

/** Reject anything that would let a crafted name escape the output directory. */
function safeJoin(dir, name) {
  if (!name || name.includes('\0')) return null;
  const base = basename(name);
  if (base !== name) return null;
  const full = join(dir, base);
  if (relative(dir, full).split(sep)[0] === '..') return null;
  return full;
}

// ── http ──────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      res.write(`event: journal\ndata: ${JSON.stringify({
        workId: journal?.workId ?? null,
        items: journal?.summaries() ?? [],
      })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }

    if (path === '/api/state') return json(res, 200, publicState());

    if (path === '/api/probe' && req.method === 'POST') {
      const ok = await probe();
      return json(res, ok ? 200 : 502, publicState());
    }

    if (path === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      await saveConfig(body);
      return json(res, 200, { config: state.config });
    }

    if (path === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (body && Object.keys(body).length) await saveConfig(body);
      // Fire and forget: the run streams progress over SSE. Awaiting it here would
      // hold the request open for two hours.
      startRun().catch((err) => {
        setState({ phase: 'error', lastError: err.message });
        pushLog('error', err.message);
      });
      return json(res, 202, { started: true });
    }

    if (path === '/api/stop' && req.method === 'POST') {
      stopRun();
      return json(res, 202, { stopping: true });
    }

    // Summaries only — the list view never needs 600k characters of reply.
    if (path === '/api/journal') {
      const items = journal?.summaries() ?? [];
      return json(res, 200, { workId: journal?.workId ?? null, items });
    }

    // One ask's full text, fetched only when a row is opened.
    if (path === '/api/journal/entry') {
      const seq = Number(url.searchParams.get('seq'));
      const ev = journal?.get(seq) ?? null;
      if (!ev) return json(res, 404, { error: 'no such seq' });
      return json(res, 200, {
        seq: ev.seq,
        prompt: ev.prompt ?? '',
        text: ev.text ?? '',
        at: ev.at ?? null,
        dur: ev.dur ?? null,
        blocks: ev.blocks ?? [],
        files: ev.files ?? [],
        stage: ev.stage ?? null,
        itemId: ev.itemId ?? null,
        check: ev.check ?? null,
        checkReason: ev.checkReason ?? null,
      });
    }

    // Redo from a point: truncate the journal after `seq`, then rerun. Linear history
    // plus truncation, deliberately not a branch tree.
    if (path === '/api/journal/truncate' && req.method === 'POST') {
      if (state.phase === 'running' || state.phase === 'stopping') {
        return json(res, 409, { error: '任务在跑，先停' });
      }
      const body = await readBody(req);
      const seq = Number(body.seq);
      if (!Number.isInteger(seq) || seq < 0) return json(res, 400, { error: 'bad seq' });
      if (!journal) return json(res, 409, { error: '还没有 journal' });
      await journal.truncateTo(seq);
      pushLog('warn', `journal 已截断到 #${seq} — 之后的 ask 会重新发`);
      emitJournal();
      return json(res, 200, { truncated: seq, remaining: journal.size() });
    }

    if (path === '/api/files') {
      return json(res, 200, await listFiles());
    }

    if (path === '/api/file') {
      const dir = state.outDir ?? resolve(process.cwd(), state.config.out || './chapters');
      const full = safeJoin(dir, url.searchParams.get('name'));
      if (!full) return json(res, 400, { error: 'bad name' });
      const text = await readFile(full, 'utf8');
      return json(res, 200, { name: basename(full), text });
    }

    // static
    const rel = path === '/' ? '/index.html' : path;
    const file = join(PUBLIC, basename(rel));
    const ext = extname(file);
    if (!MIME[ext]) { res.writeHead(404).end('not found'); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-store' });
    res.end(bytes);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404).end('not found'); return; }
    json(res, 500, { error: err.message });
  }
});

await loadConfig();
await restoreJournal();

server.listen(PORT, HOST, () => {
  process.stdout.write(`\n  loopcrop 面板  http://${HOST}:${PORT}\n`);
  process.stdout.write(`  输出目录: ${resolve(process.cwd(), state.config.out || './chapters')}\n\n`);
});
