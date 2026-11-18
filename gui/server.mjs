/**
 * Local web GUI — the third front-end.
 *
 * Same engine, same adapter, same recipes as the CLI. What changes is the driver:
 * instead of arguments arriving from a shell, they arrive from a browser form, and
 * progress goes out over SSE instead of stdout.
 *
 * Deliberately no framework and no build step: `node gui/server.mjs` and open the
 * URL. A tool that spends your subscription quota should be inspectable, and three
 * readable files beat a bundler for that.
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLoop } from '../core/engine.js';
import { resolveRecipe, builtins } from '../core/recipes/index.js';
import { maxTurns } from '../core/stops.js';
import { ManifestStore } from '../core/manifest.js';
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
  phase: 'idle',              // idle | connecting | running | stopping | done | error
  startedAt: null,
  endedAt: null,
  turn: 0,
  turnsTarget: 0,
  artifactsThisRun: 0,
  lastResult: null,
  lastError: null,
  connection: { ok: false, bridge: null, error: null },
  tab: null,
  config: { prompt: '继续', out: './out', turns: 10, tab: '', between: 5000, preset: '' },
  live: null,                 // { phase, textLength, tail, polls, elapsedMs }
};

/** Log lines kept in memory so a page refresh doesn't lose the story. */
const LOG_LIMIT = 400;
const log = [];

const clients = new Set();
let abortController = null;

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
    log: log.slice(-120),
    recipes: Object.keys(builtins),
    manifest: null,
  };
}

// ── config persistence ────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const saved = JSON.parse(raw);
    state.config = { ...state.config, ...saved };
  } catch { /* first run — defaults are fine */ }
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
      throw new Error('Bridge is running, but no browser extension is connected. Load the extension in Edge and reload the tab.');
    }
    const target = (health.targets ?? []).find((x) => x.state === 'ready');
    if (!target) throw new Error('The extension is connected but reports no usable tab. Open a chat tab.');

    // List tabs through the transport so the picker shows real titles.
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
    pushLog('info', `Connected to ${base} — ${tabs.length} tab(s) visible`);
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

async function startRun() {
  if (state.phase === 'running' || state.phase === 'stopping') {
    throw new Error('a run is already in progress');
  }

  const cfg = state.config;
  const tabId = cfg.tab || state.tab?.id;
  if (!tabId) throw new Error('pick a tab first');

  const outDir = resolve(process.cwd(), cfg.out || './chapters');
  await mkdir(outDir, { recursive: true });

  setState({
    phase: 'running',
    startedAt: Date.now(),
    endedAt: null,
    turn: 0,
    turnsTarget: Number(cfg.turns) || 0,
    artifactsThisRun: 0,
    lastResult: null,
    lastError: null,
    live: null,
    outDir,
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
    if (!tab) throw new Error(`tab ${tabId} is gone — reopen it and re-pick`);

    pushLog('info', `目标标签页：${tab.title}`);
    const adapter = createPageAdapter(transport, tab.id, logger);

    const probeResult = await adapter.probe();
    if (!probeResult.ok) throw new Error(`not a supported conversation page: ${probeResult.url}`);
    pushLog('info', `会话 ${probeResult.conversationId ?? '(新会话)'} · 模型 ${probeResult.model ?? '?'}`);

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

    const manifest = await ManifestStore.open({
      dir: outDir,
      runId: new Date().toISOString().replace(/[:.]/g, '-'),
      recipe,
    });
    pushLog('info', `输出目录 ${outDir} · 从第 ${manifest.turnsCompleted + 1} 轮继续`);

    const result = await runLoop({
      adapter,
      sink: createFsSink({ dir: outDir, logger }),
      recipe,
      manifest,
      logger,
      signal: abortController.signal,
      maxTurns: Number(cfg.turns) || 200,
      pacing: {
        pollMs: 2500,
        betweenTurnsMs: Number(cfg.between) || 5000,
        jitterMs: 3000,
        stallMs: 20 * 60_000,
      },
    });

    setState({
      phase: 'done',
      endedAt: Date.now(),
      lastResult: { code: result.code, reason: result.reason, turns: result.turnsCompleted, files: result.artifactsThisRun },
    });
    emit('refresh-files');
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
  }
}

function stopRun() {
  if (!abortController) return;
  setState({ phase: 'stopping' });
  pushLog('warn', '正在停止 — 当前这一轮会写完再停');
  abortController.abort();
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
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
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
  return join(dir, base);
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

server.listen(PORT, HOST, () => {
  process.stdout.write(`\n  loopcrop 面板  http://${HOST}:${PORT}\n`);
  process.stdout.write(`  输出目录: ${resolve(process.cwd(), state.config.out || './chapters')}\n\n`);
});
