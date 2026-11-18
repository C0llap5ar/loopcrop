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
| stops on a condition | count only | markers, patterns, dry streaks, wall clock |
| pacing / rate limits | fixed sleep | jittered backoff with error budgets |

## Three front-ends, one core

The engine, adapters, recipes and stop conditions are shared. Only the outer shell differs.

**Userscript** — paste one file, no toolchain. Writes through the browser's download manager.
**CLI** — Node, writes straight to disk, resumable, scriptable. Drives your existing browser through an extension bridge.
**GUI** — `node gui/server.mjs`, then open `http://127.0.0.1:4317`. Same engine and bridge, but you pick the tab and type the prompt in a form instead of a terminal.

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

# resume: rerun the same command, the manifest skips what is already on disk
```

## Quick start — GUI

```bash
node gui/server.mjs      # or: npm run gui
```

Open `http://127.0.0.1:4317`, press **连接** to probe the bridge and list tabs, pick one, type the prompt, press **开始**. Progress streams over SSE — you can close the tab and the run keeps going in the Node process.

The GUI is the same engine as the CLI. The prompt box is the recipe: whatever you type is sent every turn, with `{turn}` substituted for the turn number. Stop it with **停止**, or set a turn count.

```bash
# config persists in .loopcrop-gui.json; port comes from the environment
PORT=4318 node gui/server.mjs
```

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

## Writing an adapter

An adapter is four methods. It runs inside the page, so it inherits the session and may call the site's private endpoints.

```js
{
  probe()                // -> { ok, site, conversationId, url, title }
  send(text)             // -> { ok }        put text in the composer and submit
  status({ sinceId })    // -> { phase: "idle" | "running" | "stalled", lastMessageId, tail, ... }
  harvest({ messageId }) // -> [{ id, name, mime, bytes, messageId, source }]
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
  stops.js           stop conditions as pure predicates
  manifest.js        crash-safe run state (Node)
  sinks.js           browser sinks (download, memory)
  sinks-node.js      Node sink (filesystem, atomic, collision-safe)
  adapters/
    chatgpt.js       the only site-specific code
  recipes/index.js   built-in recipes + resolver
cli/                 Node front-end + extension-bridge transport
gui/                 local web front-end (server + static UI, SSE)
userscript/          browser front-end + floating HUD
scripts/
  build-userscript.mjs   inlines the shared core into dist/loopcrop.user.js
dist/                built userscript (committed so users can install without a build)
```

The build step is a ~90-line dependency-free ESM inliner rather than a bundler, because the module graph is ten files and a lockfile for that is silly.

## Verification

`npm test` runs 26 unit tests with a fake adapter and a fake transport — fast, and
they pin the parts that are easy to get subtly wrong: turn accounting, dedupe,
atomic manifest writes, base64 byte handling, stop conditions.

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
- **A fresh chat is a supported starting point.** Its conversation id only appears in
  the URL after the first message is accepted, so both `probe()` and `status()` treat
  "no id yet" as a valid state and wait briefly, rather than as an error.
- **Site changes break adapters.** ChatGPT's DOM and private endpoints are not a public API. When they move, `core/adapters/chatgpt.js` needs fixing — nothing else does.
- **The userscript cannot write arbitrary paths.** Browsers route downloads through the download manager, so the folder is whatever the browser chooses plus the configured subdirectory. Use the CLI when the exact path matters.
- **Multiple-download prompts are unavoidable** in the browser build.
- **Quota is yours.** This spends your subscription exactly as if you typed the prompts. It adds no retry budget beyond what the stop conditions let you configure.

## License

MIT
