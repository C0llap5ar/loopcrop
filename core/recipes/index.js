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

// ── Work presets (staged) ──────────────────────────────────────────────────────

/**
 * The same novel loop, but as three honest stages instead of one blind "继续".
 *
 * The single-turn version works because a good conversation remembers its own plan.
 * A fresh conversation does not, so this preset makes the plan explicit: a skeleton
 * first, then chapters driven by that skeleton, then a continuity pass over what was
 * actually written. Each stage is still plain data, and the run stays resumable
 * because every ask gets a stable seq.
 */
export const novelWork = (opts = {}) => {
  // The outline prompt is built with real values instead of `{placeholders}`, because
  // interpolation only knows per-ask context (item, stage, round) — a genre is a
  // recipe option, and leaving `{genre}` in the text is how a prompt silently ships
  // with a literal brace in it.
  const genre = opts.genre ?? '悬疑';
  const chapters = opts.chapters ?? 12;
  return {
    name: opts.name ?? 'novel',
    outDir: opts.outDir ?? './chapters',
    description: 'Novel in three stages: outline, one chapter per ask, then a continuity pass.',
    stages: [
      {
        name: 'outline',
        source: { single: true },
        prompt: opts.outlinePrompt
          ?? `先不要写正文。为一部${genre}小说写一份分卷大纲：给出书名、主角、核心冲突、以及前 ${chapters} 章的逐章一句话梗概。只输出大纲。`,
        check: { minLength: 200 },
        retry: 1,
      },
      {
        name: 'body',
        source: { dynamic: () => Array.from({ length: chapters }, (_, i) => ({ id: String(i + 1), value: i + 1 })) },
        prompt: opts.chapterPrompt
          ?? '按大纲写第 {item} 章正文。保持与前文一致，不要复述大纲，不要写结尾总结。写完后保存为章节文件。',
        check: { minLength: 800 },
        retry: 1,
      },
      {
        name: 'continuity',
        source: { single: true },
        prompt: opts.continuityPrompt
          ?? '通读你写的全部章节，列出设定冲突、人物前后不一致、伏笔未回收的地方，并给出修订建议。只输出问题清单。',
        check: { minLength: 100 },
      },
    ],
    guards: { asks: opts.maxAsks ?? 40, failures: 3 },
  };
};

export const workPresets = { novel: novelWork };

/** Resolve `--work novel` / `--work ./my-work.mjs` / inline JSON into a work object. */
export async function resolveWork(spec, opts = {}) {
  if (spec && typeof spec === 'object') return spec;
  const name = String(spec);
  if (workPresets[name]) return workPresets[name](opts);
  if (/\.(mjs|js|json)$/i.test(name)) {
    const mod = await import(new URL(name, `file://${process.cwd()}/`).href);
    return mod.default ?? mod;
  }
  if (name.trim().startsWith('{')) return JSON.parse(name);
  throw new Error(`unknown work "${name}". built-in works: ${Object.keys(workPresets).join(', ')}`);
}

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
