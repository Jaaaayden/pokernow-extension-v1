// index.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  const $ = (id) => document.getElementById(id);
  const fact = (v, k, warn = false) => {
    const d = document.createElement("div");
    d.className = "fact" + (warn ? " warn" : "");
    const a = document.createElement("div"); a.className = "v"; a.textContent = v;
    const b = document.createElement("div"); b.className = "k"; b.textContent = k;
    d.append(a, b);
    return d;
  };
  const n = (v) => Number(v).toLocaleString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The API's own docs are the companion server's; the extension has no server.
  if (pntInExtension) $("docs-card").remove();

  async function loadFacts() {
    try {
      const [health, players] = await Promise.all([
        pntFetch("/health").then((r) => r.json()),
        pntFetch("/players").then((r) => r.json()),
      ]);
      $("facts").replaceChildren(
        fact(n(health.hands), "hands"),
        fact(n(players.length), "players"),
        fact(n(health.entries), "log lines"),
        // Zero is the claim that the parse was total, so it is worth showing even
        // when it is boring; anything else is worth showing in red.
        fact(n(health.parse_misses), "parse misses", health.parse_misses > 0),
      );
      $("dbpath").textContent = "database: " + health.db;
      $("sample-row").classList.toggle("hidden", health.hands > 0);
      $("err").classList.add("hidden");
    } catch (e) {
      $("err").textContent = "could not reach the tracker: " + (e.message || e);
      $("err").classList.remove("hidden");
    }
  }

  // ------------------------------------------------------------- adding hands --
  function say(text, bad = false) {
    const li = document.createElement("li");
    li.textContent = text;
    li.classList.toggle("bad", bad);
    $("add-log").append(li);
    li.scrollIntoView({ block: "nearest" });
    return li;
  }

  async function post(path, body) {
    const r = await pntFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `${r.status}`);
    return data;
  }

  function summary(out) {
    if (out.skipped) return `${out.file}: skipped, ${out.skipped}`;
    return out.new ? `${out.file}: ${n(out.hands)} hands, ${n(out.new)} new lines` : `${out.file}: already in`;
  }

  // Files are imported one at a time: each is a rebuild of its game.
  async function importFiles(files) {
    let changed = false;
    for (const file of files) {
      if (!/\.csv$/i.test(file.name)) { say(`${file.name}: not a CSV export`, true); continue; }
      try {
        const out = await post("/import", { name: file.name, text: await file.text() });
        say(summary(out));
        changed ||= Boolean(out.new);
      } catch (e) {
        say(`${file.name}: ${e.message}`, true);
      }
    }
    if (changed) loadFacts();
    return changed;
  }

  $("files").addEventListener("change", (e) => importFiles([...e.target.files]).then(() => { e.target.value = ""; }));
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    importFiles([...e.dataTransfer.files]);
  });

  $("sample").addEventListener("click", async () => {
    $("sample").disabled = true;
    const li = say("importing the sample… (a few seconds)");
    try {
      const out = await post("/import/sample");
      li.textContent = `sample: ${out.games} games, ${n(out.hands)} hands. These are strangers' hands, anonymized.`;
      loadFacts();
    } catch (e) {
      li.textContent = `sample: ${e.message}`;
      li.classList.add("bad");
      $("sample").disabled = false;
    }
  });

  // -------------------------------------------------- the extension's own extras --
  // The companion keeps a log folder in sync and has `pnt backfill`; the extension
  // has neither, so it gets these.
  async function extensionOnly() {
    for (const el of document.querySelectorAll(".extension-only")) el.classList.remove("hidden");
    const s = await chrome.runtime.sendMessage({ type: "settings" }).catch(() => null);
    if (s?.ok && s.data.backend === "builtin") {
      for (const el of document.querySelectorAll(".companion-only")) el.classList.add("hidden");
    }
    // On the companion there is nothing to bring over: everything is already there.
    if (s?.ok && s.data.backend === "companion") $("old-row").classList.add("hidden");
    else bringOver(s?.ok ? s.data.server : "http://127.0.0.1:52000");
    folderWatch();
    backfill();
  }

  // An earlier version kept everything in the companion's database, and may still be
  // running beside this one. Its games can be copied here, and its aliases, review
  // marks and notes, which are in no log. Both are safe to press twice.
  function bringOver(server) {
    // Asked in the click, which is the only place Chrome lets a page ask: reaching the
    // server on this machine, and the host that lets Chrome start it.
    async function allowed() {
      const u = new URL(server);
      const granted = await chrome.permissions
        .request({ origins: [`${u.protocol}//${u.hostname}/*`], permissions: ["nativeMessaging"] })
        .catch(() => false);
      if (!granted) throw new Error("the extension needs your OK to reach the server on this machine");
    }
    async function send(type, extra = {}) {
      const r = await chrome.runtime.sendMessage({ type, ...extra });
      if (!r?.ok) throw new Error(r?.error || "the extension did not answer");
      return r.data;
    }

    $("old").addEventListener("click", async () => {
      $("old").disabled = true;
      const li = say("bringing over aliases, marks and notes from the server…");
      try {
        await allowed();
        const o = await send("import-judgements");
        li.textContent = `from the server: ${n(o.aliases_moved)} IDs moved to their alias`
          + (o.aliases_unknown ? `, ${n(o.aliases_unknown)} not in this database yet (copy those games, then press again)` : "")
          + ` · ${n(o.reviewed)} review marks · ${n(o.notes)} notes`;
        loadFacts();
      } catch (e) {
        li.textContent = `from the server: ${e.message || e}`;
        li.classList.add("bad");
      } finally {
        $("old").disabled = false;
      }
    });

    // Newest first, so the last session lands in seconds; pressing again while it
    // runs stops after the game in hand.
    const btn = $("old-games");
    let stopping = null;
    btn.addEventListener("click", async () => {
      if (stopping) { stopping.stop = true; btn.disabled = true; return; }
      const run = (stopping = { stop: false });
      btn.textContent = "Stop copying";
      const li = say("asking the server which games it has…");
      let done = 0, hands = 0;
      try {
        await allowed();
        const games = await send("server-games");
        const missing = games.filter((g) => g.have === 0);
        for (const g of games.filter((g) => g.have > 0 && g.have !== g.entries)) {
          say(`${g.game_id}: the server has ${n(g.entries)} lines, this extension ${n(g.have)}. Left as each captured it`);
        }
        for (const g of missing) {
          if (run.stop) break;
          li.textContent = `copying ${g.game_id} (${done + 1} of ${missing.length}, ${n(g.entries)} lines)…`;
          hands += (await send("copy-game", { game_id: g.game_id })).hands;
          done++;
        }
        li.textContent = `from the server: ${done} of ${missing.length} missing games copied, ${n(hands)} hands`
          + (run.stop && done < missing.length ? ". Stopped; press again for the rest" : "")
          + (done ? ". Bring over aliases next" : "");
      } catch (e) {
        li.textContent = `from the server: ${done ? `${done} games copied, then ` : ""}${e.message || e}`;
        li.classList.add("bad");
      } finally {
        stopping = null;
        btn.textContent = "Copy games from the server";
        btn.disabled = false;
        loadFacts();
      }
    });
  }

  // A folder picked once and re-read whenever this page opens. The handle is kept in
  // IndexedDB -- the one place a directory handle can be kept -- and each file's
  // size and date in localStorage, so an unchanged file is not read twice. Chrome
  // asks again for access after a restart unless "allow on every visit" was chosen.
  function folderWatch() {
    const DB = "pnt-folder", STORE = "handles", KEY = "logs", SEEN = "pnt-folder-seen";
    const idb = () => new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = async (mode, fn) => {
      const db = await idb();
      return new Promise((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    };
    const seen = () => { try { return JSON.parse(localStorage.getItem(SEEN) || "{}"); } catch { return {}; } };
    const remember = (v) => { try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch {} };

    async function scan(dir) {
      const was = seen(), now = {}, fresh = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file" || !/^poker_now_log_.+\.csv$/.test(name)) continue;
        const file = await handle.getFile();
        now[name] = `${file.size}:${file.lastModified}`;
        if (was[name] !== now[name]) fresh.push(file);
      }
      $("folder-status").textContent = `${dir.name}: ${Object.keys(now).length} exports, ${fresh.length} new or changed`;
      if (fresh.length) await importFiles(fresh);
      remember(now);
    }

    async function useFolder(dir, ask) {
      const opts = { mode: "read" };
      let state = await dir.queryPermission(opts);
      if (state !== "granted" && ask) state = await dir.requestPermission(opts);
      if (state !== "granted") {
        $("folder").textContent = `Read ${dir.name} again`;
        $("folder-status").textContent = "Chrome needs your OK to read the folder again after a restart.";
        return;
      }
      $("folder").textContent = "Change folder…";
      await scan(dir);
    }

    $("folder").addEventListener("click", async () => {
      const kept = await tx("readonly", (s) => s.get(KEY)).catch(() => null);
      // A kept folder whose access lapsed is asked for again; otherwise pick one.
      if (kept && (await kept.queryPermission({ mode: "read" })) !== "granted") return useFolder(kept, true);
      let dir;
      try { dir = await showDirectoryPicker({ id: "pokernow-logs", mode: "read" }); } catch { return; } // cancelled
      await tx("readwrite", (s) => s.put(dir, KEY));
      remember({});
      await useFolder(dir, true);
    });
    tx("readonly", (s) => s.get(KEY)).then((dir) => dir && useFolder(dir, false), () => {});
  }

  // Old games by link, read from the same /log endpoint live capture pages through
  // (pager.js), at the same pace: PokerNow answers a burst with HTTP 429.
  function backfill() {
    const PAGE_PAUSE_MS = 3_000;
    const load = (src) => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.append(s);
    });
    const ready = load("../normalize.js").then(() => load("../pager.js"));
    const gameOf = (link) => (link.match(/\/games\/([A-Za-z0-9_-]+)/) || link.match(/^([A-Za-z0-9_-]{8,64})$/) || [])[1];

    async function fetchGame(gid, line) {
      const io = {
        async fetchPage({ after, before }) {
          const q = new URLSearchParams({ after_at: after ?? "", before_at: before ?? "" });
          const r = await fetch(`https://www.pokernow.com/games/${gid}/log?${q}`, {
            credentials: "include", headers: { accept: "application/json" },
          });
          if (r.status === 429) {
            const s = Number(r.headers.get("retry-after"));
            throw new PNT.RateLimited(s > 0 ? s * 1000 : null);
          }
          if (r.status === 404) throw new Error("no such game");
          if (!r.ok) throw new Error(`PokerNow answered ${r.status}`);
          const body = await r.json();
          const { entries, ok } = PNT.normalize(body);
          if (!ok) throw new Error("PokerNow's log looks different from what this version reads");
          return { entries, size: PNT.unwrap(body)[1].length };
        },
        ingest: (entries) => post("/ingest", { game_id: gid, entries, source: "backfill", rebuild: false }),
        pause: () => sleep(PAGE_PAUSE_MS),
      };
      const state = { cursor: 0, walk: null };
      for (let backoff = 5_000; ;) {
        try {
          await PNT.sync(state, io, { onPage: ({ pages, fresh }) => { line.textContent = `${gid}: page ${pages}, ${n(fresh)} new lines`; } });
          break;
        } catch (e) {
          if (!(e instanceof PNT.RateLimited) || backoff > 120_000) throw e;
          const wait = e.waitMs ?? backoff;
          line.textContent = `${gid}: PokerNow asked to slow down; again in ${Math.round(wait / 1000)} s`;
          await sleep(wait);
          backoff *= 2; // the walk keeps its place in `state`
        }
      }
      const out = await post(`/rebuild/${gid}`);
      line.textContent = `${gid}: ${n(out.hands)} hands`;
    }

    $("fetch").addEventListener("click", async () => {
      const links = $("links").value.split(/\s+/).filter(Boolean);
      if (!links.length) return;
      $("fetch").disabled = true;
      try {
        await ready;
        for (const link of links) {
          const gid = gameOf(link);
          if (!gid) { say(`${link}: not a PokerNow game link`, true); continue; }
          const line = say(`${gid}: starting…`);
          try {
            await fetchGame(gid, line);
          } catch (e) {
            line.textContent = `${gid}: ${e.message || e}`;
            line.classList.add("bad");
          }
        }
        $("links").value = "";
        loadFacts();
      } finally {
        $("fetch").disabled = false;
      }
    });
  }

  loadFacts();
  if (pntInExtension) extensionOnly();
})();
