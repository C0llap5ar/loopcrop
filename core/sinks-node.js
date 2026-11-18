/**
 * Node-only sinks. Kept separate from `core/sinks.js` because the userscript bundle
 * must never pull in `node:fs`.
 */

import { writeArtifact } from './manifest.js';

/** Real files on disk, collision-safe, no prompts, no browser download dir. */
export function createFsSink({ dir, logger = console } = {}) {
  if (!dir) throw new Error('fsSink requires a directory');
  return {
    kind: 'fs',
    async save(artifact) {
      const res = await writeArtifact(dir, artifact);
      logger.info?.(`wrote ${res.bytes} B -> ${res.path}`);
      return res;
    },
  };
}
