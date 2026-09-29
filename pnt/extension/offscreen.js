/* Offscreen document: home of the built-in tracker's worker.
 *
 * The background service worker cannot start a Web Worker, and is itself stopped
 * whenever it goes quiet, so the engine lives here, in a page with no window that
 * background.js opens on demand. This page only relays: {target: "engine"}
 * messages go to engine.worker.js and its answers come back.
 *
 * When nothing has asked anything for IDLE_MS, the database is saved and the
 * background is told; it closes this document unless a game tab is still open.
 * Pyodide holds a few hundred MB, which is not worth keeping for no one.
 */
const IDLE_MS = 5 * 60_000;

const worker = new Worker("engine.worker.js", { type: "module" });
const waiting = new Map();
let nextId = 0;
let lastUse = Date.now();

worker.onmessage = ({ data }) => {
  waiting.get(data.id)?.(data);
  waiting.delete(data.id);
};
// A worker that fails to start (a missing file, a CSP refusal) fails every request
// with the reason, rather than leaving them waiting forever.
worker.onerror = (e) => {
  const error = `the built-in tracker failed to start: ${e.message || "see the offscreen console"}`;
  for (const done of waiting.values()) done({ ok: false, error });
  waiting.clear();
};

function ask(msg) {
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    worker.postMessage({ id, ...msg });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "engine") return false; // content scripts talk to the background, not here
  lastUse = Date.now();
  ask({ op: msg.op, method: msg.method, url: msg.url, body: msg.body }).then(sendResponse);
  return true;
});

setInterval(async () => {
  if (Date.now() - lastUse < IDLE_MS) return;
  lastUse = Date.now();
  await ask({ op: "flush" });
  chrome.runtime.sendMessage({ type: "engine-idle" }).catch(() => {});
}, 60_000);
