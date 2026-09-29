/* Service worker: the only part of the extension that talks to the tracker.
 *
 * Everything the page needs goes through one message: {type, ...} -> {ok, ...}.
 * Behind it, the tracker is one of two things, which answer the same API:
 *
 *   "builtin"    Python on WebAssembly inside the extension (offscreen.html and
 *                engine.worker.js): nothing to install.
 *   "companion"  the local server (`pnt serve` / `pnt service`), reached over HTTP:
 *                the CLI, a log folder kept in sync, a database file on disk.
 *                The content script cannot fetch 127.0.0.1 from the PokerNow
 *                origin, but this worker, with host_permissions, can.
 *
 * Which one is a saved setting. "auto" settles on first use -- the companion if
 * one answers, else the built-in one -- and is then kept, because switching by
 * itself would split one evening's hands across two databases.
 */

// `liveMin`: hands a spot needs before the live view shows it, else it widens.
// `liveKnown`: shown hands a spot narrowed to the board's texture must keep.
// `hudMode`: "panel" draws the HUD in Chrome's side panel, beside the page;
// "float" draws the same page in a box on the game page that can be dragged about.
// `backend`: "auto", "builtin" or "companion" (see the top of this file).
const DEFAULTS = {
  server: "http://127.0.0.1:52000", pollSeconds: 5, liveMin: 1, liveKnown: 5, hudMode: "panel", backend: "auto",
};

// A saved number, or the default when nothing sensible was saved. Zero is a
// choice here (no texture gate), so `|| fallback` would be wrong.
function count(v, fallback, floor) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(floor, Math.trunc(n)) : fallback;
}

// The default port moved off 8000, which is the busiest port on a dev machine.
// Anyone whose saved value is exactly an old default was accepting that default
// rather than choosing 8000, so they are moved across; any other value is a
// deliberate choice and is left alone.
const RETIRED_SERVERS = ["http://127.0.0.1:8000", "http://localhost:8000"];

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  let server = (s.server || DEFAULTS.server).replace(/\/+$/, "");
  if (RETIRED_SERVERS.includes(server)) {
    server = DEFAULTS.server;
    await chrome.storage.sync.set({ server });
  }
  return { ...DEFAULTS, ...s, server };
}

// The tracker refuses a write without this header: a site in another tab can POST
// to 127.0.0.1 too, but it cannot add a custom header without a CORS preflight,
// which the tracker never grants.
const WRITE_HEADER = { "x-pnt": "1" };

// The match pattern Chrome grants for the companion: its host, any port. Asked for
// when the companion is chosen (popup.js), not at install -- a store install that
// never uses the companion is never asked about 127.0.0.1.
const originOf = (server) => { const u = new URL(server); return `${u.protocol}//${u.hostname}/*`; };

async function companionAnswer(server, path, init = {}) {
  const request = () => fetch(server + path, { ...init, headers: { ...init.headers, ...WRITE_HEADER } });
  let r;
  try {
    r = await request();
  } catch {
    // Chrome may have been asked to start it a moment ago (native messaging): give
    // it the few seconds a server takes to come up, then say why it is not there.
    if (await companionStarting(server)) r = await request().catch(() => null);
    if (!r) {
      if (!(await chrome.permissions.contains({ origins: [originOf(server)] }))) {
        throw new Error("the extension may not reach the companion yet: open ⚙, choose Companion app, and Save");
      }
      throw new Error(`the companion is not answering at ${server}: run \`pnt connect ${chrome.runtime.id}\` once so Chrome starts it, or start \`pnt serve\``);
    }
  }
  return { status: r.status, body: await r.json().catch(() => ({ detail: `${r.status} ${r.statusText}` })) };
}

async function companionUp(server) {
  try {
    return (await fetch(`${server}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// The built-in tracker ships only in a built extension (scripts/build_extension.py
// adds Pyodide and the Python). The folder `pnt extension` prints has neither, and
// is companion-only.
let shipped = null;
async function builtinShipped() {
  shipped ??= fetch(chrome.runtime.getURL("engine/pnt.zip"), { method: "HEAD" }).then((r) => r.ok, () => false);
  return shipped;
}

async function backend() {
  const s = await settings();
  if (s.backend === "builtin" || s.backend === "companion") return s.backend;
  let chosen;
  if (await companionUp(s.server)) chosen = "companion";
  else if (await builtinShipped()) chosen = "builtin";
  else return "companion"; // nothing to settle on yet: its error says what to start
  await chrome.storage.sync.set({ backend: chosen });
  return chosen;
}

// Someone updating from a version with no built-in tracker has been using the
// companion, and has a database there. Settling "auto" at a moment their server
// happened to be down would start them on an empty built-in one instead.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "update") return;
  const { backend } = await chrome.storage.sync.get({ backend: null });
  if (backend == null) await chrome.storage.sync.set({ backend: "companion" });
});

// --------------------------------------------------------- built-in tracker --
const ENGINE_TIMEOUT_MS = 120_000;
let opening = null;

async function engineOpen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function ensureEngine() {
  if (await engineOpen()) return;
  opening ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs the tracker's database (Python compiled to WebAssembly) in a worker.",
    })
    .then(resyncGameTabs)
    .finally(() => { opening = null; });
  await opening;
}

// A new engine starts from its last save, which may be up to a few seconds of
// captured lines behind what a game tab believes it has sent. Each tab walks its
// log back to lines the engine has, and the gap fills from PokerNow (pager.js).
async function resyncGameTabs() {
  const tabs = await chrome.tabs.query({ url: GAME_URLS }).catch(() => []);
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "resync" }).catch(() => {});
}

async function engineAsk(msg) {
  await ensureEngine();
  let timer;
  const answer = await Promise.race([
    chrome.runtime.sendMessage({ target: "engine", ...msg }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("the built-in tracker did not answer")), ENGINE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!answer) throw new Error("the built-in tracker did not answer");
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}

// ---------------------------------------------------- the companion's host --
// With `pnt connect`, Chrome starts the companion server itself: while the tracker
// is the companion, a port stays open to the native host (pnt/native.py), which
// runs the server until the port closes. An open port also keeps this service
// worker alive, so the server lasts as long as the browser does.
const NATIVE_HOST = "com.pokernow.tracker";
const NATIVE_RETRY_MS = 60_000;
let nativePort = null;
let nativeTriedAt = 0;
let nativeOpenedAt = 0;

async function keepCompanion() {
  if (nativePort || Date.now() - nativeTriedAt < NATIVE_RETRY_MS) return;
  if (!(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))) return;
  nativeTriedAt = nativeOpenedAt = Date.now();
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener((m) => chrome.storage.session.set({ native: { ...m, at: Date.now() } }));
  port.onDisconnect.addListener(() => {
    // "Specified native messaging host not found." until `pnt connect` has run.
    const error = chrome.runtime.lastError?.message || "the companion's host stopped";
    if (nativePort === port) nativePort = null;
    chrome.storage.session.set({ native: { error, at: Date.now() } });
  });
  port.postMessage({ type: "status" });
}

function dropCompanion() {
  nativePort?.disconnect();
  nativePort = null;
  nativeTriedAt = 0;
}

// True once the server answers, if the host was started in the last few seconds.
async function companionStarting(server) {
  for (let i = 0; nativePort && Date.now() - nativeOpenedAt < 15_000 && i < 30; i++) {
    if (await companionUp(server)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ------------------------------------------------------------------ calls --
// {status, body} from one tracker, as the API sent them.
async function answerFrom(kind, path, init = {}) {
  if (kind === "builtin") return engineAsk({ method: init.method || "GET", url: path, body: init.body ?? null });
  await keepCompanion();
  return companionAnswer((await settings()).server, path, init);
}

// ...from whichever tracker is chosen.
async function answer(path, init = {}) {
  return answerFrom(await backend(), path, init);
}

// The body of a successful answer; an error with the API's message otherwise.
async function call(path, init) {
  const { status, body } = await answer(path, init);
  if (status >= 400) throw new Error(body?.detail || `${status}`);
  return body;
}

const PAGES = chrome.runtime.getURL("pages/");

// ------------------------------------------------------------------- moving --
// Switching trackers (⚙) can bring everything along: each game's raw lines --
// every hand is derived from them -- and then the judgements no log holds
// (aliases, review marks, notes), which name the games' players and hands and so
// go last. /ingest dedupes, so a move that stops halfway can simply be run again.
// Progress goes to session storage as `move`, where the ⚙ page reads it.
const MOVE_CHUNK = 5_000;
let moving = null;

async function moveTo(to) {
  const from = await backend();
  const report = (m) => chrome.storage.session.set({ move: { from, to, at: Date.now(), ...m } });
  const body = ({ status, body }) => {
    if (status >= 400) throw new Error(body?.detail || `${status}`);
    return body;
  };
  const post = (data) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  try {
    if (from !== to) {
      const games = body(await answerFrom(from, "/export/games"));
      await report({ phase: "copying", done: 0, total: games.length });
      for (const [i, g] of games.entries()) {
        const { entries } = body(await answerFrom(from, `/export/games/${encodeURIComponent(g.game_id)}`));
        for (let k = 0; k < entries.length; k += MOVE_CHUNK) {
          const piece = entries.slice(k, k + MOVE_CHUNK);
          body(await answerFrom(to, "/ingest", post({ game_id: g.game_id, entries: piece, source: "move", rebuild: false })));
        }
        body(await answerFrom(to, `/rebuild/${encodeURIComponent(g.game_id)}`, { method: "POST" }));
        await report({ phase: "copying", done: i + 1, total: games.length });
      }
      body(await answerFrom(to, "/export/judgements", post(body(await answerFrom(from, "/export/judgements")))));
      await report({ phase: "done", done: games.length, total: games.length });
    }
    await chrome.storage.sync.set({ backend: to });
  } catch (e) {
    await report({ phase: "failed", error: String(e?.message || e) });
  }
}

const handlers = {
  settings: () => settings(),

  health: async () => ({ ...(await call("/health")), backend: await backend() }),

  ingest: ({ game_id, entries, rebuild = true }) =>
    call("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game_id, entries, source: "extension", rebuild }),
    }),

  rebuild: ({ game_id }) => call(`/rebuild/${encodeURIComponent(game_id)}`, { method: "POST" }),

  hud: ({ game_id }) => call(`/hud/${encodeURIComponent(game_id)}`),

  // The hand in progress, read from the raw lines: needs no rebuild.
  live: ({ game_id, min, known }) =>
    call(`/live/${encodeURIComponent(game_id)}?min=${count(min, 1, 1)}&known=${count(known, DEFAULTS.liveKnown, 0)}`),

  // The content script reports here -- counters, status text, and the HUD and
  // live payloads -- and the side panel and settings page read it back.
  status: async (msg, sender) => {
    const key = `status:${sender.tab?.id ?? "?"}`;
    await chrome.storage.session.set({ [key]: { ...msg.status, tabId: sender.tab?.id, at: Date.now() } });
    return {};
  },

  // Which tab the content script is in; it cannot ask the tabs API itself. The
  // floating HUD's frame is told, so it shows that tab and never the active one.
  tab: async (msg, sender) => ({ id: sender.tab?.id ?? null }),

  // The dashboard pages (pages/api.js): any API request, answered as it came. Only
  // for the extension's own pages -- a content script has the handlers above.
  api: async ({ path, method = "GET", body = null }, sender) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(PAGES)) throw new Error("not an extension page");
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`not an API path: ${path}`);
    const headers = body == null ? {} : { "content-type": "application/json" };
    return answer(path, { method, body, headers });
  },

  // ⚙ switching trackers with "copy my hands" ticked. Answers at once; the copy
  // runs on, and reports to session storage.
  move: async ({ to }) => {
    if (to !== "builtin" && to !== "companion") throw new Error(`no tracker ${to}`);
    if (moving) throw new Error("already moving");
    moving = moveTo(to).finally(() => { moving = null; });
    return {};
  },

  // offscreen.js, after a long quiet spell (it has saved first). Kept open while a
  // game tab could still ask for something any second.
  "engine-idle": async () => {
    const tabs = await chrome.tabs.query({ url: GAME_URLS }).catch(() => []);
    if (!tabs.length && (await engineOpen())) await chrome.offscreen.closeDocument().catch(() => {});
    return {};
  },
};

// ------------------------------------------------------------- HUD mode --
// The side panel is off by default and switched on per game tab, in panel mode
// only. A tab's own panel is shown on that tab alone: switch away and it goes,
// switch back and it returns.
//
// A game tab is known by its URL, not by its content script reporting in: after
// the extension is reloaded, a game tab already open has no working content
// script until it is reloaded too, and the icon must still open the panel there
// (which then says to reload). The URL is visible for these sites only, through
// host_permissions.
const sidePanel = chrome.sidePanel;
const GAME_URLS = [
  "https://www.pokernow.com/games/*", "https://pokernow.com/games/*",
  "https://www.pokernow.club/games/*", "https://pokernow.club/games/*",
];
const isGame = (url) => /^https:\/\/(www\.)?pokernow\.(com|club)\/games\/[A-Za-z0-9_-]+/.test(url || "");
async function hudMode() {
  const { hudMode } = await chrome.storage.sync.get({ hudMode: DEFAULTS.hudMode });
  return hudMode === "float" ? "float" : "panel";
}
async function applyTab(tabId, game, mode) {
  if (!sidePanel) return;
  const enabled = game && (mode ?? (await hudMode())) === "panel";
  await sidePanel.setOptions(enabled ? { tabId, path: "sidepanel.html", enabled } : { tabId, enabled }).catch(() => {});
}
// In panel mode the toolbar icon opens the panel; in float mode it shows and
// hides the box on the page (action.onClicked only fires when the panel does not
// take the click).
async function applyMode() {
  const mode = await hudMode();
  await sidePanel?.setPanelBehavior({ openPanelOnActionClick: mode === "panel" }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: GAME_URLS }).catch(() => []);
  for (const t of tabs) await applyTab(t.id, true, mode);
}
sidePanel?.setOptions({ enabled: false }).catch(() => {});
applyMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.hudMode) applyMode();
  if (area === "sync" && changes.backend) {
    if (changes.backend.newValue === "companion") keepCompanion();
    else dropCompanion();
    // A different tracker has none of what the tabs sent the last one. (Leaving
    // "auto" for the choice it settled on changes nothing.)
    if (changes.backend.oldValue && changes.backend.oldValue !== "auto") resyncGameTabs();
  }
});
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "toggle-hud" }).catch(() => {});
});

// A closed tab's report would otherwise sit in session storage until the browser closes.
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`status:${tabId}`));
// Nor may it outlive a reload or a move off the game: the side panel would go on
// showing a table that is no longer there. A game page reports again as it loads.
// Its panel follows its URL: a reload keeps it, and a move off the game drops it.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") chrome.storage.session.remove(`status:${tabId}`);
  if (info.status === "loading" || info.url) applyTab(tabId, isGame(tab.url));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "engine") return false; // for offscreen.js
  const h = handlers[msg?.type];
  if (!h) { sendResponse({ ok: false, error: `unknown message ${msg?.type}` }); return false; }
  h(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
  );
  return true; // async sendResponse
});

// Chrome started, or this worker did: while the tracker is the companion, have
// Chrome keep its server running.
settings().then((s) => { if (s.backend === "companion") keepCompanion(); });
