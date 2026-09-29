// allin.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  const $ = (id) => document.getElementById(id);
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  const { pretty } = pntReplay;

  const STREETS = ["preflop", "flop", "turn", "river"];
  const STREET_HEAD = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" };
  const state = { filter: "", min: 5, unit: "bb", sort: "hands", dir: -1, player: null, handSort: "newest", rows: [], detail: null };
  const HAND_ORDERS = ["newest", "pot", "swing"];

  const readUrl = () => {
    const q = new URLSearchParams(location.search);
    state.filter = q.get("filter") || "";
    state.min = Math.max(1, parseInt(q.get("min") || "5", 10) || 5);
    state.unit = q.get("unit") === "chips" ? "chips" : "bb";
    state.sort = q.get("sort") || "hands";
    state.dir = q.get("dir") === "asc" ? 1 : -1;
    state.player = q.get("player") || null;
    state.handSort = HAND_ORDERS.includes(q.get("order")) ? q.get("order") : "newest";
  };
  const writeUrl = () => {
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    if (state.min !== 5) q.set("min", state.min);
    if (state.unit !== "bb") q.set("unit", state.unit);
    if (state.sort !== "hands") q.set("sort", state.sort);
    if (state.dir === 1) q.set("dir", "asc");
    if (state.player) q.set("player", state.player);
    if (state.handSort !== "newest") q.set("order", state.handSort);
    if (theme) q.set("theme", theme);
    history.replaceState(null, "", "?" + q.toString());
    const c = new URLSearchParams();
    if (state.filter) c.set("filter", state.filter);
    if (theme) c.set("theme", theme);
    $("statslink").href = "stats.html?" + c;
    $("chartlink").href = "chart.html?" + c;
  };

  // Money keys come in chips and in big blinds; the unit toggle picks one.
  const unitKey = (k) => state.unit === "bb" ? `${k}_bb` : k;
  const money = (v) => {
    if (v == null) return "–";
    const sign = v > 0 ? "+" : "";
    return state.unit === "bb" ? sign + v.toFixed(1) : sign + Math.round(v).toLocaleString();
  };
  const value = (row, key) => {
    if (key === "hands" || key === "equity_avg") return row[key];
    if (key.startsWith("street:")) return row.by_street[key.slice(7)][unitKey("diff")];
    return row[unitKey(key)];
  };
  const fmt = (v, kind) => v == null ? "–" : kind === "int" ? String(v) : kind === "pct" ? v.toFixed(1) + "%" : money(v);

  // [key, header, kind, hover text]
  const columns = () => [
    ["hands", "Hands", "int", "All-in showdowns with every live hand known. Hover a cell for how many were sampled."],
    ["equity_avg", "Eq%", "pct", "Average share of the pot when the betting stopped."],
    ["net", "Actual", "money", "Net chips over these hands: collected minus put in."],
    ["adjusted", "Adjusted", "money", "Net chips had every pot been paid out by equity."],
    ["diff", "Diff", "money", "Actual minus adjusted. Positive ran above expectation."],
    ...STREETS.map(s => [`street:${s}`, STREET_HEAD[s], "money",
      `Diff over the hands where the betting stopped ${s === "preflop" ? "preflop" : "on the " + s}.`]),
  ];

  async function getJson(url) {
    const r = await pntFetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 404 && body.detail === "Not Found") {
        throw new Error("the running server is older than this page: restart `pnt service` (or `pnt serve`)");
      }
      throw new Error(body.detail || `${r.status} ${r.statusText}`);
    }
    return r.json();
  }

  async function load() {
    $("card").classList.add("loading");
    $("err").classList.add("hidden");
    $("subtitle").textContent = "computing equities… the first load after an import takes a moment";
    const q = new URLSearchParams({ min_hands: state.min });
    if (state.filter) q.set("filter", state.filter);
    try {
      state.rows = await getJson("/allin?" + q);
      if (state.rows.length && !("adjusted_bb" in state.rows[0])) {
        throw new Error("the running server is older than this page: restart `pnt service`");
      }
      render();
      if (state.player) openPlayer(state.player);
    } catch (e) {
      $("err").textContent = String(e.message || e);
      $("err").classList.remove("hidden");
      $("subtitle").textContent = "";
      $("table").replaceChildren();
    } finally {
      $("card").classList.remove("loading");
    }
  }

  function sorted() {
    const rows = [...state.rows];
    const key = state.sort;
    rows.sort((a, b) => {
      if (key === "player") return state.dir * a.player.localeCompare(b.player);
      const av = value(a, key), bv = value(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return state.dir * (av - bv);
    });
    return rows;
  }

  function render() {
    const cols = columns();
    const skipped = state.rows[0]?.skipped?.cards_unknown || 0;
    $("subtitle").textContent = [
      `${state.rows.length} players`, state.filter || "all hands", state.unit === "bb" ? "big blinds" : "chips",
      skipped ? `${skipped} showdown${skipped === 1 ? "" : "s"} skipped: a live hand was mucked` : "",
    ].filter(Boolean).join(" · ");
    const t = document.createElement("table");

    const groups = document.createElement("tr");
    for (const [text, span] of [["", 6], ["diff by the street the betting stopped on", STREETS.length]]) {
      const th = document.createElement("th");
      th.className = "group"; th.colSpan = span; th.textContent = text;
      groups.appendChild(th);
    }
    t.appendChild(groups);

    const head = document.createElement("tr");
    const addHead = (key, text, tip) => {
      const th = document.createElement("th");
      th.textContent = text;
      if (tip) th.title = tip;
      if (state.sort === key) {
        th.setAttribute("aria-sort", state.dir === 1 ? "ascending" : "descending");
        const d = document.createElement("span"); d.className = "dir";
        d.textContent = state.dir === 1 ? "▲" : "▼";
        th.appendChild(d);
      }
      th.addEventListener("click", () => {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === "player" ? 1 : -1; }
        writeUrl(); render();
      });
      head.appendChild(th);
    };
    addHead("player", "player", "Click a name for their hands and the two lines.");
    for (const [key, text, , tip] of cols) addHead(key, text, tip);
    t.appendChild(head);

    for (const row of sorted()) {
      const tr = document.createElement("tr");
      if (row.player === state.player) tr.setAttribute("aria-selected", "true");
      const name = document.createElement("td"); name.className = "name";
      const a = document.createElement("a");
      a.href = "#"; a.textContent = row.player;
      a.title = `${row.player}'s all-in hands`;
      a.addEventListener("click", (e) => { e.preventDefault(); openPlayer(row.player); });
      name.appendChild(a);
      tr.appendChild(name);
      for (const [key, , kind] of cols) {
        const td = document.createElement("td");
        const v = value(row, key);
        td.textContent = fmt(v, kind);
        if (v == null) td.className = "dim";
        else if (key === "diff" || key.startsWith("street:")) td.className = v > 0 ? "up" : v < 0 ? "down" : "";
        if (key === "hands" && row.sampled) td.title = `${row.sampled} preflop, sampled`;
        if (key.startsWith("street:")) {
          const s = row.by_street[key.slice(7)];
          td.title = s.hands
            ? `${s.hands} hand${s.hands === 1 ? "" : "s"} · actual ${money(s[unitKey("net")])} · adjusted ${money(s[unitKey("adjusted")])}`
            : "no all-ins stopped on this street";
        }
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }

    const wrap = $("table");
    if (!state.rows.length) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "no players with that many all-in showdowns in this spot";
      wrap.replaceChildren(p);
    } else {
      wrap.replaceChildren(t);
    }
  }

  // ---- drill-down ------------------------------------------------------
  async function openPlayer(name) {
    state.player = name;
    writeUrl();
    document.querySelectorAll("#table tr").forEach(tr => tr.setAttribute("aria-selected", tr.querySelector("td.name a")?.textContent === name));
    const box = $("detail");
    box.classList.remove("hidden");
    $("detail-title").textContent = name;
    $("detail-count").textContent = "";
    $("replay").classList.add("hidden");
    $("graph").replaceChildren();
    $("graph-caption").textContent = "";
    $("hand-rows").replaceChildren(message("loading…"));
    try {
      const q = new URLSearchParams();
      if (state.filter) q.set("filter", state.filter);
      const body = await getJson(`/players/${encodeURIComponent(name)}/allin?` + q);
      state.detail = body;
      renderDetail();
    } catch (e) {
      $("hand-rows").replaceChildren(message(String(e.message || e), "err"));
    }
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function message(text, cls = "muted") {
    const p = document.createElement("p"); p.className = cls; p.textContent = text; return p;
  }

  function renderDetail() {
    const d = state.detail;
    if (!d) return;
    const hands = d.hands;
    $("detail-count").textContent = hands.length
      ? `${hands.length} hand${hands.length === 1 ? "" : "s"} · actual ${money(d[unitKey("net")])} · adjusted ${money(d[unitKey("adjusted")])} · diff ${money(d[unitKey("diff")])}`
      : "no all-in showdowns in this spot";
    renderGraph(hands);
    renderHandRows(hands);
  }

  // Cumulative actual and adjusted, oldest hand first, as two polylines. Hand
  // rolled: two lines and a zero axis do not need a library.
  function renderGraph(hands) {
    const el = $("graph");
    el.replaceChildren();
    $("graph-caption").textContent = "";
    if (!hands.length) return;
    const NS = "http://www.w3.org/2000/svg";
    const W = 800, H = 260, L = 54, R = 14, T = 12, B = 26;
    const actual = [0], adjusted = [0];
    for (const h of hands) {
      actual.push(actual[actual.length - 1] + (h[unitKey("actual")] ?? 0));
      adjusted.push(adjusted[adjusted.length - 1] + (h[unitKey("adjusted")] ?? 0));
    }
    const n = hands.length;
    const lo = Math.min(0, ...actual, ...adjusted), hi = Math.max(0, ...actual, ...adjusted);
    const x = (i) => L + i * (W - L - R) / n;
    const y = (v) => hi === lo ? T + (H - T - B) / 2 : T + (hi - v) * (H - T - B) / (hi - lo);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `cumulative actual and adjusted net over ${n} all-in hands`);
    const mk = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      svg.appendChild(e);
      return e;
    };
    mk("line", { class: "zero", x1: L, x2: W - R, y1: y(0), y2: y(0) });
    for (const v of [hi, 0, lo]) {
      if (v === 0 && (hi === 0 || lo === 0)) continue;
      mk("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, money(v));
    }
    mk("text", { x: W - R, y: H - 6, "text-anchor": "end" }, `${n} all-in hand${n === 1 ? "" : "s"}, oldest first`);
    const pts = (arr) => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    mk("polyline", { class: "adjusted", points: pts(adjusted) });
    mk("polyline", { class: "actual", points: pts(actual) });
    const guide = mk("line", { class: "guide hidden", x1: 0, x2: 0, y1: T, y2: H - B });
    const dotA = mk("circle", { class: "dot actual hidden", r: 3.5 });
    const dotB = mk("circle", { class: "dot adjusted hidden", r: 3.5 });
    const hit = mk("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });

    const point = (i) => {
      const h = hands[i - 1];
      for (const e of [guide, dotA, dotB]) e.classList.remove("hidden");
      guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i));
      dotA.setAttribute("cx", x(i)); dotA.setAttribute("cy", y(actual[i]));
      dotB.setAttribute("cx", x(i)); dotB.setAttribute("cy", y(adjusted[i]));
      $("graph-caption").textContent = `#${h.hand_number} ${h.street} · ${pretty(h.hole_cards)} · eq ${(h.equity * 100).toFixed(1)}%${h.method === "sampled" ? "~" : ""}`
        + ` · hand ${money(h[unitKey("actual")])} vs ${money(h[unitKey("adjusted")])} · running ${money(actual[i])} vs ${money(adjusted[i])}`;
    };
    const locate = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * W / rect.width;
      return Math.max(1, Math.min(n, Math.round((px - L) * n / (W - L - R))));
    };
    hit.addEventListener("mousemove", (ev) => point(locate(ev)));
    hit.addEventListener("click", (ev) => {
      const i = locate(ev);
      point(i);
      const row = $("hand-rows").querySelector(`[data-hand="${hands[i - 1].hand_id}"]`);
      if (row) { row.scrollIntoView({ block: "nearest" }); row.click(); }
    });
    el.appendChild(svg);
  }

  // The server lists oldest first, which is what the graph reads. The list
  // shows newest first like every other hand list, or biggest pot first, or
  // biggest swing first: the hands where the deck moved the most, in the unit
  // on screen. Ties keep newest first.
  function orderedHands(hands) {
    const rows = [...hands].reverse();
    const pot = (h) => h.bb ? h.pot / h.bb : h.pot;
    const swing = (h) => Math.abs(h[unitKey("diff")] ?? 0);
    if (state.handSort === "pot") rows.sort((a, b) => pot(b) - pot(a));
    if (state.handSort === "swing") rows.sort((a, b) => swing(b) - swing(a));
    return rows;
  }

  function renderHandRows(hands) {
    const list = $("hand-rows");
    list.replaceChildren();
    if (!hands.length) { list.appendChild(message("no hands")); return; }
    for (const h of orderedHands(hands)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "hand-row"; b.dataset.hand = h.hand_id;
      b.setAttribute("aria-pressed", "false");
      const span = (cls, text, title) => {
        const s = document.createElement("span"); s.className = cls; s.textContent = text;
        if (title) s.title = title;
        b.appendChild(s); return s;
      };
      span("num", `#${h.hand_number}`, [h.game_id, h.ts].filter(Boolean).join(" · "));
      span("street", h.street, "where the betting stopped");
      span("hole cards", pretty(h.hole_cards));
      span("vs cards", "vs " + h.villains.map(v => `${v.player} ${pretty(v.cards)}`).join(", "));
      const board = span("board cards", h.board.length ? pretty(h.board.join("")) : "no flop",
        h.run_count > 1 ? "ran twice" : "");
      const rest = h.full_board.slice(h.board.length);
      if (rest.length) {
        const r = document.createElement("span"); r.className = "rest";
        r.textContent = (h.board.length ? " " : "") + pretty(rest.join(""));
        r.title = "dealt after the betting stopped";
        board.appendChild(r);
      }
      span("eq", `${(h.equity * 100).toFixed(1)}%${h.method === "sampled" ? "~" : ""}`,
        h.method === "sampled" ? `sampled over ${h.n.toLocaleString()} deals` : `exact over ${h.n.toLocaleString()} board${h.n === 1 ? "" : "s"}`);
      span("pot", `pot ${h.bb ? Math.round(h.pot / h.bb) + "bb" : h.pot.toLocaleString()}`);
      const m = span("money", "");
      const diff = h[unitKey("diff")];
      m.append(`${money(h[unitKey("actual")])} `);
      const small = document.createElement("small");
      small.textContent = `vs ${money(h[unitKey("adjusted")])} · `;
      m.appendChild(small);
      const dv = document.createElement("span");
      dv.textContent = money(diff);
      dv.className = diff > 0 ? "up" : diff < 0 ? "down" : "";
      m.appendChild(dv);
      m.title = "actual, adjusted, diff";
      b.addEventListener("click", () => {
        list.querySelectorAll(".hand-row").forEach(x => x.setAttribute("aria-pressed", x === b));
        pntReplay.show($("replay"), h.hand_id);
      });
      list.appendChild(b);
    }
  }

  function closeDetail() {
    state.player = null;
    state.detail = null;
    writeUrl();
    $("detail").classList.add("hidden");
    document.querySelectorAll("#table tr").forEach(tr => tr.setAttribute("aria-selected", "false"));
  }

  // ---- controls ----------------------------------------------------------
  function apply() {
    state.filter = $("filter").value.trim();
    state.min = Math.max(1, parseInt($("minhands").value, 10) || 1);
    writeUrl(); load();
  }
  $("apply").addEventListener("click", apply);
  $("filter").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  $("minhands").addEventListener("change", apply);
  document.querySelectorAll("[data-unit]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-unit]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.unit = b.dataset.unit;
    writeUrl(); render(); renderDetail();
  }));
  $("detail-close").addEventListener("click", closeDetail);
  $("hands-sort").addEventListener("change", () => {
    state.handSort = $("hands-sort").value;
    writeUrl();
    if (state.detail) renderHandRows(state.detail.hands);
  });

  readUrl();
  $("filter").value = state.filter;
  $("minhands").value = state.min;
  document.querySelectorAll("[data-unit]").forEach(x => x.setAttribute("aria-pressed", x.dataset.unit === state.unit));
  $("hands-sort").value = state.handSort;
  writeUrl();
  load();
})();
