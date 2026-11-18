/**
 * Builds dist/loopcrop.user.js by inlining the shared core into one file.
 *
 * The userscript and the CLI must run the *same* engine and the *same* adapter,
 * otherwise every site fix has to be made twice and will drift. Rather than take a
 * bundler dependency for a package this small, we resolve the tiny ESM graph
 * ourselves: topological order, strip import/export syntax, wrap in an IIFE.
 *
 * Only the module graph reachable from `userscript/entry.js` is included, so
 * Node-only code (`node:fs`, manifest) never leaks into the browser bundle.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'userscript', 'entry.js');
const OUT = join(ROOT, 'dist', 'loopcrop.user.js');
const HEADER = join(ROOT, 'userscript', 'meta.js');

const IMPORT_RE = /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"](\.[^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_RE = /^\s*export\s+(default\s+)?/gm;

async function collect(file, seen = new Map()) {
  const abs = resolve(file);
  if (seen.has(abs)) return seen;
  const src = await readFile(abs, 'utf8');
  seen.set(abs, src);
  for (const m of src.matchAll(IMPORT_RE)) {
    const child = resolve(dirname(abs), m[1]);
    await collect(child, seen);
  }
  return seen;
}

function topo(modules) {
  // Depth-first post-order: dependencies land before their dependants.
  const order = [];
  const state = new Map();
  const depsOf = (src) => [...src.matchAll(IMPORT_RE)].map((m) => m[1]);

  const visit = (file, src, stack = []) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'visiting') {
      throw new Error(`import cycle: ${[...stack, file].map((f) => relative(ROOT, f)).join(' -> ')}`);
    }
    state.set(file, 'visiting');
    for (const rel of depsOf(src)) {
      const child = resolve(dirname(file), rel);
      visit(child, modules.get(child), [...stack, file]);
    }
    state.set(file, 'done');
    order.push(file);
  };

  for (const [file, src] of modules) visit(file, src);
  return order;
}

function strip(src, file) {
  const body = src
    .replace(IMPORT_RE, '')
    // `export default X` / `export const Y` / `export function Z` -> plain declaration
    .replace(EXPORT_RE, '');
  return `// ── ${relative(ROOT, file).replace(/\\/g, '/')} ${'─'.repeat(Math.max(0, 44 - relative(ROOT, file).length))}\n${body.trim()}\n`;
}

const modules = await collect(ENTRY);
const order = topo(modules);
const meta = await readFile(HEADER, 'utf8');

const body = order.map((f) => strip(modules.get(f), f)).join('\n');

const bundle = `${meta.trim()}

(function () {
  'use strict';

${body.replace(/^/gm, '  ')}

  // ── bootstrap ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startLoopCrop());
  } else {
    startLoopCrop();
  }
})();
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, bundle, 'utf8');

const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
console.log(`built ${relative(ROOT, OUT).replace(/\\/g, '/')} · ${order.length} modules · ${kb} kB`);
for (const f of order) console.log(`  ${relative(ROOT, f).replace(/\\/g, '/')}`);
