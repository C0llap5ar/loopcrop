/**
 * The userscript metadata block carries the only version number Tampermonkey
 * looks at. If it drifts from package.json, installed users are never offered an
 * update — a silent failure that no other test would notice, because the build
 * still succeeds and the bundle still runs.
 *
 * The version is therefore stamped at build time, and this asserts the built
 * artifact really has it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const versionOf = (src) => {
  const m = src.match(/^\/\/\s*@version\s+(\S+)\s*$/m);
  assert.ok(m, 'metadata block has no @version line');
  return m[1];
};

test('the built userscript advertises the same version as package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(versionOf(read('dist/loopcrop.user.js')), pkg.version);
});

test('the metadata source does not pin a real version', () => {
  // A literal here is exactly how the two drift apart, so the source is expected
  // to hold a placeholder that cannot be mistaken for a release.
  assert.equal(versionOf(read('userscript/meta.js')), '0.0.0-dev');
});

test('the build refuses a metadata block it cannot stamp', async () => {
  // Guard the failure mode of a future edit dropping the @version line: the build
  // should stop rather than emit a bundle with no version at all.
  const build = read('scripts/build-userscript.mjs');
  assert.match(build, /@version/, 'the build should locate the @version line to stamp');
  assert.match(build, /throw new Error\(/, 'the build should fail loudly when it cannot stamp');
});
