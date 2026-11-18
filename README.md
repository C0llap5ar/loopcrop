# loopcrop

**Turn any AI chat web UI into a repeatable prompt loop.**

Send a prompt → wait for the turn to actually finish → harvest the files it produced → send the next prompt. Repeat until a stop condition fires.

No API key. No separate browser. It drives the tab you are already signed into, so your existing subscription, project context and file sandbox all apply.

```
┌─────────────┐   prompt    ┌──────────────┐   files    ┌──────────────┐
│   recipes   │ ──────────▶ │    engine    │ ─────────▶ │    sinks     │
│ (what/when) │             │ (the loop)   │            │ (disk/dl)    │
└─────────────┘             └──────┬───────┘            └──────────────┘
                                   │ status / harvest
                            ┌──────▼───────┐
                            │   adapters   │  ← the only site-specific code
                            │  chatgpt.js  │
                            └──────────────┘
```

---

## Why this exists

Long-running generation tasks — serialized fiction, batch translation, dataset building — have a shape that chat UIs handle badly:

- every round produces files you have to download by hand,
- every round needs the same instruction retyped,
- the model takes minutes per round, so you cannot babysit it,
- and when the tab reloads mid-run you lose track of what is already saved.

`loopcrop` is that missing loop. The fiction preset is just the first recipe; the engine knows nothing about novels.

## What makes it different from a "keep generating" clicker

| | auto-continue scripts | **loopcrop** |
|---|---|---|
| knows when a turn ended | guesses from the DOM | reads the site's own message status |
| collects the output | ❌ | ✅ resolves signed URLs, saves real bytes |
| survives a page reload | ❌ | ✅ manifest dedupes by file id |
| survives a process crash | ❌ | ✅ journal replays completed turns without re-sending |
| remembers the replies | ❌ | ✅ journal keeps full text + blocks + files |
| stops on a condition | count only | markers, patterns, dry streaks, wall clock |
| plans across rounds | one prompt forever | staged works: outline → per-item → review |
| pacing / rate limits | fixed sleep | jittered backoff with error budgets |

## Three front-ends, one core

The engine, adapters, recipes and stop conditions are shared. Only the outer shell differs.

**Userscript** — paste one file, no toolchain. Writes through the browser's download manager.
**CLI** — Node, writes straight to disk, resumable, scriptable. Drives your existing browser through an extension bridge.
**GUI** — `node gui/server.mjs`, then open `http://127.0.0.1:4317`. Three-pane workbench over the same core: journal timeline, stage progress, and the full reply on demand.

The GUI and CLI share one thing the userscript cannot have: a journal on disk. That is
why staged works (`--work`) and crash recovery are Node-only — a browser has nowhere to
append to.

---

## Quick start — userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Open `dist/loopcrop.user.js` and paste it in as a new script.
3. Go to a ChatGPT conversation. A panel appears bottom-right.
4. Press **Start**.

The first run asks your browser to allow multiple downloads. That prompt is a browser policy, not something a script can skip.

## Quick start — CLI

```bash
npm install -g loopcrop     # or: npx loopcrop --help
loopcrop --help
```

The CLI does not launch a browser. It attaches to one you already have open, through an extension bridge exposing:

```
GET  /health   -> { extensionConnected, targets: [...] }
GET  /pair     -> { token }
WS   /ws?role=pi&token=...   { type: "request", id, method, params, target }
```

Verified against [`pi-control-chrome`](https://github.com/lyd123qw2008/pi-control-chrome) 0.8.0. Any bridge with that shape works — the transport is one file, `cli/loop.mjs:openTransport()`.

```bash
# see what a run would do, send nothing
loopcrop --dry-run

# save the current turn's files without sending anything
loopcrop --adopt --out ./chapters

# run the fiction preset
loopcrop --recipe novel --out ./chapters --turns 20

# or run it as staged work: outline → one ask per chapter → continuity pass
loopcrop --work novel --chapters 12 --genre 悬疑 --out ./chapters

# resume: rerun the same command; completed asks replay from the journal, never re-send
```

Every CLI run also writes an append-only journal at `.loopcrop/journal/<run-name>.jsonl`
inside the output directory. Each completed ask records its prompt, duration, full reply
text, content blocks and saved files. On restart, completed sequence numbers are replayed
locally; only unfinished asks are sent. The journal is the progress truth, while the
manifest remains the artifact index.

## Quick start — GUI

```bash
node gui/server.mjs      # or: npm run gui
```

Open `http://127.0.0.1:4317`, press **连接** to probe the bridge and list tabs, then pick
a mode and start. Progress streams over SSE — you can close the tab and the run keeps
going in the Node process.

```bash
# config persists in .loopcrop-gui.json; port comes from the environment
PORT=4318 node gui/server.mjs
```

It is a three-pane workbench over the same core:

| Pane | Holds |
| --- | --- |
| left rail | **产物** (the files this run wrote) or **阶段** (per-stage progress bars) |
| centre | the run form, and the ask timeline — one row per journaled ask |
| bottom | the log, folded away until you open it |

The timeline is the journal. Each row shows its sequence number, the check verdict
(`✓` ok, `↻` retry, `⏸` pause, `✕` abort), the stage and item it belonged to, how long
it took and how many characters came back. Click a row to slide the full reply out from
the right; it renders as plain monospace text, not markdown, because the artifacts are
`.txt` and reformatting them would mangle the prose. Only one reply is open at a time, so
a 600,000-character run never loads itself into the DOM at once.

Search filters on sequence, prompt, stage, filename and the bodies you have already
opened. Bodies are fetched on demand — the list endpoint returns summaries only.

If the reply was a bad one, **重做** truncates the journal to just before that ask and
re-runs from there. The truncated asks are sent again; everything before them replays
from disk.

The GUI can drive either a recipe (one prompt, repeated) or a built-in work
(`--work novel`: outline → chapter by chapter → continuity review). Work mode shows the
stage rail and needs no prompt text at all.

## Recipes

A recipe is `{ name, prompt, stop, outDir }`. `prompt` may be a function of `(turn, state)`.

```js
// my-recipe.mjs
import { anyOf, maxTurns, sawText, noArtifactsFor } from 'loopcrop/core/stops.js'

export default {
  name: 'chapter-outline',
  outDir: './outlines',
  prompt: (turn) => `为第 ${turn} 章写一份细纲，保存成 第${turn}章_细纲.txt`,
  stop: anyOf(sawText('【大纲完】'), noArtifactsFor(3), maxTurns(30)),
}
```

```bash
loopcrop --recipe ./my-recipe.mjs
```

Built in: `novel`, `translate`, `repeat`, `custom`.

### Stop conditions

| condition | fires when |
|---|---|
| `maxTurns(n)` | n turns completed |
| `sawText('全书完', 'THE END')` | the reply's tail contains a marker |
| `sawPattern(/第\s*\d+\s*章.*完$/)` | a regex matches the reply's tail |
| `noArtifactsFor(n)` | n consecutive turns produced no files |
| `tooManyErrors(n)` | n consecutive failures — the site is probably blocking |
| `maxDuration(ms)` | wall-clock budget exhausted |
| `anyOf(...)` | first one to fire wins |

---

## Works — staged runs

A recipe is one prompt repeated. A **work** is ordered stages, and each stage owns its
own source, prompt, check and retry budget. Use `--work` instead of `--recipe`:

```bash
loopcrop --work novel --chapters 12 --genre 悬疑
```

That preset is the honest version of the fiction loop:

| stage | source | prompt | check |
|---|---|---|---|
| `outline` | one item | "写分卷大纲，不要正文" | ≥ 200 chars |
| `body` | one item per chapter | "按大纲写第 {item} 章" | ≥ 800 chars |
| `continuity` | one item | "通读全文，列出冲突" | ≥ 100 chars |

The one-stage `--recipe novel` still exists and still sends `继续` every turn. It works
when the conversation already remembers its own plan; a fresh conversation does not,
which is exactly what the staged form fixes.

### Stage fields

```js
{
  name: 'body',
  source: { dynamic: () => [...], },      // single | list | csv | jsonl | dynamic | function
  prompt: '按大纲写第 {item} 章',           // string with {item} {round} {stage} {total}, or a function
  repeat: 12,                             // how many times to ask per source item
  retry: 1,                               // extra asks allowed when check says retry
  check: { minLength: 800 },              // ok | retry | pause | abort
  done: null,                             // optional early-exit condition for the stage
}
```

### Sources

| source | expands to |
|---|---|
| `{ single: value }` | one item |
| `{ list: [...] }` | one item per element |
| `{ csv: 'text' }` | one item per row, keyed by the header row |
| `{ jsonl: 'text' }` | one item per parsed line |
| `{ dynamic: () => [...] }` | whatever the function returns, including a promise |
| a bare string or array | shorthand for `single` / `list` |

### Checks

A check runs after every ask and returns one of four verdicts:

| verdict | meaning |
|---|---|
| `ok` | accept this round and move on |
| `retry` | spend one retry from `stage.retry`, then give up as `paused` |
| `pause` | stop the run now, keeping everything journaled |
| `abort` | stop and mark the run aborted |

Built-ins: `minLength`, `mustMatch`, `jsonParseable`, `noRefusal`, `hasFile`,
`hasBlock`, plus `allOf` / `anyOf` to combine them. Any check accepts
`onFail: 'pause' | 'abort'` to override the default `retry`.

### Guards

Guards are budgets, not destinations. They are evaluated **between** asks, so an
in-flight turn always finishes and is journaled before the run pauses.

```js
guards: { asks: 40, duration: 3_600_000, artifacts: 0, failures: 3, silence: 5 }
```

`asks` counts journaled asks, `duration` is wall-clock ms, `artifacts` counts files
saved, `failures` counts consecutive send errors, and `silence` counts consecutive asks
that produced no files. A guard ends the run as `paused`, never `failed` — pause means
"come back later", and rerunning the same command resumes from the journal.

### Resuming a work

The resume cursor is derived from the journal, not recomputed from the recipe. Each
journal row records its stage, item, repetition round and retry slot, so a crash
mid-`repeat` resumes at the next round instead of skipping ahead, and a crash inside a
retry budget spends the remaining retry instead of restarting the round. Retries are
budgeted per repetition: `repeat: 3, retry: 1` means three chapters, each allowed one
retry.

---

## Writing an adapter

An adapter is four methods. It runs inside the page, so it inherits the session and may call the site's private endpoints.

```js
{
  probe()                // -> { ok, site, conversationId, url, title }
  send(text)             // -> { ok }        put text in the composer and submit
  status({ sinceId })    // -> { phase: "idle" | "running" | "stalled", lastMessageId, tail, ... }
  harvest({ messageId }) // -> { text, blocks, artifacts: [{ id, name, mime, bytes, messageId, source }] }
                         // a bare artifact array is still accepted for compatibility
}
```

Two rules that are not obvious:

1. **`status` must be authoritative.** Reading "is it typing?" off the DOM produces double-submits, because sites flicker to idle between the thinking phase and the writing phase. Prefer the site's own message status.
2. **`harvest` must return bytes, not links.** Signed download URLs expire and are single-use; fetch them inside the adapter while the session is fresh.

`core/adapters/chatgpt.js` is a full worked example, including why it uses the private conversation API instead of the DOM.

## Repository layout

```
core/
  protocol.js        adapter contract + normalization
  engine.js          the loop — the only file that knows the order of things
  journal.js         append-only ask history + full replies (Node)
  session.js         idempotent ask() / replayable clock, injected by front-ends
  work.js            staged runs: source → prompt → check → retry, resumable
  sources.js         single / list / csv / jsonl / dynamic expansion
  checks.js          ok / retry / pause / abort verdicts
  guards.js          asks / duration / artifacts / failures / silence budgets
  stops.js           stop conditions as pure predicates
  manifest.js        crash-safe run state (Node)
  sinks.js           browser sinks (download, memory)
  sinks-node.js      Node sink (filesystem, atomic, collision-safe)
  adapters/
    chatgpt.js       the only site-specific code
  recipes/index.js   built-in recipes, built-in works + resolvers
cli/                 Node front-end + extension-bridge transport
gui/                 local web front-end
  server.mjs             HTTP + SSE, journal and work wiring
  public/index.html      three-pane shell
  public/app.js          timeline, detail pane, run form
  public/app.css         light theme
userscript/          browser front-end + floating HUD
scripts/
  build-userscript.mjs   inlines the shared core into dist/loopcrop.user.js
dist/                built userscript (committed so users can install without a build)
```

`work.js`, `sources.js`, `checks.js` and `guards.js` are deliberately **not** in the
userscript bundle: the browser build only carries the recipe loop, because a staged
work needs a filesystem-backed journal to resume from.

The build step is a ~90-line dependency-free ESM inliner rather than a bundler, because the module graph is ten files and a lockfile for that is silly.

## Verification

`npm test` runs 56 unit tests with fake adapters, journals and a fake transport — fast,
and they pin the parts that are easy to get subtly wrong: turn accounting, dedupe,
atomic manifest writes, base64 byte handling, stop conditions, journal persistence,
idempotent replay, source expansion, check verdicts, guard budgets, and the work resume
cursor. The 100-ask crash test aborts mid-run, reopens the journal, finishes the run and
asserts every prompt was sent exactly once; a lost manifest is rebuilt from journal
records without re-saving existing files. Two work tests do the same for staged runs: a
crash between rounds resumes at the next round rather than skipping ahead, and a crash
inside a retry budget spends the remaining retry instead of restarting the round.

Three of those tests cover the GUI without a browser: every class the client script
creates must have a CSS rule, every element id it reaches for must exist in the markup,
and no journal body may reach `innerHTML` unescaped. That last one matters because the
reply text comes from a remote model — treating it as markup would make the detail pane
an injection sink.

The live smoke check lives in `live/`, outside the test runner's discovery glob,
because it spends real quota against a real browser and must never run in CI.

Two things unit tests structurally cannot prove, both of which bit during
development:

1. **Does the prompt survive the trip into the page?** The first CLI build called
   `call('send', { text })` against a `send(text)` signature. The page received `{}`,
   typed the literal string `[object Object]` into the composer, and ChatGPT
   politely asked what was meant. `send()` still returned `{ok: true}`, so the loop
   reported success while sending garbage. `test/cli-adapter.test.mjs` now asserts the
   prompt arrives positionally and unchanged — reintroducing the bug fails two tests.
2. **Does a real harvested file contain the real bytes?** `npm run test:live` sends
   one trivial prompt to a live tab, reads the conversation back through the site's
   own API, and compares the user message character-for-character. It costs a few
   seconds of quota.

The send path also verifies the composer actually drained after clicking, because a
click that misses leaves the text in place — and retrying then sends it twice.

## Limitations, stated plainly

- **One conversation per run.** Tab switching mid-run is not modelled.
- **Staged works are a Node-only feature.** The userscript carries the recipe loop, not
  `work.js`, because resuming a stage needs a filesystem journal. Browser users get
  `repeat`, not `--work`.
- **A fresh chat is a supported starting point.** Its conversation id only appears in
  the URL after the first message is accepted, so both `probe()` and `status()` treat
  "no id yet" as a valid state and wait briefly, rather than as an error.
- **Site changes break adapters.** ChatGPT's DOM and private endpoints are not a public API. When they move, `core/adapters/chatgpt.js` needs fixing — nothing else does.
- **The userscript cannot write arbitrary paths.** Browsers route downloads through the download manager, so the folder is whatever the browser chooses plus the configured subdirectory. Use the CLI when the exact path matters.
- **Multiple-download prompts are unavoidable** in the browser build.
- **Quota is yours.** This spends your subscription exactly as if you typed the prompts. It adds no retry budget beyond what the stop conditions let you configure. If harvesting fails after a successful send, that turn is still journaled, so restarting will not spend the same prompt again.

## License

MIT
