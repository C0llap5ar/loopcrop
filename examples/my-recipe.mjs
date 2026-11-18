/**
 * Example recipe — a chapter outline generator.
 *
 * Recipes are plain data: what to say each turn, when to stop, where files go. Copy
 * this file, change the three parts, and point the CLI at it:
 *
 *   loopcrop --recipe ./examples/my-recipe.mjs
 */

import { anyOf, maxTurns, sawText, noArtifactsFor } from '../core/stops.js';

export default {
  name: 'chapter-outline',

  outDir: './outlines',

  // (turn, state) -> the prompt for that turn. `turn` is 1-based and always tells
  // you which prompt you are about to send, so the chapter number is never off.
  prompt: (turn) => [
    `为第 ${turn} 章写一份细纲。`,
    '要求：300 字以内，列出 3-5 个情节节点，标出本章的情绪落点。',
    `保存成 第${turn}章_细纲.txt。`,
  ].join('\n'),

  stop: anyOf(
    sawText('【大纲完】'),      // the model signalled the end
    noArtifactsFor(3),         // three turns with no files: something is wrong
    maxTurns(30),              // a hard ceiling, so an unattended run cannot run away
  ),
};
