/**
 * Manifest — the run's memory across restarts.
 *
 * Two things must survive a crash: which turn we are on, and which artifacts we
 * already saved. Without the second one a restart re-downloads everything; without
 * the first one a restart re-sends a prompt that already ran.
 *
 * The manifest is a single JSON file written atomically after every turn. It is
 * small on purpose — artifact bodies live on disk, only their identity is recorded.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createManifest({ dir, runId, recipe }) {
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    recipe: recipe?.name ?? null,
    turnsCompleted: 0,
    artifacts: [],          // { id, name, path, bytes, messageId, savedAt }
    seenIds: [],            // artifact ids already persisted, for O(1) dedupe
    lastMessageId: null,
    lastError: null,
  };
}

export class ManifestStore {
  #file;
  #data;
  #seen;
  #dirty = false;

  constructor(file, data) {
    this.#file = file;
    this.#data = data;
    this.#seen = new Set(data.seenIds ?? []);
  }

  static async open({ dir, runId, recipe }) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'manifest.json');
    try {
      const raw = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      if (data?.version !== 1) throw new Error(`unsupported manifest version ${data?.version}`);
      return new ManifestStore(file, data);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt manifest is never silently replaced — the caller decides.
        if (!(err instanceof SyntaxError)) throw err;
        const backup = `${file}.corrupt-${Date.now()}`;
        await rename(file, backup).catch(() => {});
      }
      return new ManifestStore(file, createManifest({ dir, runId, recipe }));
    }
  }

  get data() { return this.#data; }
  get turnsCompleted() { return this.#data.turnsCompleted ?? 0; }
  get lastMessageId() { return this.#data.lastMessageId ?? null; }
  get artifactCount() { return this.#data.seenIds?.length ?? 0; }

  /** True when this artifact was already written in an earlier turn or run. */
  has(id) { return this.#seen.has(String(id)); }

  /** Record a persisted artifact. Returns false when it was already known. */
  record(artifact) {
    const id = String(artifact.id);
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    // Never store the bytes themselves — a Uint8Array stringifies into a
    // `{"0":..,"1":..}` blob and turns a 2-file manifest into half a megabyte.
    this.#data.artifacts.push({
      id,
      name: artifact.name,
      path: artifact.path,
      bytes: typeof artifact.bytes === 'number' ? artifact.bytes : artifact.bytes?.length ?? 0,
      messageId: artifact.messageId ?? null,
      savedAt: new Date().toISOString(),
    });
    this.#data.seenIds.push(id);
    this.#dirty = true;
    return true;
  }

  noteTurn({ lastMessageId, error = null } = {}) {
    this.#data.turnsCompleted = (this.#data.turnsCompleted ?? 0) + 1;
    if (lastMessageId) this.#data.lastMessageId = lastMessageId;
    this.#data.lastError = error;
    this.#dirty = true;
  }

  async save() {
    this.#data.updatedAt = new Date().toISOString();
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    await rename(tmp, this.#file);          // atomic on the same volume
    this.#dirty = false;
  }

  async saveIfDirty() {
    if (this.#dirty) await this.save();
  }
}

/** Write bytes to `dir/name`, never clobbering an existing file. */
export async function writeArtifact(dir, artifact) {
  await mkdir(dir, { recursive: true });
  const safe = sanitizeFilename(artifact.name);
  const { path } = await uniquePath(dir, safe);
  await writeFile(path, artifact.bytes);
  return { path, bytes: artifact.bytes.length };
}

export function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')   // illegal on Windows, hostile everywhere
    .replace(/^\.+/, '')
    .replace(/\s+$/g, '')
    .slice(0, 180);
  return cleaned || 'artifact';
}

async function uniquePath(dir, name) {
  const ext = name.match(/(\.[^.]{1,16})$/)?.[1] ?? '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 500; i++) {
    const candidate = i === 0 ? join(dir, name) : join(dir, `${stem} (${i})${ext}`);
    try {
      await readFile(candidate);
      continue;                                // exists, try the next suffix
    } catch (err) {
      if (err.code === 'ENOENT') return { path: candidate };
      throw err;
    }
  }
  throw new Error(`could not find a free filename for ${name}`);
}
