// stats.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  const $ = (id) => document.getElementById(id);
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;

  // Preflop and showdown columns, the same whatever street is selected.
  // [key, header, kind, opportunity key inside `_opp`]
  const BASE = [
    ["hands", "Hands", "int", null],
    ["vpip", "VPIP", "pct", "vpip"],
    ["pfr", "PFR", "pct", "vpip"],
    ["3bet", "3Bet", "pct", "3bet"],
    ["fold_to_3bet", "F3B", "pct", "fold_to_3bet"],
    ["wtsd", "WTSD", "pct", "wtsd"],
    ["wsd", "W$SD", "pct", null],
    ["bb_per_100", "bb/100", "num", null],
  ];
  // Postflop columns, per street. Fold and Raise share one denominator: the
  // c-bets the player faced.
  const POSTFLOP = [
    ["cbet", "C-Bet", "cbet"],
    ["fold_to_cbet", "Fold vs C-Bet", "fold_to_cbet"],
    ["raise_cbet", "Raise C-Bet", "fold_to_cbet"],
    ["donk", "Lead (Donk)", "donk"],
    ["af", "Agg %", "af"],
  ];
  const SIZES = [["small", "<½"], ["medium", "½–¾"], ["large", "¾–pot"], ["overbet", "over"]];
  const OPP_NOUN = {
    cbet: "c-bet chances", fold_to_cbet: "c-bets faced", donk: "lead chances",
    af: "bets, raises, calls and folds",
    vpip: "preflop decisions", "3bet": "3-bet chances", fold_to_3bet: "opens that were 3-bet",
    wtsd: "flops seen",
  };
  // Every postflop stat is defined against the previous street's aggressor, so the
  // header text names them. The street comes from the segmented control.
  const PREV = { flop: "preflop", turn: "flop", river: "turn" };
  const HEAD_TIP = {
    cbet: (s) => `Continuation bet. They were the ${PREV[s]} aggressor and bet the ${s} `
      + `first-in, at the players who came along.`,
    fold_to_cbet: (s) => `How often they fold the ${s} facing that ${PREV[s]} aggressor's `
      + `c-bet. Counted before anyone raises over it.`,
    raise_cbet: (s) => `How often they raise that same c-bet instead. Same denominator as `
      + `Fold vs C-Bet, so fold + call + raise = 100%.`,
    donk: (s) => `Lead, or donk bet. They bet the ${s} into the ${PREV[s]} aggressor, before `
      + `that player gets to act. A bet after a checked-through street is a probe, not a lead.`,
    af: (s) => `Aggression Frequency. Of everything they did on the ${s} bar checking, how often `
      + `it was a bet or a raise rather than a call or a fold. Counts actions, not hands, and `
      + `is the one column here that does not depend on who the aggressor was.`,
  };
  // [what the acronym stands for, what it counts]. One source of truth: the header
  // tooltips and the visible key below the table are both built from this, and
  // hover alone is no use on a touch screen.
  const BASE_TIP = {
    hands: ["", "Hands they were dealt into. Every rate below is over some subset of these, "
      + "so treat a small number here as a warning about all of them."],
    vpip: ["Voluntarily Put $ In Pot",
      "How often they called, bet or raised preflop. Blinds are forced, so they never count. "
      + "The headline looseness number: high means they play a lot of hands."],
    pfr: ["Pre-Flop Raise",
      "How often they raised preflop, over the same hands as VPIP. Compare the two: close "
      + "together is an aggressive player, a wide gap means they call far more than they raise."],
    "3bet": ["Three-Bet", "How often they re-raised someone's open, making it the third level of betting."],
    fold_to_3bet: ["Fold to Three-Bet", "They opened the pot, someone re-raised, and they folded."],
    wtsd: ["Went To Showdown", "Of the flops they saw, how often they were still there at the end."],
    wsd: ["Won $ at Showdown", "Of the showdowns they reached, how often they won money."],
    bb_per_100: ["Big blinds per 100 hands",
      "Their win rate. Positive is profit. Hands from a log that stopped mid-hand are excluded."],
  };

  const state = { filter: "", min: 25, street: "flop", sizes: false, sort: "hands", dir: -1, rows: [] };

  const readUrl = () => {
    const q = new URLSearchParams(location.search);
    state.filter = q.get("filter") || "";
    state.min = Math.max(1, parseInt(q.get("min") || "25", 10) || 25);
    state.street = ["turn", "river"].includes(q.get("street")) ? q.get("street") : "flop";
    state.sizes = q.get("sizes") === "1";
    state.sort = q.get("sort") || "hands";
    state.dir = q.get("dir") === "asc" ? 1 : -1;
  };
  const writeUrl = () => {
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    if (state.min !== 25) q.set("min", state.min);
    if (state.street !== "flop") q.set("street", state.street);
    if (state.sizes) q.set("sizes", "1");
    if (state.sort !== "hands") q.set("sort", state.sort);
    if (state.dir === 1) q.set("dir", "asc");
    if (theme) q.set("theme", theme);
    history.replaceState(null, "", "?" + q.toString());
    const c = new URLSearchParams();
    if (state.filter) c.set("filter", state.filter);
    if (theme) c.set("theme", theme);
    $("chartlink").href = "chart.html?" + c;
    $("allinlink").href = "allin.html?" + c;
  };

  // [key, header, kind, opportunity key, hover text]
  const columns = () => {
    const s = state.street;
    const base = BASE.map(([k, h, kind, opp]) =>
      [k, h, kind, opp, BASE_TIP[k] && [BASE_TIP[k][0], BASE_TIP[k][1]].filter(Boolean).join(" — ")]);
    const post = POSTFLOP.map(([k, h, opp]) => [`${k}_${s}`, h, "pct", `${opp}_${s}`, HEAD_TIP[k]?.(s)]);
    const sizes = state.sizes
      ? SIZES.map(([b, h]) => [`size:${b}`, h, "pct", null,
          `Their ${s} c-bets of this size, as a share of all their ${s} c-bets.`])
      : [];
    return [...base, ...post, ...sizes];
  };

  // Size columns live inside `cbet_<street>_sizes`, so they need their own lookup.
  const value = (row, key) => {
    if (key.startsWith("size:")) {
      const mix = row[`cbet_${state.street}_sizes`];
      return mix ? mix[key.slice(5)].pct : null;
    }
    return row[key];
  };

  const fmt = (v, kind) => {
    if (v == null) return "–";
    if (kind === "int") return String(v);
    if (kind === "num") return (v > 0 ? "+" : "") + v.toFixed(2);
    return v.toFixed(1) + "%";
  };

  // Every rate carries the sample it came from, so a 100% off two hands reads as one.
  function sampleTitle(row, key, opp) {
    if (key.startsWith("size:")) {
      const mix = row[`cbet_${state.street}_sizes`];
      return mix ? `${mix[key.slice(5)].n} of their ${state.street} c-bets` : "";
    }
    if (!opp) return "";
    const n = row._opp?.[opp];
    if (n == null) return "";
    return `${n} ${OPP_NOUN[opp.replace(/_(flop|turn|river)$/, "")] || "chances"}`;
  }

  async function load() {
    $("card").classList.add("loading");
    $("err").classList.add("hidden");
    const q = new URLSearchParams({ min_hands: state.min });
    if (state.filter) q.set("filter", state.filter);
    try {
      const r = await pntFetch("/stats?" + q, { headers: { accept: "application/json" } });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || `${r.status} ${r.statusText}`);
      }
      state.rows = await r.json();
      if (state.rows.length && !("raise_cbet_flop" in state.rows[0])) {
        throw new Error("the running server is older than this page: restart `pnt service`");
      }
      render();
    } catch (e) {
      $("err").textContent = String(e.message || e);
      $("err").classList.remove("hidden");
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
      // An unknown rate sorts last in both directions: it is not a zero.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return state.dir * (av - bv);
    });
    return rows;
  }

  // Built from the columns actually on screen, so it follows the street and the
  // size toggle rather than drifting from them.
  function renderKey(cols) {
    const dl = $("key-list");
    dl.replaceChildren();
    const row = (term, name, def) => {
      const dt = document.createElement("dt"); dt.textContent = term;
      const dd = document.createElement("dd");
      if (name) { const b = document.createElement("b"); b.textContent = name; dd.append(b, " — "); }
      dd.append(def);
      dl.append(dt, dd);
    };
    for (const [key, header, , , tip] of cols) {
      const base = BASE_TIP[key];
      if (base) row(header, base[0], base[1]);
      else row(header, "", tip || `Their ${state.street} c-bets at this size.`);
    }
    row("blank (–)", "", "Not that they never did it: they never faced the spot at all. "
      + "An unknown rate is left blank rather than shown as zero.");
  }

  function render() {
    const cols = columns();
    $("subtitle").textContent = `${state.rows.length} players · ${state.filter || "all hands"} · ${state.street} columns`;
    const t = document.createElement("table");

    if (state.sizes) {
      const groups = document.createElement("tr");
      for (const [text, span] of [["", 1 + BASE.length + POSTFLOP.length], [`c-bet sizes on the ${state.street}`, SIZES.length]]) {
        const th = document.createElement("th");
        th.className = "group"; th.colSpan = span; th.textContent = text;
        groups.appendChild(th);
      }
      t.appendChild(groups);
    }

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
    renderKey(cols);
    addHead("player", "player", "Click a name for their range chart in this same spot.");
    for (const [key, text, , , tip] of cols) addHead(key, text, tip);
    t.appendChild(head);

    for (const row of sorted()) {
      const tr = document.createElement("tr");
      const name = document.createElement("td"); name.className = "name";
      const a = document.createElement("a");
      const q = new URLSearchParams({ player: row.player });
      if (state.filter) q.set("filter", state.filter);
      if (theme) q.set("theme", theme);
      a.href = "chart.html?" + q;
      a.textContent = row.player;
      a.title = `${row.player}'s range chart in this spot`;
      name.appendChild(a);
      tr.appendChild(name);
      for (const [key, , kind, opp] of cols) {
        const td = document.createElement("td");
        const v = value(row, key);
        td.textContent = fmt(v, kind);
        if (v == null) td.className = "dim";
        else if (key === "bb_per_100") td.className = v > 0 ? "up" : v < 0 ? "down" : "";
        const title = sampleTitle(row, key, opp);
        if (title) td.title = title;
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }

    const wrap = $("table");
    if (!state.rows.length) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "no players with that many hands in this spot";
      wrap.replaceChildren(p);
    } else {
      wrap.replaceChildren(t);
    }
  }

  function apply() {
    state.filter = $("filter").value.trim();
    state.min = Math.max(1, parseInt($("minhands").value, 10) || 1);
    writeUrl(); load();
  }
  $("apply").addEventListener("click", apply);
  $("filter").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  $("minhands").addEventListener("change", apply);
  document.querySelectorAll("[data-street]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-street]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.street = b.dataset.street;
    // Keep a postflop sort pointing at the same stat on the street just picked.
    const m = state.sort.match(/^(.*)_(flop|turn|river)$/);
    if (m) state.sort = `${m[1]}_${state.street}`;
    writeUrl(); render();
  }));
  $("sizetoggle").addEventListener("click", () => {
    state.sizes = !state.sizes;
    $("sizetoggle").setAttribute("aria-pressed", state.sizes);
    if (!state.sizes && state.sort.startsWith("size:")) state.sort = "hands";
    writeUrl(); render();
  });

  readUrl();
  $("filter").value = state.filter;
  $("minhands").value = state.min;
  $("sizetoggle").setAttribute("aria-pressed", state.sizes);
  document.querySelectorAll("[data-street]").forEach(x => x.setAttribute("aria-pressed", x.dataset.street === state.street));
  writeUrl();
  load();
})();
