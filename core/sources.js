/** Turn a stage's declarative source into a finite list of work items. */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = String(text ?? '').replace(/\r\n/g, '\n');
  for (let i = 0; i <= input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch == null) {
      row.push(cell); cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  const headers = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/**
 * A caller may hand back items that are already in `{id, value}` form — a dynamic
 * source returning `[{id:'1', value:1}]` is the obvious way to write one. Re-wrapping
 * those would nest the payload (`{id:'1', value:{id:'1',value:1}}`) and make
 * `{item}` interpolate as JSON. Shape check, not identity check, so both forms work.
 */
const isItem = (v) => v && typeof v === 'object' && !Array.isArray(v)
  && 'id' in v && 'value' in v;

/** @returns {Promise<Array<{id:string, value:any}>>} */
export async function expandSource(source, ctx = {}) {
  if (source == null) return [{ id: '1', value: null }];
  if (typeof source === 'string') return [{ id: source, value: source }];
  if (Array.isArray(source)) {
    return source.map((value, i) => (isItem(value)
      ? { id: String(value.id), value: value.value }
      : { id: String(value?.id ?? i + 1), value }));
  }
  if (typeof source === 'function') return expandSource(await source(ctx), ctx);
  if (typeof source.dynamic === 'function') return expandSource(await source.dynamic(ctx), ctx);
  if (source.dynamic != null) return expandSource(source.dynamic, ctx);
  if (source.single != null) return [{ id: String(source.id ?? '1'), value: source.single }];
  if (source.list) return expandSource(source.list, ctx);
  if (source.csv != null) return expandSource(parseCsv(source.csv), ctx);
  if (source.jsonl != null) {
    return expandSource(String(source.jsonl).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse), ctx);
  }
  throw new Error('source must be single, list, csv, jsonl or dynamic');
}
