/** Terminal logging with a stable, greppable shape. */
export function createLogger({ quiet = false, json = false } = {}) {
  const stamp = () => new Date().toTimeString().slice(0, 8);

  const emit = (level, msg, extra) => {
    if (quiet && level === 'info') return;
    if (json) {
      process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
      return;
    }
    const tag = level === 'info' ? '·' : level === 'warn' ? '!' : 'x';
    process.stdout.write(`${stamp()} ${tag} ${msg}\n`);
  };

  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    turn: (n, info) => emit('info', `turn ${n} settled · ${info.saved} new file(s) of ${info.artifacts} seen`, { turn: n, ...info }),
    /** Stage progress for `--work`; the seq is the durable identity of this ask. */
    work: ({ stage, itemId, seq, event, result }) => {
      const chars = typeof event?.text === 'string' ? `${event.text.length} ch` : 'no text';
      const files = event?.files?.length ?? 0;
      const dur = event?.dur ? `${Math.round(event.dur / 1000)}s` : '?';
      emit('info', `[${stage}] item ${itemId} · ask #${seq} · ${dur} · ${chars} · ${files} file(s)`, {
        stage, itemId, seq, files, resultCode: result?.code,
      });
    },
    summary: (r) => {
      if (json) { emit('info', 'summary', { result: r }); return; }
      process.stdout.write('\n' + '─'.repeat(52) + '\n');
      process.stdout.write(`  ${r.code}${r.reason ? ` — ${r.reason}` : ''}\n`);
      process.stdout.write(`  turns: ${r.turnsCompleted}   files: ${r.artifactsThisRun}   time: ${Math.round(r.durationMs / 60000)} min\n`);
      if (r.saved?.length) {
        process.stdout.write('  saved:\n');
        for (const f of r.saved.slice(-20)) process.stdout.write(`    ${f.name} (${f.bytes} B)\n`);
      }
      process.stdout.write('─'.repeat(52) + '\n');
    },
  };
}
