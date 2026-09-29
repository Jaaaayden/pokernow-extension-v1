/* The tracker built into the extension: Python's pnt.engine on Pyodide.
 *
 * Used when no companion server is installed (docs/architecture.md, "One API, two
 * transports"). The same routes the server answers over HTTP are answered here
 * in-process, from the same Python.
 *
 * The database lives in Pyodide's in-memory file system while the engine runs,
 * and is saved whole to durable storage a moment after it changes. Why whole:
 * Python's sqlite3 in Pyodide can only reach Emscripten's file system, and the
 * durable storage a worker has (OPFS) is not one it can mount for page-level
 * writes. A save replaces the file atomically, so what is stored is always a
 * database as it stood between two requests.
 *
 * How soon a save follows a write depends on what could be lost:
 *   - a person's judgement (a merge, a rename, a note, a review mark) is saved
 *     within a second: nothing could ever rebuild it;
 *   - captured log lines wait up to SAVE_LATER_MS: if the engine stops before
 *     saving them, the background tells each game tab to walk its log again,
 *     and the lines come back from PokerNow (background.js, `resync`).
 *
 * A plain module with every browser dependency passed in, so node can run it
 * against real Pyodide (enginehost.test.mjs). engine.worker.js wires it up.
 */

export const DB_PATH = "/data/pnt.sqlite";
export const SAVE_SOON_MS = 1_000;
export const SAVE_LATER_MS = 30_000;

// Writes a person made, which no log can bring back.
const JUDGEMENTS = /^\/(aliases\/[a-z]+|hands\/\d+\/(note|reviewed))$/;

/**
 * loadPyodide  Pyodide's own loader
 * indexURL     where Pyodide's files are (vendor/pyodide/ in the extension)
 * engineZip    the pnt package as a zip (engine/pnt.zip), an ArrayBuffer
 * storage      {load() -> Uint8Array | null, save(Uint8Array)}: the durable copy
 */
export async function createEngineHost({ loadPyodide, indexURL, engineZip, storage, log = console }) {
  const py = await loadPyodide({ indexURL, stdout: (s) => log.info(`[pnt engine] ${s}`), stderr: (s) => log.warn(`[pnt engine] ${s}`) });
  py.unpackArchive(engineZip, "zip", { extractDir: "/engine" });
  py.FS.mkdirTree("/data");
  const saved = await storage.load();
  if (saved) py.FS.writeFile(DB_PATH, saved);
  py.runPython(`
import sys
sys.path.insert(0, "/engine")
from pnt.engine import Engine
engine = Engine(${JSON.stringify(DB_PATH)}, journal_mode="MEMORY", db_label="built into the extension")
`);
  const engine = py.globals.get("engine");

  let dirty = false;
  let timer = null;
  let dueAt = Infinity;
  let saving = Promise.resolve();

  function save() {
    clearTimeout(timer);
    timer = null;
    dueAt = Infinity;
    if (dirty) {
      dirty = false;
      // Read now, between requests: a copy of a database with no open transaction.
      const bytes = py.FS.readFile(DB_PATH);
      saving = saving
        .then(() => storage.save(bytes))
        .catch((e) => {
          dirty = true; // try again with the next save
          log.error("[pnt engine] could not save the database:", e);
        });
    }
    return saving;
  }

  function scheduleSave(ms) {
    dirty = true;
    const at = Date.now() + ms;
    if (at >= dueAt) return; // one already due sooner
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(save, ms);
  }

  return {
    /** One API request, as `pnt.engine.Engine.handle`: {status, body}. */
    request(method, url, body) {
      const out = JSON.parse(engine.handle_json(method, url, body == null ? undefined : body));
      if (method !== "GET" && out.status < 400) {
        const path = url.split("?")[0];
        scheduleSave(JUDGEMENTS.test(path) ? SAVE_SOON_MS : SAVE_LATER_MS);
      }
      return out;
    },
    /** Save now if anything changed; resolves once it is stored. */
    flush: save,
    close() {
      clearTimeout(timer);
      engine.close();
      engine.destroy();
    },
  };
}
