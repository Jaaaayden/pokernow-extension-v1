/* The built-in tracker's worker: enginehost.mjs, wired to the browser.
 *
 * Started by offscreen.js. A worker rather than the offscreen page itself so a
 * three-second derivation never sits on a page's event loop. Requests arrive as
 * {id, op, method, url, body} and are answered as {id, ok, result | error}, in
 * the order they came: Python runs one at a time.
 *
 * The database is kept in the extension's origin-private file system (OPFS),
 * which belongs to this browser profile and is removed with the extension.
 * `createWritable` writes to a scratch file and swaps it in on close, so a save
 * cut short leaves the previous database whole.
 */
import { loadPyodide } from "./vendor/pyodide/pyodide.mjs";
import { createEngineHost } from "./enginehost.mjs";

const FILE = "pnt.sqlite";

const storage = {
  async load() {
    const root = await navigator.storage.getDirectory();
    try {
      const file = await (await root.getFileHandle(FILE)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if (e.name === "NotFoundError") return null; // first run
      throw e;
    }
  },
  async save(bytes) {
    const root = await navigator.storage.getDirectory();
    const out = await (await root.getFileHandle(FILE, { create: true })).createWritable();
    await out.write(bytes);
    await out.close();
  },
};

const ready = (async () => {
  const zip = await fetch(new URL("engine/pnt.zip", import.meta.url));
  if (!zip.ok) throw new Error(`engine/pnt.zip: ${zip.status}`);
  const host = await createEngineHost({
    loadPyodide,
    indexURL: new URL("vendor/pyodide/", import.meta.url).href,
    engineZip: await zip.arrayBuffer(),
    storage,
  });
  // The first lifetime report derives every hand once (seconds, on a long
  // history); everything after it is per game. Pay that now, before a table is
  // waiting on it, once whatever arrived during start-up has been answered.
  setTimeout(() => host.request("GET", "/stats"), 500);
  return host;
})();

onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    const host = await ready;
    let result = null;
    if (op === "flush") await host.flush();
    else result = host.request(data.method, data.url, data.body);
    postMessage({ id, ok: true, result });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
