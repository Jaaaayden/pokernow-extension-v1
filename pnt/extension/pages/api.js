/* How a page reaches the tracker, wherever the page is served from.
 *
 * These pages ship inside the extension (pnt/extension/pages/) and are also served
 * by the companion server at 127.0.0.1:52000. Every request goes through
 * `pntFetch(path, init)`, which answers like `fetch` -- a Response, with the API's
 * status and JSON -- in both places:
 *
 *   - served by the companion: a plain fetch to the same origin, with the header
 *     the server requires on writes (see app.py);
 *   - as an extension page: a message to the background worker, which sends it to
 *     whichever tracker the ⚙ settings chose -- built in, or the companion.
 *
 * Links between pages are relative (`chart.html?player=...`), so they resolve under
 * either origin.
 */
(function () {
  "use strict";
  const inExtension = location.protocol === "chrome-extension:";

  const json = (body, status) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function pntFetch(path, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    if (!inExtension) {
      const headers = { ...init.headers };
      if (method !== "GET") headers["x-pnt"] = "1";
      return fetch(path, { ...init, headers });
    }
    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ type: "api", path, method, body: init.body ?? null });
    } catch (e) {
      answer = { ok: false, error: String(e?.message || e) };
    }
    if (!answer?.ok) return json({ detail: answer?.error || "the extension did not answer" }, 503);
    return json(answer.data.body, answer.data.status);
  }

  window.pntFetch = pntFetch;
  window.pntInExtension = inExtension;
})();
