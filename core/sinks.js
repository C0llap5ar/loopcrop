/**
 * Browser-side sinks. No Node built-ins may be imported from this file — it is
 * bundled into the userscript, where `node:fs` does not exist.
 *
 * Two ship in the box: `downloadSink` (routes through the browser's download
 * manager) and `memorySink` (for dry runs and tests). The engine never knows which
 * one it got.
 */

/**
 * Hand the bytes to the browser's download manager.
 *
 * Browsers rate-limit programmatic downloads — Chrome/Edge ask "allow multiple
 * downloads?" the first time. That prompt is unavoidable from a userscript, so it
 * is documented rather than worked around.
 */
export function createDownloadSink({ subdir = 'loopcrop', logger = console } = {}) {
  return {
    kind: 'download',
    async save(artifact) {
      const label = `${subdir}/${artifact.name}`.replace(/\/+/g, '/');
      const blob = new Blob([artifact.bytes], { type: artifact.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifact.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the download manager time to start before the blob is revoked.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      logger.info?.(`download started: ${label} (${artifact.bytes.length} B)`);
      return { path: label, bytes: artifact.bytes.length };
    },
  };
}

/** Sink that remembers instead of writing — for dry runs and tests. */
export function createMemorySink() {
  const files = [];
  return {
    kind: 'memory',
    files,
    async save(artifact) {
      files.push({ name: artifact.name, bytes: artifact.bytes.length });
      return { path: `memory://${artifact.name}`, bytes: artifact.bytes.length };
    },
  };
}
