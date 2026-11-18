/**
 * Journal — the run's progress truth, append-only.
 *
 * Where the manifest records "which files are on disk", the journal records "what
 * actually happened": one line per completed ask, with the prompt that was sent,
 * the full reply text, and the files it produced. It is the thing that makes a
 * crashed run resumable *without re-sending a prompt that already ran*.
 *
 * Shape of a line (one JSON object per line, written atomically-ish by append):
 *   {
 *     "v": 2,
 *     "t": "ask",
 *     "seq": 12,              // 1-based ask number == the turn number
 *     "prompt": "继续",        // exactly what was sent
 *     "at": 1730000000000,    // session.now() at completion (replayable clock)
 *     "messageId": "abc123",  // the assistant message the reply came from
 *     "dur": 432000,          // ms from send-start to settled
 *     "text": "……",           // full reply body, kept verbatim
 *     "blocks": [ … ],        // structural blocks of the reply
 *     "files": [ … ],         // { id, name, path, bytes } that were persisted
 *     "artifacts": 3,         // count seen this turn (saved + already-known)
 *     "saved": 2              // count newly written this turn
 *   }
 *
 * The seq is the idempotence key: `Journal.get(seq)` answers "has this ask already
 * completed?". A turn that *sent* but failed to *harvest* never reaches here, so on
 * restart it is re-sent — which is correct, because its result was lost.
 *
 * This file is Node-only (`node:fs`). It must never be imported by anything in the
 * userscript bundle; the engine reaches it only through an injected `session`.
 */

import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const JOURNAL_VERSION = 2;

/** A workId becomes a filename fragment, so it must not be able to leave the dir. */
function workIdToFile(workId) {
  const cleaned = String(workId || 'default')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/g, '')
    .slice(0, 180);
  return cleaned || 'default';
}

/**
 * Append-only jsonl store keyed by ask seq.
 *
 * The file is read once at open into an in-memory `Map<seq, event>`. For the sizes
 * this tool produces (hundreds of asks, ~20k chars each) that is a few MB at most
 * and makes `get` / `maxSeq` O(1).
 */
export class Journal {
  #file;
  #workId;
  #events;

  constructor(file, workId, events) {
    this.#file = file;
    this.#workId = workId;
    this.#events = events;
  }

  static async open({ dir, workId }) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${workIdToFile(workId)}.jsonl`);
    const events = new Map();
    try {
      const raw = await readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (Number.isInteger(ev?.seq)) events.set(ev.seq, ev);
        } catch {
          // A torn write can leave a partial final line. Skip it; the next append
          // rewrites the tail and the run resumes from the last whole event.
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return new Journal(file, workId, events);
  }

  get file() { return this.#file; }
  get workId() { return this.#workId; }

  /** The event for an ask, or null when that seq has no completed record. */
  get(seq) { return this.#events.get(Number(seq)) ?? null; }

  /** Highest completed seq, or 0 when the journal is empty. */
  maxSeq() {
    let m = 0;
    for (const s of this.#events.keys()) m = Math.max(m, s);
    return m;
  }

  size() { return this.#events.size; }

  /** All events in seq order. */
  all() {
    return [...this.#events.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * Lightweight rows for a list view — deliberately omits `text` and `blocks`, so a
   * 600k-char journal can be summarised without shipping every body over the wire.
   */
  summaries() {
    return this.all().map((ev) => ({
      seq: ev.seq,
      prompt: ev.prompt ?? '',
      at: ev.at ?? null,
      dur: ev.dur ?? null,
      messageId: ev.messageId ?? null,
      textLength: typeof ev.text === 'string' ? ev.text.length : 0,
      files: (ev.files ?? []).map((f) => ({ name: f.name, bytes: f.bytes })),
      artifacts: ev.artifacts ?? 0,
      saved: ev.saved ?? 0,
      // Work annotations. They are absent on plain recipe runs, which is fine — the
      // timeline just renders a flat list of asks in that case.
      stage: ev.stage ?? null,
      stageIndex: ev.stageIndex ?? null,
      itemIndex: ev.itemIndex ?? null,
      itemId: ev.itemId ?? null,
      round: ev.round ?? null,
      tryIndex: ev.tryIndex ?? null,
      check: ev.check ?? null,
      checkReason: ev.checkReason ?? null,
    }));
  }

  /** Append one event. seq must be the newest; duplicates overwrite the in-memory copy. */
  async append(event) {
    this.#events.set(Number(event.seq), event);
    await appendFile(this.#file, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /**
   * Drop every event past `seq` and rewrite the file. Redo = truncate + append, so
   * there is exactly one linear history and no branch tree.
   */
  async truncateTo(seq) {
    const kept = this.all().filter((ev) => ev.seq <= seq);
    const tmp = `${this.#file}.tmp`;
    const body = kept.map((ev) => JSON.stringify(ev)).join('\n');
    await writeFile(tmp, body ? `${body}\n` : '', 'utf8');
    await rename(tmp, this.#file);           // atomic on the same volume
    const events = new Map();
    for (const ev of kept) events.set(ev.seq, ev);
    this.#events = events;
  }
}
