// pots.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  const $ = (id) => document.getElementById(id);
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  const { pretty } = pntReplay;

  const DAYS = ["1", "7", "30", "all"];
  const state = { days: "7", minPot: 2000, player: "", unit: "chips", data: null };

  const readUrl = () => {
    const q = new URLSearchParams(location.search);
    state.days = DAYS.includes(q.get("days")) ? q.get("days") : "7";
    const min = parseInt(q.get("min"), 10);
    state.minPot = Number.isFinite(min) && min >= 0 ? min : 2000;
    state.player = q.get("player") || "";
    state.unit = q.get("unit") === "bb" ? "bb" : "chips";
  };
  const writeUrl = () => {
    const q = new URLSearchParams();
    if (state.days !== "7") q.set("days", state.days);
    if (state.minPot !== 2000) q.set("min", state.minPot);
    if (state.player) q.set("player", state.player);
    if (state.unit !== "chips") q.set("unit", state.unit);
    if (theme) q.set("theme", theme);
    history.replaceState(null, "", "?" + q.toString());
  };

  const chips = (v) => v == null ? "–" : Math.round(v).toLocaleString();
  const signed = (v) => v == null ? "–" : (v > 0 ? "+" : "") + Math.round(v).toLocaleString();
  const signedBb = (v) => v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(1);
  // A row's money in the chosen unit. bb is per-hand: a hand with no big blind on
  // record can only be shown in chips, so it says so rather than inventing one.
  const money = (row, chipsKey, bbKey) =>
    state.unit === "bb" ? (row[bbKey] == null ? "–" : signedBb(row[bbKey])) : signed(row[chipsKey]);

  const WHEN = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const when = (ts) => { const d = new Date(ts); return isNaN(d) ? (ts || "") : WHEN.format(d); };

  async function getJson(url) {
    const r = await pntFetch(url);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 404 && body.detail === "Not Found") {
        throw new Error("the running server is older than this page: restart `pnt service` (or `pnt serve`)");
      }
      throw new Error(body.detail || `${r.status} ${r.statusText}`);
    }
    return r.json();
  }

  async function loadPlayers() {
    const rows = await getJson("/players");
    const sel = $("player");
    for (const p of rows) {
      const o = document.createElement("option");
      o.value = p.alias; o.textContent = p.alias;
      sel.appendChild(o);
    }
    sel.value = rows.some(p => p.alias === state.player) ? state.player : "";
    state.player = sel.value;
  }

  async function load() {
    $("card").classList.add("loading");
    $("err").classList.add("hidden");
    const q = new URLSearchParams({ min_pot: state.minPot });
    if (state.days === "all") q.set("all_time", "1"); else q.set("days", state.days);
    if (state.player) q.set("player", state.player);
    try {
      state.data = await getJson("/pots?" + q);
      render();
    } catch (e) {
      $("err").textContent = String(e.message || e);
      $("err").classList.remove("hidden");
      $("tiles").replaceChildren();
      $("rows").replaceChildren();
    } finally {
      $("card").classList.remove("loading");
    }
  }

  function tile(value, caption, title) {
    const d = document.createElement("div");
    d.className = "tile";
    if (title) d.title = title;
    const b = document.createElement("b"); b.textContent = value;
    const s = document.createElement("span"); s.textContent = caption;
    d.append(b, s);
    return d;
  }

  const WINDOW_WORD = { "1": "in the last 24 hours", "7": "in the last 7 days", "30": "in the last 30 days", all: "ever recorded" };

  function render() {
    const d = state.data;
    const word = WINDOW_WORD[state.days];
    $("subtitle").textContent = `over ${chips(d.min_pot)} ${word}` + (d.player ? ` · ${d.player}` : "");
    $("tiles").replaceChildren(
      tile(chips(d.biggest), "biggest pot", "the largest single pot in the window"),
      tile(String(d.over), `pots over ${chips(d.min_pot)}`, "how many cleared the bar"),
      tile(chips(d.chips), "chips in those pots", "every flagged pot added up"),
      tile(d.hands.toLocaleString(), "hands in the window", "the denominator: every hand dealt in it"),
    );

    const list = $("rows");
    list.replaceChildren();
    $("replay").classList.add("hidden");
    if (!d.pots.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = d.hands
        ? `no pot reached ${chips(d.min_pot)} ${word} — ${d.hands.toLocaleString()} hands looked at`
        : `no hands ${word}`;
      list.appendChild(p);
      return;
    }
    if (d.over > d.pots.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `the ${d.pots.length} biggest of ${d.over} pots over the bar`;
      p.style.margin = "0 0 6px";
      list.appendChild(p);
    }
    const top = d.pots[0].pot || 1;
    for (const h of d.pots) list.appendChild(potRow(h, top, list));
  }

  function potRow(h, top, list) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pot-row"; b.setAttribute("aria-pressed", "false");
    // Every pot is read against the biggest one in the window.
    b.style.setProperty("--share", `${Math.max(2, Math.round(100 * h.pot / top))}%`);
    const span = (cls, text, title) => {
      const s = document.createElement("span"); s.className = cls; s.textContent = text;
      if (title) s.title = title;
      b.appendChild(s); return s;
    };

    const pot = span("pot", state.unit === "bb" && h.pot_bb != null ? `${h.pot_bb}bb` : chips(h.pot));
    const other = document.createElement("small");
    other.textContent = state.unit === "bb" ? chips(h.pot) : (h.pot_bb != null ? `${h.pot_bb}bb` : "");
    pot.appendChild(other);
    span("when", when(h.ts), [h.game_id, `#${h.hand_number}`, h.ts].filter(Boolean).join(" · "));

    // Who it went to. A chopped pot has no winner to name, so it says so rather
    // than crowning whoever came out a blind ahead.
    const who = span("who", "");
    if (h.chopped) {
      who.append("chopped ");
      const names = document.createElement("span");
      names.className = "sep";
      names.textContent = h.seats.filter(s => s.collected > 0).map(s => s.player).join(" · ");
      who.appendChild(names);
    } else if (h.winner) {
      const w = document.createElement("span");
      w.className = "up";
      w.textContent = `${h.winner} ${money(h, "won", "won_bb")}`;
      who.appendChild(w);
      if (h.loser) {
        const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "vs";
        const l = document.createElement("span"); l.className = "down";
        const lost = h.seats[h.seats.length - 1];
        l.textContent = `${h.loser} ${money(lost, "net", "net_bb")}`;
        who.append(sep, l);
      }
    } else {
      who.textContent = "—";
    }
    who.title = h.seats.map(s =>
      `${s.player} ${s.net > 0 ? "+" : ""}${s.net.toLocaleString()}${s.hole_cards ? " " + pretty(s.hole_cards) : ""}`
    ).join("\n");

    span("board cards", h.board.length ? pretty(h.board.join("")) : "no flop",
      h.run_count > 1 ? "ran twice; run one shown" : "");

    const tags = document.createElement("span");
    tags.className = "tags";
    const tag = (text, cls, title) => {
      const t = document.createElement("span");
      t.className = "tag" + (cls ? " " + cls : "");
      t.textContent = text;
      if (title) t.title = title;
      tags.appendChild(t);
    };
    if (h.all_in) tag("all in", "allin");
    tag(h.went_to_showdown ? "showdown" : h.street, null,
      h.went_to_showdown ? "shown down" : `no showdown; ended on the ${h.street}`);
    tag(`${h.players}-handed`);
    if (h.run_count > 1) tag("ran twice");
    // The chips of an unfinished hand are not all on record, so its pot is short.
    if (!h.complete) tag("log cut short", "short", "the log stops mid-hand: this pot is short");
    b.appendChild(tags);

    b.addEventListener("click", () => {
      list.querySelectorAll(".pot-row").forEach(x => x.setAttribute("aria-pressed", x === b));
      pntReplay.show($("replay"), h.hand_id);
    });
    return b;
  }

  // ---- controls ----------------------------------------------------------
  function apply() {
    const v = parseInt($("minpot").value, 10);
    state.minPot = Number.isFinite(v) && v >= 0 ? v : 0;
    state.player = $("player").value;
    writeUrl(); load();
  }
  $("apply").addEventListener("click", apply);
  $("minpot").addEventListener("change", apply);
  $("minpot").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  $("player").addEventListener("change", apply);
  document.querySelectorAll("[data-days]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-days]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.days = b.dataset.days;
    writeUrl(); load();
  }));
  document.querySelectorAll("[data-unit]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-unit]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.unit = b.dataset.unit;
    writeUrl(); if (state.data) render();
  }));

  readUrl();
  $("minpot").value = state.minPot;
  document.querySelectorAll("[data-days]").forEach(x => x.setAttribute("aria-pressed", x.dataset.days === state.days));
  document.querySelectorAll("[data-unit]").forEach(x => x.setAttribute("aria-pressed", x.dataset.unit === state.unit));
  writeUrl();
  loadPlayers().catch(() => {}).then(load);
})();
