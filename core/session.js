/**
 * Session — the idempotent ask boundary.
 *
 * This is the one place that decides "have we already done this ask?" and, if so,
 * hands back the recorded result instead of sending again. It is deliberately free
 * of any Node built-in: the *journal* is injected, so a userscript can pass null and
 * get a session that always asks, while the CLI/GUI pass a real `Journal` and get
 * crash-safe replay.
 *
 *   const session = createSession({ journal });
 *   const { event, replayed } = await session.ask(12, '继续', doAsk);
 *   // replayed === true  -> doAsk was NOT called; `event` is the prior result
 *   // replayed === false -> doAsk ran; `event` is the freshly recorded result
 *
 * The seq is the idempotence key. "Idempotent" here means precisely: **a prompt is
 * sent at most once per seq**. If doAsk throws (send failed, or sent-but-harvest
 * failed), nothing is recorded, and the next run re-issues that seq — the correct
 * recovery, because the result of that ask was never captured.
 */

export function createSession({ journal = null, now = () => Date.now() } = {}) {
  return {
    /** Replayable clock. Work that stamps time must use this, not Date.now(). */
    now,

    /** Highest completed ask, or 0. The engine resumes at this + 1. */
    maxSeq: () => journal?.maxSeq?.() ?? 0,

    /** The recorded event for an ask, or null. */
    get: (seq) => journal?.get?.(seq) ?? null,

    /**
     * Run `doAsk` at most once for `seq`.
     *
     * @param {number} seq    1-based ask number
     * @param {string} prompt what is about to be sent (recorded verbatim)
     * @param {() => Promise<object>} doAsk  performs send→settle→harvest, returns
     *        { messageId, dur, text, blocks, files, artifacts, saved }
     * @returns {Promise<{ event: object, replayed: boolean }>}
     */
    async ask(seq, prompt, doAsk) {
      const cached = journal?.get?.(seq) ?? null;
      if (cached) return { event: cached, replayed: true };

      const {
        messageId = null,
        dur = null,
        text = '',
        blocks = [],
        files = [],
        artifacts = 0,
        saved = 0,
        ...rest
      } = await doAsk();

      const event = {
        v: 2,
        t: 'ask',
        seq,
        prompt,
        at: now(),
        messageId,
        dur,
        text,
        blocks,
        files,
        artifacts,
        saved,
        ...rest,
      };

      await journal?.append?.(event);
      return { event, replayed: false };
    },
  };
}
