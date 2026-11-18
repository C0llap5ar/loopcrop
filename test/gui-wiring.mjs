/**
 * Static wiring check for the GUI.
 *
 * The browser half of the GUI cannot be asserted with node:test, and the DOM is not
 * available here, so this walks the source instead: every class the client script
 * creates should have a rule, and every element id it reaches for should exist in the
 * markup. It catches the ordinary "renamed a thing in one of three files" mistake,
 * which is the failure mode this UI actually has.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'gui', 'public');
const js = readFileSync(join(root, 'app.js'), 'utf8');
const css = readFileSync(join(root, 'app.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('every class the client uses has a css rule', () => {
  const used = new Set();
  for (const m of js.matchAll(/class="([^"$]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);

  const defined = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }

  const missing = [...used].filter((c) => !defined.has(c)).sort();
  assert.deepEqual(missing, [], `classes with no css rule: ${missing.join(', ')}`);
});

test('every element id the client reaches for exists in the markup', () => {
  const wanted = new Set();
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) wanted.add(m[1]);
  for (const m of js.matchAll(/\$\('#([^']+)'\)/g)) wanted.add(m[1]);

  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !present.has(id)).sort();
  assert.deepEqual(missing, [], `ids referenced but absent: ${missing.join(', ')}`);
});

test('the client never renders journal text as html', () => {
  // The detail pane shows model output verbatim inside <pre>. If a body ever reaches
  // innerHTML the whole thing becomes an injection sink fed by a remote reply.
  for (const m of js.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
    const expr = m[1];
    if (/detailText|\.text\b/.test(expr) && !/esc\(/.test(expr)) {
      assert.fail(`journal text reaches innerHTML unescaped: ${expr.trim()}`);
    }
  }
  assert.match(js, /\.textContent\s*=\s*/, 'the detail body should be set with textContent');
});
