/**
 * Config for the userscript front-end: defaults, then whatever the user stored via
 * GM_setValue, then anything in the URL hash (handy for one-off runs).
 */

const DEFAULTS = {
  recipe: 'novel',
  outDir: './chapters',
  subdir: 'loopcrop',
  maxTurns: 40,
  pollMs: 2500,
  betweenTurnsMs: 5000,
  jitterMs: 3000,
  stallMin: 20,
};

export async function loadConfig() {
  const stored = readStored();
  const fromHash = readHash();
  return { ...DEFAULTS, ...stored, ...fromHash };
}

function readStored() {
  try {
    if (typeof GM_getValue !== 'function') return {};
    return JSON.parse(GM_getValue('loopcrop:config', '{}')) ?? {};
  } catch { return {}; }
}

export function saveConfig(patch) {
  try {
    if (typeof GM_setValue !== 'function') return;
    const cur = readStored();
    GM_setValue('loopcrop:config', JSON.stringify({ ...cur, ...patch }));
  } catch { /* ignore unavailable storage */ }
}

function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h.includes('loopcrop')) return {};
  const out = {};
  for (const part of h.split('&')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    if (k.startsWith('pl.')) out[k.slice(3)] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}
