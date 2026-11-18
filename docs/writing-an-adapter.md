# Writing a new adapter

The engine knows nothing about any website. Everything site-specific lives in one
file that implements four methods. This is the whole contract.

## The four methods

```js
{
  probe()                // -> { ok, site, conversationId, url, title }
  send(text)             // -> { ok }
  status({ sinceId })    // -> { phase, lastMessageId, tail, ... }
  harvest({ messageId }) // -> [{ id, name, mime, bytes, messageId, source }]
}
```

`phase` is `"idle"`, `"running"` or `"stalled"`. `bytes` may be a `Uint8Array` or a
base64 string; the engine normalizes both.

## The two things people get wrong

### 1. `status` must be authoritative, not visual

Reading "is it still typing?" off the DOM looks easy and produces double-submits.
Chat sites flicker to a non-streaming appearance between the thinking phase and the
writing phase, and between tool calls. If `status` reports idle during one of those
gaps, `send` runs while a turn is in flight and you get two prompts merged into one
reply — or one prompt silently dropped.

Prefer the site's own message state. If the site exposes a conversation API at all,
that API already knows which message is current and whether it settled.

Falling back to the DOM is fine, but then you need a debounce: report idle only
after the DOM has looked idle for a couple of seconds. `engine.js` does a settle pass
too, but defence in depth is cheap here.

### 2. `harvest` must return bytes, not links

Download URLs handed out by a chat UI are signed and short-lived. Collecting the URLs
and downloading later fails on long runs. Fetch the bytes inside `harvest`, while the
session and the signature are both still valid.

The second trap: chat UIs render files as small cards, but the underlying message
payload is what actually names them. In ChatGPT the artifacts are markdown
`sandbox:` links inside the message text — the cards are rendered *from* those links.
Query the DOM for download buttons and you miss every file that scrolled out of the
virtualised message list.

## Getting the page context right

Adapters run **inside the page**, so:

- `fetch` is the page's `fetch` — same cookies, same origin, no CORS.
- `location` is the page's URL, which is often where the conversation id lives.
- There is no `require`, no `node:fs`, no `process`.

## Validation

```js
import { validateAdapter } from '../core/protocol.js'
const report = validateAdapter(myAdapter)
if (!report.ok) console.error(report.problems)
```

## Testing without a browser

The engine is transport-agnostic, so you can test a whole loop against a fake
adapter and a memory sink. See `test/engine.test.mjs` — it exercises settling,
dedupe, retries and stop conditions without touching a network.

That is the recommended way to develop an adapter's *logic*: get the state machine
right against a fake, then swap in the real page calls.
