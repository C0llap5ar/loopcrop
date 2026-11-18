/**
 * loopcrop — adapter protocol v1
 *
 * An *adapter* is the only site-specific piece. It runs **inside the chat page**
 * (same origin), so it can touch the DOM and call the site's own private APIs with
 * the user's real session.
 *
 * It is deliberately tiny: 4 methods. Everything else — the loop, the pacing, the
 * dedupe, the disk writes, the stop conditions — lives in transport-agnostic code
 * (`core/engine.js`) so a single adapter is all it takes to support a new site.
 *
 * ── Contract ───────────────────────────────────────────────────────────────────
 *
 *  probe()                -> { ok, site, conversationId, url, title, model? }
 *      Cheap, side-effect free. Answers "am I on a page I understand?".
 *
 *  send(text)             -> { ok }
 *      Put `text` in the composer and submit it. Must go through the real UI path
 *      (native input events) so the site's own state machine updates.
 *
 *  status({ sinceId })    -> TurnStatus
 *      Read the authoritative turn state. `phase` is one of:
 *        "idle"       nothing running, last turn is settled
 *        "running"    the model is still producing
 *        "stalled"    no progress for longer than `stallMs` (caller decides)
 *      `lastMessageId` identifies the newest assistant message; `sinceId` lets the
 *      adapter return only what changed.
 *
 *  harvest({ messageId }) -> Artifact[]
 *      Everything the assistant produced that is worth persisting. The adapter
 *      resolves them to real bytes (see Artifact.bytes).
 *
 * ── TurnStatus ─────────────────────────────────────────────────────────────────
 *   {
 *     phase: "idle" | "running" | "stalled",
 *     lastMessageId: string | null,
 *     lastMessageAt: number | null,   // epoch ms
 *     model: string | null,
 *     textLength: number,             // chars in the newest assistant message
 *     tail: string,                   // last ~200 chars, for logging / stop rules
 *     error?: string
 *   }
 *
 * ── Artifact ───────────────────────────────────────────────────────────────────
 *   {
 *     id: string,            // stable for dedupe — prefer the site's own file id
 *     name: string,          // filename as the model named it
 *     mime: string,
 *     bytes: Uint8Array,     // the real content, already fetched
 *     messageId: string,
 *     source: string         // human-readable origin, for logs
 *   }
 *
 * Adapters never write to disk and never decide when to stop. They answer four
 * questions and stay out of the way.
 */

export const PROTOCOL_VERSION = 1;

export const REQUIRED_METHODS = Object.freeze(['probe', 'send', 'status', 'harvest']);

export const PHASES = Object.freeze(['idle', 'running', 'stalled']);

/** Validate an adapter before the engine trusts it with a conversation. */
export function validateAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, problems: ['adapter is not an object'] };
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') problems.push(`missing method: ${method}`);
  }
  if (typeof adapter.id !== 'string' || !adapter.id) problems.push('missing string field: id');
  if (typeof adapter.displayName !== 'string') problems.push('missing string field: displayName');
  if (adapter.protocolVersion !== undefined && adapter.protocolVersion !== PROTOCOL_VERSION) {
    problems.push(`protocolVersion ${adapter.protocolVersion} != ${PROTOCOL_VERSION}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Normalize whatever an adapter returned into a TurnStatus the engine can act on. */
export function normalizeStatus(raw) {
  const phase = PHASES.includes(raw?.phase) ? raw.phase : 'idle';
  return {
    phase,
    lastMessageId: raw?.lastMessageId ?? null,
    lastMessageAt: Number.isFinite(raw?.lastMessageAt) ? raw.lastMessageAt : null,
    model: raw?.model ?? null,
    textLength: Number.isFinite(raw?.textLength) ? raw.textLength : 0,
    tail: typeof raw?.tail === 'string' ? raw.tail : '',
    error: raw?.error,
  };
}

/**
 * Turn an adapter's harvest output into artifacts the sink can persist,
 * dropping anything malformed instead of crashing mid-run.
 *
 * Bytes arrive in one of two shapes:
 *   Uint8Array  — userscript path, same realm, no serialization
 *   base64      — CLI path, the value crossed a CDP boundary where typed arrays
 *                 degrade into plain objects
 * Both are normalized to Uint8Array so sinks only ever see one thing.
 */
export function normalizeArtifacts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.name !== 'string' || !a.name) continue;

    let bytes = null;
    if (a.bytes instanceof Uint8Array) {
      bytes = a.bytes;
    } else if (typeof a.bytes === 'string') {
      bytes = base64ToBytes(a.bytes);
    }
    if (!bytes) continue;

    out.push({
      id: String(a.id ?? a.name),
      name: a.name,
      mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
      bytes,
      messageId: a.messageId == null ? null : String(a.messageId),
      source: typeof a.source === 'string' ? a.source : 'unknown',
    });
  }
  return out;
}

/**
 * Normalize whatever an adapter's `harvest` returned into the three things the
 * engine now persists: the full reply text, its structural blocks, and the
 * artifacts.
 *
 * Backward compatible: an adapter that still returns a bare `Artifact[]` is treated
 * as "no text, no blocks". A newer adapter returns `{ text, blocks, artifacts }`.
 */
export function normalizeHarvest(raw) {
  if (Array.isArray(raw)) {
    return { text: '', blocks: [], artifacts: normalizeArtifacts(raw) };
  }
  return {
    text: typeof raw?.text === 'string' ? raw.text : '',
    blocks: Array.isArray(raw?.blocks) ? raw.blocks : [],
    artifacts: normalizeArtifacts(raw?.artifacts),
  };
}

export function base64ToBytes(b64) {
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}
