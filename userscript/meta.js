// ==UserScript==
// @name         loopcrop
// @namespace    https://github.com/C0llap5ar/loopcrop
// @version      0.0.0-dev
// @description  Drive an AI chat web UI in a loop: send a prompt, wait for the turn to settle, harvest the files it produced, repeat.
// @author       C0llap5ar
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @noframes
// ==/UserScript==

// @version is stamped by scripts/build-userscript.mjs from package.json, because
// Tampermonkey decides whether to offer an update by comparing this field — a
// hand-maintained copy would silently stop reaching installed users. The value
// in this source file is a placeholder and is never what ships.
