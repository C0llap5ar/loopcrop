/**
 * Recipes bundle the three things a user actually cares about: what to say each
 * turn, when to stop, and where the output goes. They are plain data, so a recipe
 * can be written in a README and pasted into a config.
 */

import { anyOf, maxTurns, sawText, sawPattern, tooManyErrors, noArtifactsFor } from '../stops.js';

// sawPattern is re-exported for recipe authors building their own stop set.
export { sawPattern };

/**
 * A prompt may be a string or a function of (turn, state). Returning a function is
 * how a recipe injects the chapter number without the user re-typing it every turn.
 */
export const recipeSchema = {
  name: 'string — shown in logs and the manifest',
  prompt: 'string | (turn, state) => string',
  stop: 'stop condition (see core/stops.js)',
  outDir: 'string — where the sink writes',
};

const normalize = (r) => ({
  name: r.name ?? 'unnamed',
  prompt: r.prompt ?? 'continue',
  stop: r.stop ?? neverStop,
  outDir: r.outDir ?? './out',
  pollMs: r.pollMs,
  betweenTurnsMs: r.betweenTurnsMs,
  stallMs: r.stallMs,
  description: r.description ?? '',
});

const neverStop = () => ({ stop: false });

// ── Built-in recipes ───────────────────────────────────────────────────────────

/**
 * Serialized long-form writing. One turn = one chapter.
 *
 * The prompt is deliberately as short as possible: "继续". In a conversation that
 * already knows what it is doing, every extra word is a chance to confuse it — and
 * a chapter number typed by the tool is a chapter number that can drift out of sync
 * with the book. The model owns the numbering; the tool just keeps the loop running
 * and harvests the files.
 */
export const novel = (opts = {}) => normalize({
  name: 'novel',
  description: 'Long-form serialized writing: one chapter per turn, files harvested each round.',
  outDir: opts.outDir ?? './chapters',
  prompt: opts.prompt ?? '继续',
  stop: opts.stop ?? anyOf(
    sawText('全书完', '全文完', '【完结】'),
    tooManyErrors(3),
    noArtifactsFor(5),
    opts.maxTurns ? maxTurns(opts.maxTurns) : null,
  ),
});

/** Batch translation: same instruction each turn, driven by the source files. */
export const translate = (opts = {}) => normalize({
  name: 'translate',
  description: 'Batch translation of the files the model produced last turn.',
  outDir: opts.outDir ?? './translated',
  prompt: opts.prompt ?? '把上一轮的文件翻译成中文，保存成新文件，文件名保持不变但加 _zh 后缀。',
  stop: opts.stop ?? anyOf(tooManyErrors(3), noArtifactsFor(3), opts.maxTurns ? maxTurns(opts.maxTurns) : null),
});

/** Do the same thing N times, no per-turn adaptation. */
export const repeat = (prompt, opts = {}) => normalize({
  name: opts.name ?? 'repeat',
  description: 'Repeat one instruction a fixed number of times.',
  outDir: opts.outDir ?? './out',
  prompt,
  stop: anyOf(maxTurns(opts.times ?? 10), tooManyErrors(3)),
});

/** Escape hatch: bring your own prompt/stop/outDir. */
export const custom = (opts) => normalize(opts);

export const builtins = { novel, translate, repeat, custom };

/** Resolve `--recipe novel` / `--recipe ./my-recipe.mjs` / inline JSON. */
export async function resolveRecipe(spec, opts = {}) {
  if (spec && typeof spec === 'object') return normalize(spec);
  const name = String(spec ?? 'repeat');
  if (builtins[name]) return builtins[name](opts);
  if (/\.(mjs|js|json)$/i.test(name)) {
    const mod = await import(new URL(name, `file://${process.cwd()}/`).href);
    return normalize(mod.default ?? mod);
  }
  if (name.trim().startsWith('{')) return normalize(JSON.parse(name));
  throw new Error(`unknown recipe "${name}". built-ins: ${Object.keys(builtins).join(', ')}`);
}
