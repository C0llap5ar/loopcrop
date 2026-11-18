/**
 * Cheap end-to-end recipe used by `npm run test:live`. It asks for a tiny file
 * instead of a chapter, so a full engine run costs seconds rather than minutes.
 * Real recipes live in core/recipes/index.js.
 */
export default {
  name: 'smoke',
  description: 'Tiny file-producing prompt, for verifying the harvest path cheaply.',
  outDir: './test-out',
  prompt: '把 1 到 3 这三个数字，每行一个，写进一个名为 smoke.txt 的文件。只做这件事，不要解释。',
  stop: (state) => ({ stop: state.turnsCompleted >= 1, reason: 'one turn is enough' }),
  betweenTurnsMs: 1000,
};
