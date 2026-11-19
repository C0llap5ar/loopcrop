// Regressions found by driving a real Edge tab end to end (2026-11-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWork, resolveRecipe } from '../core/recipes/index.js';

const withTempDir = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loopcrop-spec-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a .json work file loads as data instead of failing on the import attribute', withTempDir(async (dir) => {
  const path = join(dir, 'work.json');
  writeFileSync(path, JSON.stringify({
    name: 'from-json',
    stages: [{ name: 's', source: { single: true }, prompt: 'hi' }],
  }));
  const work = await resolveWork(path);
  // Node >=22 rejects import() of .json without { with: { type: 'json' } }, so before
  // the fix this threw "needs an import attribute of type: json" for valid input.
  assert.equal(work.name, 'from-json');
  assert.equal(work.stages.length, 1);
}));

test('a .json recipe file loads as data too', withTempDir(async (dir) => {
  const path = join(dir, 'recipe.json');
  writeFileSync(path, JSON.stringify({ name: 'r', prompt: 'go', outDir: './out' }));
  const recipe = await resolveRecipe(path);
  assert.equal(recipe.name, 'r');
  assert.equal(recipe.prompt, 'go');
}));

test('a .mjs work file still loads through its default export', withTempDir(async (dir) => {
  const path = join(dir, 'work.mjs');
  writeFileSync(path, 'export default { name: "from-mjs", stages: [{ name: "s", source: { single: true }, prompt: "hi" }] };\n');
  const work = await resolveWork(path);
  assert.equal(work.name, 'from-mjs');
}));
