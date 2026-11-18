/**
 * Browser-side manifest.
 *
 * The CLI writes a manifest.json next to the files, because a crashed run has to be
 * resumable. A userscript cannot write arbitrary JSON to disk, so it keeps the same
 * shape in GM storage instead — enough to survive a page reload mid-run.
 */

export function createInMemoryManifest() {
  const KEY = 'loopcrop:manifest';
  const load = () => {
    try {
      return typeof GM_getValue === 'function' ? (GM_getValue(KEY, null) ?? null) : null;
    } catch { return null; }
  };
  const persist = () => {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(KEY, data);
    } catch { /* storage may be full or disabled; the loop still works this session */ }
  };

  let data = load() ?? {
    version: 1,
    turnsCompleted: 0,
    lastMessageId: null,
    seenIds: [],
    artifacts: [],
  };
  const seen = new Set(data.seenIds ?? []);

  return {
    get data() { return data; },
    get turnsCompleted() { return data.turnsCompleted ?? 0; },
    get lastMessageId() { return data.lastMessageId ?? null; },
    get artifactCount() { return seen.size; },
    has: (id) => seen.has(String(id)),
    record(artifact) {
      const id = String(artifact.id);
      if (seen.has(id)) return false;
      seen.add(id);
      data.seenIds.push(id);
      data.artifacts.push({ id, name: artifact.name, bytes: artifact.bytes, savedAt: new Date().toISOString() });
      persist();
      return true;
    },
    noteTurn({ lastMessageId, error = null } = {}) {
      data.turnsCompleted = (data.turnsCompleted ?? 0) + 1;
      if (lastMessageId) data.lastMessageId = lastMessageId;
      data.lastError = error;
      persist();
    },
    async save() { persist(); },
    async saveIfDirty() { persist(); },
  };
}
