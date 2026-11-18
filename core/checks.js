/**
 * Declarative response checks. A check never sends or retries by itself: it returns
 * one of four instructions and leaves that decision to the work driver.
 */

const REFUSAL = /(?:as an ai|i can(?:not|'t)|i won(?:'t|'t)|无法|不能|抱歉|对不起)/i;

function result(status, reason, extra = {}) {
  return { status, reason: reason ?? null, ...extra };
}

function matcher(re) {
  if (re instanceof RegExp) return new RegExp(re.source, re.flags.replace(/g/g, ''));
  return new RegExp(String(re));
}

/** Evaluate one check (or a short-form `{ minLength: 100 }` object). */
export async function evaluateCheck(check, ctx) {
  if (!check) return result('ok');
  if (typeof check === 'function') return normalizeCheck(await check(ctx));
  if (check.allOf || check.anyOf) {
    const any = Boolean(check.anyOf);
    const list = check.allOf ?? check.anyOf;
    const results = [];
    for (const child of list) results.push(await evaluateCheck(child, ctx));
    const status = any
      ? (results.some((r) => r.status === 'ok') ? 'ok' : (results.find((r) => r.status !== 'ok')?.status ?? 'ok'))
      : (results.find((r) => r.status !== 'ok')?.status ?? 'ok');
    return result(status, results.find((r) => r.status === status)?.reason, { results });
  }
  if (typeof check === 'string') return result(matcher(check).test(ctx.event?.text ?? '') ? 'ok' : 'retry', `reply did not match ${check}`);

  const text = String(ctx.event?.text ?? '');
  if (check.minLength != null && text.length < check.minLength) {
    return result(check.onFail ?? 'retry', `reply has ${text.length} chars; need ${check.minLength}`);
  }
  if (check.mustMatch && !matcher(check.mustMatch).test(text)) {
    return result(check.onFail ?? 'retry', `reply did not match ${check.mustMatch}`);
  }
  if (check.jsonParseable) {
    try { JSON.parse(text); } catch (err) { return result(check.onFail ?? 'retry', `reply is not JSON: ${err.message}`); }
  }
  if (check.noRefusal && REFUSAL.test(text)) return result(check.onFail ?? 'retry', 'reply looks like a refusal');
  if (check.hasFile && !(ctx.event?.files?.length > 0)) return result(check.onFail ?? 'retry', 'reply produced no saved file');
  if (check.hasBlock) {
    const blocks = ctx.event?.blocks ?? [];
    const wanted = check.hasBlock;
    const found = typeof wanted === 'string'
      ? blocks.some((b) => b?.type === wanted || b?.kind === wanted)
      : blocks.length > 0;
    if (!found) return result(check.onFail ?? 'retry', `reply has no ${typeof wanted === 'string' ? wanted : 'content'} block`);
  }
  return result('ok');
}

function normalizeCheck(raw) {
  if (raw == null || raw === true) return result('ok');
  if (raw === false) return result('retry', 'check returned false');
  if (typeof raw === 'string' && ['ok', 'retry', 'pause', 'abort'].includes(raw)) return result(raw);
  if (raw.status && ['ok', 'retry', 'pause', 'abort'].includes(raw.status)) return raw;
  throw new Error(`invalid check result: ${JSON.stringify(raw)}`);
}

export { evaluateCheck as check };
