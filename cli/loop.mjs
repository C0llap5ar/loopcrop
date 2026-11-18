#!/usr/bin/env node
/**
 * CLI front-end — the same engine, driven from a terminal.
 *
 * It talks to a browser the user already has open, through an extension bridge, so
 * there is no second browser, no empty profile and no re-login.
 *
 * Bridge protocol (measured against pi-control-chrome bridge 0.8.0):
 *   GET  /health  -> { extensionConnected, targets: [...] }
 *   GET  /pair    -> { token }
 *   WS   /ws?role=pi&token=...   frames:
 *        -> { type: "request", id, method, params, target }
 *        <- { id, result } | { id, error }
 *
 * The transport is isolated behind `openTransport()` so it can be swapped for
 * Playwright or a raw CDP socket without touching the loop.
 */

import { runLoop } from '../core/engine.js';
import { createChatGptAdapter } from '../core/adapters/chatgpt.js';
import { normalizeHarvest } from '../core/protocol.js';
import { createFsSink } from '../core/sinks-node.js';
import { resolveRecipe } from '../core/recipes/index.js';
import { ManifestStore } from '../core/manifest.js';
import { Journal } from '../core/journal.js';
import { createSession } from '../core/session.js';
import { createLogger } from './logger.mjs';
import { parseArgs } from './args.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_BRIDGE = { host: '127.0.0.1', port: 17318 };

export async function main(argv) {
  const args = parseArgs(argv);
  const logger = createLogger({ quiet: args.quiet, json: args.json });

  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }

  const transport = await openTransport(args);
  try {
    const tab = await transport.pickTab(args.tab);
    if (!tab) throw new Error('no usable tab found — open the conversation you want to loop');

    logger.info(`bridge: ${transport.describe()}`);
    logger.info(`tab ${tab.id}: ${tab.title}`);

    const adapter = createPageAdapter(transport, tab.id, logger);
    const probe = await adapter.probe();
    if (!probe.ok) throw new Error(`not a supported conversation page: ${probe.url}`);
    logger.info(`adapter chatgpt · conversation ${probe.conversationId}`);

    const recipe = await resolveRecipe(args.recipe, {
      outDir: args.out,
      maxTurns: args.turns,
    });

    const outDir = args.out ?? recipe.outDir;
    await mkdir(outDir, { recursive: true });

    const manifest = await ManifestStore.open({
      dir: outDir,
      runId: new Date().toISOString().replace(/[:.]/g, '-'),
      recipe,
    });
    logger.info(`out: ${outDir} · resuming at turn ${manifest.turnsCompleted + 1}`);

    if (args.dryRun || args.adopt) {
      const st = await adapter.status({});
      logger.info(`phase=${st.phase} · last=${st.lastMessageId ?? 'none'} · model=${st.model ?? '?'}`);
      const { artifacts } = normalizeHarvest(await adapter.harvest({ messageId: st.lastMessageId }));
      logger.info(`found ${artifacts.length} artifact(s) in the current turn`);

      if (args.dryRun) {
        for (const a of artifacts) {
          const known = manifest.has(a.id) ? ' (already saved)' : '';
          logger.info(`  ${a.name} · ${a.bytes.length} B · ${a.id}${known}`);
        }
        return 0;
      }

      // --adopt: save what already exists, send nothing. Useful for picking up a
      // conversation that was already running, or for backfilling a run's history.
      const sink = createFsSink({ dir: outDir, logger });
      let saved = 0;
      for (const a of artifacts) {
        if (manifest.has(a.id)) { logger.info(`  skip ${a.name} (already saved)`); continue; }
        const res = await sink.save(a);
        manifest.record({ ...a, path: res.path });
        saved += 1;
      }
      manifest.noteTurn({ lastMessageId: st.lastMessageId });
      await manifest.saveIfDirty();
      logger.info(`adopted ${saved} file(s) into ${outDir}`);
      return 0;
    }

    const ac = new AbortController();
    const onSig = () => { logger.warn('caught interrupt — finishing the current turn'); ac.abort(); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    // The journal makes a crashed run resumable without re-sending prompts. It lives
    // under `.loopcrop/journal/<recipe.name>.jsonl`, keyed by the recipe so a change
    // of recipe starts a fresh history instead of mis-replaying another one's turns.
    const journal = await Journal.open({
      dir: join(outDir, '.loopcrop', 'journal'),
      workId: recipe.name ?? 'run',
    });
    const session = createSession({ journal });

    const result = await runLoop({
      adapter,
      sink: createFsSink({ dir: outDir, logger }),
      recipe,
      manifest,
      session,
      logger,
      signal: ac.signal,
      maxTurns: args.turns ?? 200,
      pacing: {
        pollMs: args.pollMs ?? 2500,
        betweenTurnsMs: args.between ?? 5000,
        jitterMs: args.jitter ?? 3000,
        stallMs: (args.stallMin ?? 20) * 60_000,
      },
    });

    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);

    logger.summary(result);
    return result.code === 'error' ? 1 : 0;
  } finally {
    await transport.close();
  }
}

/**
 * Wrap the page-driving transport so it speaks the adapter protocol.
 *
 * The adapter source is installed into the page once; afterwards each of the four
 * methods is a single round-trip. Errors are re-raised on the Node side so the
 * engine's retry logic sees them as ordinary exceptions.
 */
export function createPageAdapter(transport, tabId, logger) {
  const source = createChatGptAdapter.toString();
  // The adapter must serialize bytes as base64 here: a Uint8Array crossing the CDP
  // boundary degrades into `{"0":..,"1":..}`, which is both enormous and lossy.
  const installOpts = { serializeBytes: 'base64' };
  const stamp = `${source.length}:${JSON.stringify(installOpts)}`;

  const installScript = `(() => {
    if (window.__loopcropAdapter && window.__loopcropAdapter.__stamp === ${JSON.stringify(stamp)}) {
      return true;
    }
    window.__loopcropAdapter = (${source})(${JSON.stringify({ ...installOpts, logger: undefined })});
    window.__loopcropAdapter.__stamp = ${JSON.stringify(stamp)};
    return true;
  })()`;

  let installed;
  const ensure = () => (installed ??= transport.evaluate(tabId, installScript)
    .then((v) => { if (v !== true) throw new Error('adapter installation failed'); return true; }));

  // Arguments are passed positionally, matching the adapter's own signatures.
  // Passing a params *object* to `send(text)` is what made an early build type
  // "[object Object]" into the composer and still report success.
  const call = async (method, args = []) => {
    await ensure();
    const expr = `Promise.resolve(window.__loopcropAdapter[${JSON.stringify(method)}](${args.map((a) => JSON.stringify(a)).join(', ')}))`;
    const value = await transport.evaluateAsync(tabId, expr);
    if (value && typeof value === 'object' && value.__loopcropError) {
      throw new Error(value.__loopcropError);
    }
    return value;
  };

  return {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    probe: () => call('probe', []),
    send: (text) => call('send', [text]),
    status: (o) => call('status', [o ?? {}]),
    harvest: (o) => call('harvest', [o ?? {}]),
  };
}

export async function openTransport(args) {
  const host = args.bridgeHost ?? DEFAULT_BRIDGE.host;
  const port = args.bridgePort ?? DEFAULT_BRIDGE.port;
  const base = `http://${host}:${port}`;

  /**
   * The browser can reload the extension (update, crash, manual reload) mid-run.
   * When it does, the target comes back with a NEW connectionId and
   * connectionGeneration, and every request pinned to the old pair is rejected with
   * a stale-target error. So the route is re-derived from /health before each
   * request instead of being cached once at startup.
   */
  async function readyTarget() {
    let health;
    try {
      health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    } catch (e) {
      throw new Error(`bridge unreachable at ${base} — is the browser extension connected? (${e.message})`);
    }
    if (!health.extensionConnected) throw new Error('bridge is up but no browser extension is connected');
    const t = (health.targets ?? []).find((x) => x.state === 'ready');
    if (!t) throw new Error('no ready browser target — open a tab and retry');
    return t;
  }

  const target = await readyTarget();

  const { token } = await fetch(`${base}/pair`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
  const socket = new WebSocket(`ws://${host}:${port}/ws?role=pi&token=${encodeURIComponent(token)}`);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', () => rej(new Error('bridge websocket failed')), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? String(msg.error)));
    else entry.resolve(msg.result);
  });

  const rawRequest = (method, params, route, timeoutMs) => new Promise((resolve, reject) => {
    const id = `loopcrop-${process.pid}-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'request', id, method, params, target: route }));
  });

  /** Requests are retried once against a freshly-read route when the target moved. */
  const request = async (method, params = {}, timeoutMs = 120_000) => {
    const t = await readyTarget();
    try {
      return await rawRequest(method, params, {
        browserId: t.browserId,
        connectionId: t.connectionId,
        connectionGeneration: t.connectionGeneration,
      }, timeoutMs);
    } catch (err) {
      if (!/TARGET_UNAVAILABLE|not connected|No current window|stale/i.test(err.message)) throw err;
      const t2 = await readyTarget();
      await sleep(600);
      return rawRequest(method, params, {
        browserId: t2.browserId,
        connectionId: t2.connectionId,
        connectionGeneration: t2.connectionGeneration,
      }, timeoutMs);
    }
  };

  return {
    describe: () => `${base} · ${target.browserId}`,
    /** Every tab the extension can see, for tab pickers. */
    async listTabs() {
      const r = await request('list_tabs');
      return (r.tabs ?? []).map((t) => ({
        id: t.id,
        title: t.title || '(untitled)',
        url: t.url || '',
        active: Boolean(t.active),
        owner: t.owner ?? 'user',
      }));
    },
    async pickTab(explicit) {
      const r = await request('list_tabs');
      const list = r.tabs ?? [];
      if (explicit) return list.find((t) => String(t.id) === String(explicit)) ?? null;
      return list.find((t) => /chatgpt\.com/.test(t.url))
        ?? list.find((t) => t.active)
        ?? list[0]
        ?? null;
    },
    async evaluate(tabId, expression) {
      const r = await request('evaluate', { tabId, expression });
      return unwrap(r);
    },
    async evaluateAsync(tabId, expression) {
      // Wrap so the adapter may await fetch() internally; the bridge already sets
      // awaitPromise, this just makes the expression itself a promise.
      const wrapped = `(async () => { return await (${expression}); })()`;
      const r = await request('evaluate', { tabId, expression: wrapped, awaitPromise: true }, 180_000);
      return unwrap(r);
    },
    close: async () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bridge nests the CDP result; normalize it to a plain value. */
function unwrap(r) {
  return r?.result?.result?.value ?? r?.result?.value ?? r?.value ?? null;
}

function helpText() {
  return `loopcrop — drive an AI chat web UI in a loop, harvest what it produces

USAGE
  loopcrop [options]

OPTIONS
  --tab <id>            target tab id (default: the first chatgpt.com tab)
  --recipe <spec>       novel | translate | repeat | ./my-recipe.mjs | inline JSON
  --out <dir>           output directory (default: from the recipe)
  --turns <n>           hard ceiling on turns (default 200)
  --between <ms>        base delay between turns (default 5000)
  --jitter <ms>         extra random delay (default 3000)
  --poll <ms>           status poll interval (default 2500)
  --stall-min <n>       give up on a silent turn after n minutes (default 20)
  --bridge-host <h>     bridge host (default 127.0.0.1)
  --bridge-port <p>     bridge port (default 17318)
  --dry-run             show what would be harvested, send nothing
  --adopt               save the current turn's files now, send nothing
  --json                machine-readable log lines
  --quiet               errors only
  --help                this text

REQUIRES
  A browser extension bridge exposing /health, /pair and a /ws control socket
  (pi-control-chrome 0.8.0 verified). The extension must be installed in the
  browser profile you actually use, because that is what carries the session.

WHAT IT DOES NOT DO
  It does not call the OpenAI API and needs no API key. It drives the web UI you
  are already signed into, so your existing subscription and project context apply.
`;
}

/**
 * True when this module is the process entry point.
 *
 * Comparing hand-built strings is a Windows trap: `import.meta.url` is
 * `file:///C:/...` (three slashes, forward slashes) while `process.argv[1]` is
 * `C:\...`. `pathToFileURL` normalizes both sides, and the realpath round-trip
 * covers symlinked bin shims.
 */
async function isEntryPoint() {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import('node:url');
  const { realpath } = await import('node:fs/promises');
  const here = await realpath(new URL(import.meta.url)).catch(() => null);
  const argv = await realpath(process.argv[1]).catch(() => null);
  if (!here || !argv) return false;
  return pathToFileURL(here).href === pathToFileURL(argv).href;
}

if (await isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => { console.error(`loopcrop: ${err.message}`); process.exit(1); });
}
