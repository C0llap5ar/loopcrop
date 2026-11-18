/** Minimal argv parser — no dependency, no surprises. */
export function parseArgs(argv) {
  const out = {};
  const takesValue = new Set([
    'tab', 'recipe', 'out', 'turns', 'between', 'jitter', 'poll',
    'stall-min', 'bridge-host', 'bridge-port',
    'work', 'genre', 'chapters', 'max-asks',
  ]);
  const flags = new Set(['dry-run', 'adopt', 'json', 'quiet', 'help']);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (flags.has(key)) { out[camel(key)] = true; continue; }
    if (takesValue.has(key)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      if (['turns', 'between', 'jitter', 'poll', 'stall-min', 'bridge-port', 'chapters', 'max-asks'].includes(key)) {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${value}"`);
        out[camel(key)] = n;
      } else {
        out[camel(key)] = value;
      }
      continue;
    }
    throw new Error(`unknown option --${key}`);
  }
  return out;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
