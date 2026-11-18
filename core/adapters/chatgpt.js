/**
 * chatgpt adapter — v1
 *
 * Everything site-specific about ChatGPT in one file. It runs **inside the page**, so
 * it inherits the user's real session and can use the site's own private endpoints.
 *
 * Why private endpoints instead of the DOM for reads and downloads:
 *   • The message list is virtualised — older turns scroll out of existence, so
 *     hunting for "download" buttons silently misses everything above the fold.
 *   • The download button is a two-hop signed-URL fetch. Calling the first hop
 *     ourselves yields a `download_url` whose bytes we can hold, verify and write,
 *     instead of a browser download we cannot observe.
 *   • Message identity and completion status are already in the API payload, so
 *     "is it still typing?" never has to be inferred from pixels.
 *
 * ⚠ SELF-CONTAINMENT REQUIREMENT
 *   The CLI serialises this factory with `Function.prototype.toString()` and injects
 *   it into the page. Therefore it must not close over module scope: every constant
 *   and helper lives *inside* the function body. If you move something out, the CLI
 *   path breaks while the userscript path keeps working — the worst kind of bug.
 *
 * Measured against Edge 157 / ChatGPT 2026-11. When the site changes, only this
 * file needs fixing; the engine, sinks and recipes stay untouched.
 */

export function createChatGptAdapter(options) {
  // ── constants (inside on purpose, see SELF-CONTAINMENT above) ──────────────
  const OPTS = options || {};
  const LOGGER = OPTS.logger || (typeof console !== 'undefined' ? console : { info() {}, warn() {} });
  const PROTOCOL_VERSION = 1;

  /**
   * How to hand bytes back.
   *
   * "typed"  → a real Uint8Array (userscript: the sink writes a Blob directly)
   * "base64" → a JSON-safe string (CLI: the value crosses a CDP boundary, and a
   *            Uint8Array degrades to `{"0":1,"1":2,...}` there — huge and lossy)
   */
  const BYTES_MODE = OPTS.serializeBytes === 'base64' ? 'base64' : 'typed';

  function toBase64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }


  const API = {
    session: '/api/auth/session',
    conversation: (id) => '/backend-api/conversation/' + id,
    interpreterDownload: (convId, messageId, sandboxPath) =>
      '/backend-api/conversation/' + convId + '/interpreter/download'
      + '?download_intent=true'
      + '&message_id=' + encodeURIComponent(messageId)
      + '&sandbox_path=' + encodeURIComponent(sandboxPath),
  };

  /** Localised aria-labels accepted as "the send button". */
  const SEND_LABELS = /^(send|发送|送信|보내기|enviar|envoyer|senden)$/i;
  const STOP_LABELS = /^(stop|停止|停止生成|停止响应|中止|中断)/i;
  const SANDBOX_LINK = /\[([^\]]*)\]\(sandbox:([^)]+)\)/g;

  let cachedToken = null;
  let cachedTokenExpiry = 0;

  // ── helpers ────────────────────────────────────────────────────────────────

  function conversationId() {
    const g = location.pathname.match(/\/g\/[^/]+\/c\/([0-9a-f-]{16,})/i);
    if (g) return g[1];
    const m = location.pathname.match(/\/c\/([0-9a-f-]{16,})/i);
    return m ? m[1] : null;
  }

  async function authToken() {
    const now = Date.now();
    if (cachedToken && now < cachedTokenExpiry - 60_000) return cachedToken;
    const s = await fetch(API.session, { credentials: 'include' }).then((r) => r.json());
    if (!s || !s.accessToken) {
      throw new Error('not signed in — /api/auth/session returned no accessToken');
    }
    cachedToken = s.accessToken;
    cachedTokenExpiry = s.expires ? Date.parse(s.expires) : now + 10 * 60_000;
    return cachedToken;
  }

  async function apiGet(url) {
    const token = await authToken();
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'include',
    });
    if (!r.ok) throw new Error('GET ' + url.split('?')[0] + ' -> HTTP ' + r.status);
    return r;
  }

  function composer() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
  }

  function findButton(re) {
    const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
    // Exact aria-label first, then data-testid, so a stray "Stop generating" in the
    // sidebar can never shadow the composer's own button.
    const byAria = btns.filter((b) => re.test((b.getAttribute('aria-label') || '').trim()));
    const visible = byAria.filter((b) => b.offsetParent !== null);
    if (visible.length) return visible[0];
    if (byAria.length) return byAria[0];
    return btns.find((b) => re.test(b.getAttribute('data-testid') || '')) || null;
  }

  function isStreaming() {
    const stop = findButton(STOP_LABELS);
    if (stop && !stop.disabled && stop.offsetParent !== null) return true;
    const c = composer();
    if (c && c.getAttribute('contenteditable') === 'false') return true;
    return false;
  }

  function textOf(message) {
    const parts = (message && message.content && message.content.parts) || [];
    return parts.map((p) => (typeof p === 'string' ? p : '')).join('');
  }

  // ── adapter ────────────────────────────────────────────────────────────────

  return {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    protocolVersion: PROTOCOL_VERSION,

    probe() {
      const id = conversationId();
      const box = composer();
      // A brand-new chat lives at /?model=... and has no id yet — the id appears in
      // the URL only after the first message is sent. Requiring it here would make
      // the tool unable to start a fresh conversation, which is the common case.
      return {
        ok: Boolean(box) && /(^|\.)chatgpt\.com$/.test(location.host),
        site: 'chatgpt',
        conversationId: id,
        isNewChat: !id,
        url: location.href,
        title: document.title,
      };
    },

    async send(text) {
      const box = composer();
      if (!box) throw new Error('composer not found — is the chat fully loaded?');
      if (isStreaming()) throw new Error('a turn is still running; refusing to queue another prompt');

      box.focus();
      // Replace the contents through the native input path. execCommand keeps
      // ProseMirror's internal document in sync; writing innerHTML does not, and the
      // site then submits an empty message.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
      document.execCommand('insertText', false, text);

      // The send button is rendered by React only after the first character lands.
      // Measured on Edge 157 / ChatGPT 2026-11: ~600 ms. Poll instead of guessing.
      const deadline = Date.now() + 4000;
      let btn = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const typed = (box.innerText || '').trim();
        if (!typed) throw new Error('composer stayed empty after typing');
        btn = findButton(SEND_LABELS);
        if (btn && !btn.disabled) break;
        btn = null;
      }

      if (btn) {
        btn.click();
      } else {
        // Fallback for localised builds whose label is not in SEND_LABELS.
        box.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
      }

      // Confirm the turn actually started: a click that misses leaves the text in
      // place, and retrying then would double-send. Verify the composer drained.
      const confirmBy = Date.now() + 3000;
      let drained = false;
      while (Date.now() < confirmBy) {
        await new Promise((r) => setTimeout(r, 100));
        if ((box.innerText || '').trim().length === 0) { drained = true; break; }
      }
      if (!drained) throw new Error('send did not take — composer still holds the text');

      // A fresh chat only gains its conversation id after the server accepts the
      // message. Wait for the turn to visibly start (id in URL, or streaming), so
      // the caller's first status() cannot mistake "not started yet" for "settled".
      const startBy = Date.now() + 5000;
      while (Date.now() < startBy) {
        if (conversationId() || isStreaming()) break;
        await new Promise((r) => setTimeout(r, 120));
      }

      return { ok: true, typed: text.length, via: btn ? 'button' : 'enter' };
    },

    async status() {
      // A brand-new chat has no id in the URL until the first message is accepted,
      // and the id appears a few hundred ms after sending. Returning "idle" during
      // that window would make the engine think the turn already settled, harvest
      // would fail, and the retry would send the prompt a second time. So: wait
      // briefly for the id, then decide.
      let id = conversationId();
      if (!id) {
        const deadline = Date.now() + (isStreaming() ? 4000 : 1200);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 120));
          id = conversationId();
          if (id) break;
        }
      }

      if (isStreaming()) {
        return { phase: 'running', lastMessageId: null, lastMessageAt: Date.now(), model: null, textLength: 0, tail: '' };
      }

      if (!id) {
        // Still a fresh, empty chat: nothing has been sent, nothing to harvest.
        return { phase: 'idle', lastMessageId: null, lastMessageAt: null, model: null, textLength: 0, tail: '' };
      }

      // Settled, or never started. Ask the API which message is current so the engine
      // can tell "same turn seen twice" apart from "a new turn arrived".
      const r = await apiGet(API.conversation(id));
      const j = await r.json();
      const node = j.mapping && j.mapping[j.current_node];
      const msg = node && node.message;
      if (!msg) {
        return { phase: 'idle', lastMessageId: null, lastMessageAt: null, model: null, textLength: 0, tail: '' };
      }
      const text = textOf(msg);
      const finished = msg.status === 'finished_successfully';
      return {
        phase: finished ? 'idle' : 'running',
        lastMessageId: msg.id || j.current_node || null,
        lastMessageAt: msg.create_time ? msg.create_time * 1000 : null,
        model: (msg.metadata && msg.metadata.model_slug) || null,
        textLength: text.length,
        tail: text.slice(-200),
        error: finished ? undefined : 'message status=' + msg.status,
      };
    },

    async harvest(args) {
      const a = args || {};
      const convId = conversationId();
      if (!convId) throw new Error('no conversation id in URL');

      const r = await apiGet(API.conversation(convId));
      const j = await r.json();
      const targetId = a.messageId || j.current_node;
      const node = j.mapping && j.mapping[targetId];
      const msg = node && node.message;
      if (!msg) throw new Error('message ' + targetId + ' not found in conversation');

      const text = textOf(msg);
      const blocks = (msg.content && msg.content.parts)
        ? msg.content.parts.map((p, i) => ({ i, text: typeof p === 'string' ? p : '' })).filter((b) => b.text.length)
        : [];

      // sandbox links are the only reliable pointer to generated files: the artifact
      // cards in the DOM are rendered from exactly these markdown links.
      const refs = [];
      let m;
      SANDBOX_LINK.lastIndex = 0;
      while ((m = SANDBOX_LINK.exec(text)) !== null) {
        refs.push({ label: m[1], sandboxPath: decodeURIComponent(m[2]) });
      }
      if (!refs.length) return { text, blocks, artifacts: [] };

      const out = [];
      for (const ref of refs) {
        const metaRes = await apiGet(API.interpreterDownload(convId, msg.id, ref.sandboxPath));
        const meta = await metaRes.json();
        if (!meta || !meta.download_url) {
          LOGGER.warn('no download_url for ' + ref.sandboxPath);
          continue;
        }
        const fileRes = await apiGet(meta.download_url);
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        out.push({
          // file_id is stable across re-renders; the sandbox path covers the (rare)
          // case where the API omits it.
          id: (meta.metadata && meta.metadata.file_id) || (msg.id + ':' + ref.sandboxPath),
          name: meta.file_name || ref.sandboxPath.split('/').pop(),
          mime: meta.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream',
          bytes: BYTES_MODE === 'base64' ? toBase64(bytes) : bytes,
          byteLength: bytes.length,
          bytesEncoding: BYTES_MODE,
          messageId: msg.id,
          source: 'sandbox:' + ref.sandboxPath,
        });
      }
      return { text, blocks, artifacts: out };
    },
  };
}

export default createChatGptAdapter;
