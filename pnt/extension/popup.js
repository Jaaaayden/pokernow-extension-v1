(async () => {
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

  const s = (await send({ type: "settings" })).data;
  $("server").value = s.server;
  $("poll").value = s.pollSeconds;
  $("livemin").value = s.liveMin ?? 1;
  $("liveknown").value = s.liveKnown ?? 5;
  if (!chrome.sidePanel) $("hudmode").querySelector('option[value="panel"]').remove();
  $("hudmode").value = s.hudMode === "float" ? "float" : "panel";
  // "auto" has not settled yet; the health check below settles it and shows which.
  let current = s.backend === "builtin" ? "builtin" : "companion";
  $("backend").value = current;
  $("connect-cmd").textContent = `pnt connect ${chrome.runtime.id}`;
  const showServer = () => {
    const companion = $("backend").value === "companion";
    for (const id of ["server", "server-label", "companion-hint"]) $(id).classList.toggle("hidden", !companion);
    $("move-row").classList.toggle("hidden", $("backend").value === current);
  };
  $("backend").addEventListener("change", showServer);
  showServer();
  // Known ahead of the click: the side panel opens only in the click's own turn,
  // before anything has been awaited.
  const [here] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The dashboard is the extension's own pages, reading whichever tracker is chosen.
  $("tracker").href = chrome.runtime.getURL("pages/index.html");

  $("save").addEventListener("click", async () => {
    const hudMode = $("hudmode").value;
    const want = $("backend").value;
    const server = $("server").value.trim().replace(/\/+$/, "") || "http://127.0.0.1:52000";
    // Asked here, in the click, which is the only place Chrome lets an extension ask:
    // reaching the server on this machine, and the host that lets Chrome start it.
    if (want === "companion") {
      let origin;
      try { const u = new URL(server); origin = `${u.protocol}//${u.hostname}/*`; } catch {
        $("move-status").textContent = `not an address: ${server}`;
        return;
      }
      const granted = await chrome.permissions.request({ origins: [origin], permissions: ["nativeMessaging"] }).catch(() => false);
      if (!granted) {
        $("move-status").textContent = "The companion needs your OK to reach it on this machine.";
        return;
      }
    }
    // Back to the side panel from the floating box: open it for this tab rather
    // than leave the HUD nowhere until the toolbar icon is clicked. The panel is
    // switched on for the tab first, since it is off everywhere in float mode.
    if (hudMode === "panel" && s.hudMode === "float" && here?.id != null && chrome.sidePanel?.open) {
      chrome.sidePanel.setOptions({ tabId: here.id, path: "sidepanel.html", enabled: true }).catch(() => {});
      chrome.sidePanel.open({ tabId: here.id }).catch(() => {});
    }
    s.hudMode = hudMode;
    await chrome.storage.sync.set({
      hudMode,
      server,
      pollSeconds: Math.max(2, Number($("poll").value) || 5),
      liveMin: Math.max(1, Number($("livemin").value) || 1),
      liveKnown: $("liveknown").value === "" ? 5 : Math.max(0, Math.trunc(Number($("liveknown").value)) || 0),
    });
    if (want !== current) {
      if ($("move").checked) {
        const r = await send({ type: "move", to: want });
        if (!r.ok) $("move-status").textContent = r.error;
      } else {
        await chrome.storage.sync.set({ backend: want });
      }
      current = want;
      showServer();
    }
    health();
  });

  // A move in progress, and the companion's host, as the background last saw them.
  async function progress() {
    const { move, native } = await chrome.storage.session.get(["move", "native"]);
    if (move) {
      const name = (k) => (k === "builtin" ? "the built-in tracker" : "the companion");
      $("move-status").textContent =
        move.phase === "copying" ? `Copying to ${name(move.to)}: ${move.done} of ${move.total} games…`
        : move.phase === "done" ? `Copied ${move.total} games to ${name(move.to)}.`
        : move.phase === "failed" ? `Copying stopped: ${move.error}. Save again to pick it up.`
        : "";
      if (move.phase === "done" && Date.now() - move.at < 3000) health();
    }
    $("native").textContent = !native ? ""
      : native.error ? (/not found/i.test(native.error) ? "(not run yet)" : `(${native.error})`)
      : native.owned ? "✓ Chrome is running it"
      : native.running ? "✓ connected; already running (pnt service or a terminal)"
      : "";
  }

  async function health() {
    const h = await send({ type: "health" });
    if (h.ok && h.data.backend) {
      $("backend").value = current = h.data.backend;
      showServer();
    }
    const where = $("backend").value === "builtin" ? "built in" : "companion";
    $("health").textContent = h.ok ? `${where} · ${h.data.hands} hands` : `${where} · not reachable`;
    $("health").className = h.ok ? "ok" : "bad";
  }

  async function status() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const all = await chrome.storage.session.get(null);
    const st = tab && all[`status:${tab.id}`];
    const kv = $("status");
    kv.replaceChildren();
    const put = (k, v) => { const a = document.createElement("span"); a.textContent = k; const b = document.createElement("span"); b.textContent = v; kv.append(a, b); };
    if (!st) { put("this tab", "not a PokerNow game page"); return; }
    put("game", st.game);
    put("capture", st.paused ? "paused" : "running");
    put("polls", `${st.polls} (${st.errors} errors)`);
    put("entries", `${st.inserted} new of ${st.offered} offered`);
    put("history", st.history ? `${st.history}${st.pages ? ` · ${st.pages} pages` : ""}` : "–");
    put("last poll", st.lastPoll ? new Date(st.lastPoll).toLocaleTimeString() : "–");
    put("seated", String(st.seats));
    if (st.live) put("live", st.live);
    put("log shape", st.envelopeOk == null ? "not seen yet" : st.envelopeOk
      ? `ok (${st.shape.list}/${st.shape.entry}/${st.shape.at}/${st.shape.order || "synth"})`
      : "UNRECOGNIZED – see page console");
    if (st.lastError) put("last error", st.lastError);
  }

  health();
  status();
  progress();
  setInterval(status, 2000);
  setInterval(progress, 1000);
})();
