/**
 * userscript front-end — the same engine, running inside the tab you already have.
 *
 * This is the zero-install path: paste one file into Tampermonkey/Violentmonkey
 * and you get the loop with no Node, no CLI, no extension bridge. It reaches the
 * engine through the adapter protocol and the browser sink.
 */

import { runLoop } from '../core/engine.js';
import { createChatGptAdapter } from '../core/adapters/chatgpt.js';
import { createDownloadSink } from '../core/sinks.js';
import { resolveRecipe } from '../core/recipes/index.js';
import { createInMemoryManifest } from './manifest-lite.js';
import { createHud } from './hud.js';
import { loadConfig } from './config.js';

function startLoopCrop() {
  const adapter = createChatGptAdapter({ logger: createConsoleShim() });
  const probe = adapter.probe();
  if (!probe.ok) return;                     // not a conversation page, stay quiet

  const hud = createHud({ onStart, onStop });
  let controller = null;
  let running = false;

  async function onStart() {
    if (running) return;
    const cfg = await loadConfig();
    running = true;
    controller = new AbortController();
    hud.setState('running');

    try {
      const recipe = await resolveRecipe(cfg.recipe, { outDir: cfg.outDir, maxTurns: cfg.maxTurns });
      const manifest = createInMemoryManifest();

      const result = await runLoop({
        adapter,
        sink: createDownloadSink({ subdir: cfg.subdir, logger: createConsoleShim(hud) }),
        recipe,
        manifest,
        logger: createConsoleShim(hud),
        signal: controller.signal,
        maxTurns: cfg.maxTurns,
        pacing: {
          pollMs: cfg.pollMs,
          betweenTurnsMs: cfg.betweenTurnsMs,
          jitterMs: cfg.jitterMs,
          stallMs: cfg.stallMin * 60_000,
        },
      });

      hud.finish(result);
    } catch (err) {
      hud.error(err.message);
    } finally {
      running = false;
      controller = null;
    }
  }

  function onStop() {
    controller?.abort();
  }

  // One convenient entry point from the userscript manager's menu.
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('loopcrop: start loop', onStart);
    GM_registerMenuCommand('loopcrop: stop loop', onStop);
    GM_registerMenuCommand('loopcrop: show panel', () => hud.show(true));
  }

  hud.show(true);
}

/** Route engine logs into both the page console and the floating panel. */
function createConsoleShim(hud) {
  const line = (level, msg) => {
    (console[level] ?? console.log)(`[loopcrop] ${msg}`);
    hud?.log?.(level, msg);
  };
  return {
    info: (m) => line('log', m),
    warn: (m) => line('warn', m),
    error: (m) => line('error', m),
    turn: (n, info) => line('log', `turn ${n} settled · ${info.saved} new file(s) of ${info.artifacts} seen`),
  };
}

export { startLoopCrop };
