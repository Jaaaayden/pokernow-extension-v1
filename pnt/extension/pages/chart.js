// chart.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  // ---- palette (reference instance; one hue per job) ----------------------
  const BLUE = ["#cde2fb","#9ec5f4","#6da7ec","#3987e5","#256abf","#184f95","#0d366b"];
  const RED  = ["#fbd9d8","#f6b6b5","#ef9291","#e66e6d","#e34948","#b93a39","#8f2d2c"];
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  const dark = () => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  // Ink is chosen from the fill itself, not from the theme: in dark mode the
  // biggest values sit on the palest step and need dark ink there.
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const c = [16, 8, 0].map(s => ((n >> s) & 255) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const inkClass = (hex) => hex.startsWith("#") ? (lum(hex) > 0.35 ? "on-light" : "on-dark") : "";
  // In dark mode "near zero" recedes toward the dark surface, so the ramp runs
  // dark -> light with magnitude instead of light -> dark.
  const ramp = (arr) => dark() ? [...arr].reverse() : arr;

  const PRESETS = [
    ["Any preflop decision", "acted_preflop"],
    ["Opened, single-raised pot", "opener,srp"],
    ["Opened 4bb+", "opener,open_bb>=4,srp"],
    ["Opened 2–3bb", "opener,open_bb<=3,srp"],
    ["3-bet", "3bet"],
    ["Faced a 3-bet", "faced_3bet"],
    ["Facing an open", "faced_open"],
    ["Called an open", "called_open"],
    ["Squeezed", "called_open,faced_3bet_any"],
    ["4-bet", "4bet"],
    ["Facing a 4-bet", "faced_4bet"],
    ["Went to showdown", "wtsd"],
    ["Button", "position=BTN"],
    ["Big blind", "position=BB"],
  ];

  // Bet-size buckets; see "Bet size buckets" in SPEC.md. PokerNow's 1/2, 3/4 and
  // pot buttons each start a bucket.
  const SIZES = [["<½", "small"], ["½–¾", "medium"], ["¾–pot", "large"], ["overbet", "overbet"]];
  // The size words, the bucket rule and card formatting live with the replay
  // renderer (replay.js), which the all-in page shares.
  const { SIZE_LABEL, pretty } = pntReplay;
  const SHORT_SIZE = Object.fromEntries(SIZES.map(([t, b]) => [b, t]));

  // Postflop line chips: one row per street, each holding at most one term, so
  // picking a size replaces "any" or another size on that street.
  const LINES = [
    ["C-bet flop", "cbet_flop", "preflop aggressor bet the flop"],
    ["C-bet turn", "cbet_turn", "flop aggressor bet the turn"],
    ["River bet", "bet_river", "their first river bet"],
  ];
  const KIND_SPOT = { cbet: "c-bet chances", bet: "bets", faced_cbet: "c-bets faced" };
  const KIND_NOTE = {
    cbet: "Each size is a share of their c-bet chances on this street; “checked” is the chances they passed up. Made hands are from the hands that were shown.",
    bet: "Every first bet they made on this street, c-bet or not, split by size. Made hands are from the hands that were shown.",
    faced_cbet: "Split by the size of the c-bet they faced. Made hands are from the hands that called or raised and were shown.",
  };
  const $ = (id) => document.getElementById(id);
  const RANGE_NOTE = $("note").textContent;

  // Board texture chips. Each toggles one `flop=<tag>` term; groups are
  // separated visually but any combination composes (they AND together).
  const TEXTURES = [
    ["ace high", "ace_high"], ["king high", "king_high"], ["queen high", "queen_high"], ["low", "low"], null,
    ["monotone", "monotone"], ["two-tone", "twotone"], ["rainbow", "rainbow"], null,
    ["paired", "paired"], ["unpaired", "unpaired"], null,
    ["connected", "connected"], ["disconnected", "disconnected"], ["all broadway", "all_broadway"],
  ];
  // Jam chips: one row for jamming, one for calling a jam. Each row holds at most
  // one term, `jam` for any street or `jam_<street>` for one.
  const JAM_ROWS = [["Jammed", "jam", "bet or raised all-in"], ["Called jam", "called_jam", "called someone's all-in"]];
  const JAM_STREETS = ["preflop", "flop", "turn", "river"];
  const jamPattern = (key) => new RegExp(`^${key}(_(${JAM_STREETS.join("|")}))?$`);
  const JAM_TERM = /^(faced_|called_)?jam(_\w+)?$/;
  const JAM_NOTE = "A jam everyone folds to is never shown, so a jam range that looks like all value may only mean the bluffs got through.";
  const terms = () => $("filter").value.split(",").map(t => t.trim()).filter(Boolean);
  const hasTerm = (t) => terms().includes(t);
  function toggleTerm(t) {
    const cur = terms();
    const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
    $("filter").value = next.join(",");
  }
  // Replace whatever `key` or `key=<size>` term is present with `term`, or clear
  // the row when `term` was the one already pressed.
  function setGroupTerm(key, term) {
    const cur = terms();
    const pressed = cur.includes(term);
    const next = cur.filter(t => t !== key && !t.startsWith(key + "="));
    if (!pressed) next.push(term);
    $("filter").value = next.join(",");
  }
  // The same for a jam row, whose terms are `key` and `key_<street>`.
  function setJamTerm(key, term) {
    const cur = terms();
    const pressed = cur.includes(term);
    const next = cur.filter(t => !jamPattern(key).test(t));
    if (!pressed) next.push(term);
    $("filter").value = next.join(",");
  }
  // The pot box and the vs picker are two more ways of writing a term into the
  // box above them; the text stays the one source of truth, so they read back
  // whatever is typed there. `pot>=` is the only shape the box writes, but it
  // reads any `pot<op>N` so a hand-typed `pot>500` still shows up. `pot_bb` is
  // left alone: it is its own term.
  const POT_TERM = /^pot(>=|<=|=|>|<)(\d+(?:\.\d+)?)$/;
  const VS_TERM = /^vs=(.+)$/;
  function setPotTerm(n) {
    const next = terms().filter(t => !POT_TERM.test(t));
    if (n !== "" && Number(n) > 0) next.push(`pot>=${Number(n)}`);
    $("filter").value = next.join(",");
  }
  function setVsTerm(name) {
    const next = terms().filter(t => !VS_TERM.test(t));
    if (name) next.push(`vs=${name}`);
    $("filter").value = next.join(",");
  }
  function syncChips() {
    document.querySelectorAll("button[data-term]").forEach(b => b.setAttribute("aria-pressed", hasTerm(b.dataset.term)));
    const current = $("filter").value.trim();
    document.querySelectorAll("button[data-preset]").forEach(b => b.setAttribute("aria-pressed", b.dataset.preset === current));
    $("clear").disabled = !current;
    const pot = terms().map(t => t.match(POT_TERM)).find(Boolean);
    $("pot").value = pot ? pot[2] : "";
    const vs = terms().map(t => t.match(VS_TERM)).find(Boolean);
    const sel = $("vs");
    const want = vs ? vs[1].trim() : "";
    // A name typed in a different case than the dropdown's still selects it.
    const opt = [...sel.options].find(o => o.value.toLowerCase() === want.toLowerCase());
    sel.value = opt ? opt.value : "";
  }
  const state = { player: null, filter: "", by: "preflop", color: "net", street: "flop", kind: "cbet",
                  table: false, data: null, handRows: null, handSort: "newest", handIds: null,
                  order: null, hide: new Set(), hideSeen: false, review: null,
                  game: null, games: null, played: true, session: null, split: false };

  // The side-by-side layout is a per-viewer setting, kept in this browser only.
  // Storage can be missing or throw (private windows, blocked site data), and the
  // page must work the same without it.
  const LAYOUT_KEY = "pnt.reviewLayout";
  try { state.split = localStorage.getItem(LAYOUT_KEY) === "split"; } catch { /* stacked */ }

  // ---- hand review ------------------------------------------------------
  // Both views read one endpoint and split its rows by group; see "Hand review"
  // in SPEC.md for what each flag means.
  const REVIEW_VIEWS = ["review", "beats"];
  const isReview = (view) => REVIEW_VIEWS.includes(view);
  // The session view lists every hand of one game, flagged or not, with the same
  // marks and notes as the review views. Those three are the "list views".
  const SESSION_VIEW = "session";
  const isListView = (view) => isReview(view) || view === SESSION_VIEW;
  const VIEWS = ["preflop", "made", "sizing", ...REVIEW_VIEWS, SESSION_VIEW];
  const REVIEW_KINDS = {
    review: [["missed_bluff", "Missed bluff"], ["missed_value", "Missed value"], ["failed_bluff", "Failed bluff"]],
    beats: [["suckout", "Suckout"], ["cooler_pre", "Preflop cooler"], ["cooler_post", "Postflop cooler"]],
  };
  const KIND_LABEL = Object.fromEntries(Object.values(REVIEW_KINDS).flat());
  const ALL_KINDS = Object.keys(KIND_LABEL);
  // The first order of each view is its default.
  const ORDERS = { review: ["newest", "pot"], beats: ["newest", "pot", "swing"], session: ["hand", "newest", "pot", "swing"] };
  const ORDER_NAMES = ORDERS.session;
  const orderOf = (view) => ORDERS[view].includes(state.order) ? state.order : ORDERS[view][0];
  const REVIEW_NOTE = {
    review: "A flag is a prompt to open the replay, not a verdict. Missed bluffs and missed value need every live hand shown, so they come from showdowns only; a failed bluff also counts bluffs given up on before showdown.",
    session: "Every hand of the session, in the order it was dealt. Flagged hands carry their flag; tick a hand off or write on it as you go.",
    beats: "Bookkeeping. Suckouts and preflop coolers are all-in showdowns with every hand shown, their equity taken where the betting stopped; a postflop cooler is a stacks hand already behind on a dry board.",
  };

  // ---- URL state so the page can be bookmarked or embedded --------------
  const readUrl = () => {
    const q = new URLSearchParams(location.search);
    state.player = q.get("player");
    state.filter = q.get("filter") || "";
    state.by = VIEWS.includes(q.get("by")) ? q.get("by") : "preflop";
    state.order = ORDER_NAMES.includes(q.get("order")) ? q.get("order") : null;
    state.game = q.get("game") || null;
    state.played = q.get("played") !== "all";
    state.hide = new Set((q.get("hide") || "").split(",").filter(k => ALL_KINDS.includes(k)));
    state.hideSeen = q.get("seen") === "hide";
    const c = q.get("color") === "freq" ? "pfr" : q.get("color");
    state.color = ["net","pfr","size"].includes(c) ? c : "net";
    state.street = ["turn", "river"].includes(q.get("street")) ? q.get("street") : "flop";
    state.kind = ["bet", "faced_cbet"].includes(q.get("kind")) ? q.get("kind") : "cbet";
  };
  const writeUrl = () => {
    const q = new URLSearchParams();
    if (state.player) q.set("player", state.player);
    if (state.filter) q.set("filter", state.filter);
    if (state.by !== "preflop") q.set("by", state.by);
    if (state.color !== "net") q.set("color", state.color);
    if (state.by === "sizing") { q.set("street", state.street); q.set("kind", state.kind); }
    if (isListView(state.by)) {
      if (state.order && state.order !== ORDERS[state.by][0]) q.set("order", state.order);
      if (state.hide.size) q.set("hide", [...state.hide].join(","));
      if (state.hideSeen) q.set("seen", "hide");
    }
    if (state.by === SESSION_VIEW) {
      if (state.game) q.set("game", state.game);
      if (!state.played) q.set("played", "all");
    }
    if (theme) q.set("theme", theme);
    history.replaceState(null, "", "?" + q.toString());
    // An embedder cannot read this page's URL across origins, so hand it out:
    // the HUD's "open ↗" link would otherwise still point at the spot the chart
    // opened on rather than the one being looked at. It carries nothing the
    // embedder did not already put in the URL, so the origin stays open.
    // `player` is sent alongside the URL because the embedder tracks who is on
    // show: the dropdown above can pick someone other than the row that opened
    // the chart, and the HUD has no other way to find out.
    if (parent !== window) parent.postMessage({ type: "pnt-url", url: location.href, player: state.player }, "*");
  };

  // ---- data ------------------------------------------------------------
  async function sendJson(url, opts) {
    const r = await pntFetch(url, opts);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 404 && body.detail === "Not Found") {
        throw new Error("the running server is older than this page: restart `pnt service` (or `pnt serve`)");
      }
      throw new Error(body.detail || `${r.status} ${r.statusText}`);
    }
    return r.json();
  }
  const getJson = (url) => sendJson(url);
  const postJson = (url, body) => sendJson(url, {
    // x-pnt: the server refuses writes without it (see app.py).
    method: "POST", headers: { "Content-Type": "application/json", "x-pnt": "1" }, body: JSON.stringify(body),
  });

  async function loadPlayers() {
    const rows = await getJson("/players");
    const sel = $("player");
    sel.replaceChildren();
    for (const p of rows) {
      const o = document.createElement("option");
      o.value = p.alias; o.textContent = p.alias;
      sel.appendChild(o);
    }
    if (!state.player || !rows.some(p => p.alias === state.player)) state.player = rows[0]?.alias ?? null;
    sel.value = state.player ?? "";
    // The same names as opponents to pick from. Kept in one list rather than
    // minus the player on show: swapping the player must not lose the vs term.
    const vs = $("vs");
    vs.replaceChildren(vs.options[0]);
    for (const p of rows) {
      const o = document.createElement("option");
      o.value = p.alias; o.textContent = p.alias;
      vs.appendChild(o);
    }
    syncChips(); // the dropdown can only show a vs= term once it has the names
  }

  async function load({ quiet = false } = {}) {
    if (!state.player) return;
    if (!quiet) $("card").classList.add("loading");
    $("err").classList.add("hidden");
    state.handRows = null; // the hand set may have grown or changed
    const player = encodeURIComponent(state.player);
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    try {
      if (state.by === SESSION_VIEW) {
        state.data = await loadSession(quiet);
      } else if (isReview(state.by)) {
        // One request serves both views: switching between them re-renders
        // rather than re-fetching, unless the HUD said there are new hands.
        const key = `${state.player}|${state.filter}`;
        if (!quiet && state.review?.key === key) {
          state.data = state.review.data;
        } else {
          state.data = await getJson(`/players/${player}/review?` + q);
          if (!("counts" in state.data)) {
            throw new Error("the running server is older than this page: restart `pnt service` (or `pnt serve`)");
          }
          state.review = { key, data: state.data };
        }
      } else if (state.by === "sizing") {
        q.set("street", state.street); q.set("kind", state.kind);
        state.data = await getJson(`/players/${player}/sizing?` + q);
      } else {
        q.set("by", state.by);
        state.data = await getJson(`/players/${player}/range?` + q);
        const probe = state.data.cells ? Object.values(state.data.cells)[0] : state.data.classes?.[0];
        if (probe && !("hand_ids" in probe)) {
          throw new Error("the running server is older than this page (no hand ids in its data): restart `pnt service` (or `pnt serve`)");
        }
      }
      render();
      loadStrip();
    } catch (e) {
      $("err").textContent = String(e.message || e);
      $("err").classList.remove("hidden");
    } finally {
      $("card").classList.remove("loading");
    }
  }

  // The player's games, newest first, for the session picker. Fetched once per
  // player; a quiet reload (the HUD saying there are new hands) asks again, since
  // a new game may just have started.
  async function loadGames(quiet) {
    if (quiet || state.games?.player !== state.player) {
      const rows = await getJson(`/players/${encodeURIComponent(state.player)}/games`);
      state.games = { player: state.player, rows };
    }
    const rows = state.games.rows;
    // A game the player was not in -- another player's session in the URL, or
    // none asked for -- falls back to their latest.
    if (!rows.some(g => g.game_id === state.game)) state.game = rows[0]?.game_id ?? null;
    const sel = $("session-game");
    sel.replaceChildren();
    for (const g of rows) {
      const o = document.createElement("option");
      o.value = g.game_id;
      const d = new Date(g.first_ts || g.started_at);
      const when = isNaN(d) ? g.game_id : SESSION_DATE.format(d);
      o.textContent = `${when} · ${g.hands} hands${g.bb ? ` · ${g.sb}/${g.bb}` : ""}`;
      o.title = g.game_id;
      sel.appendChild(o);
    }
    sel.value = state.game ?? "";
  }
  const SESSION_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // Every hand of one game, with the flags the review views would give it merged
  // onto the row: one list, so a flagged hand is never shown twice.
  async function loadSession(quiet) {
    await loadGames(quiet);
    const key = `${state.player}|${state.filter}|${state.game}`;
    if (!quiet && state.session?.key === key) return state.session.data;
    const player = encodeURIComponent(state.player);
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    if (state.game) q.set("game", state.game);
    const [hands, review] = state.game
      ? await Promise.all([getJson(`/players/${player}/hands?` + q), getJson(`/players/${player}/review?` + q)])
      : [{ hands: [] }, { hands: [] }];
    if (hands.hands.length && !("reviewed" in hands.hands[0])) {
      throw new Error("the running server is older than this page: restart `pnt service` (or `pnt serve`)");
    }
    const flags = new Map();
    for (const r of review.hands) {
      if (!flags.has(r.hand_id)) flags.set(r.hand_id, []);
      flags.get(r.hand_id).push({ kind: r.kind, label: KIND_LABEL[r.kind] || r.label, group: r.group, why: r.why });
    }
    for (const h of hands.hands) h.flags = flags.get(h.hand_id) || [];
    const data = { player: state.player, filter: state.filter, game: state.game, hands: hands.hands };
    state.session = { key, data };
    return data;
  }

  // ---- render ----------------------------------------------------------
  const fmtBb = (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " bb";
  const fmtPct = (v) => v == null ? "–" : v.toFixed(1) + "%";
  // How each cell's habitual size was decided; see typical_size() in ranges.py.
  const BASIS = {
    mean: "mean; these raises agree",
    median: "median; an outlier raise is present",
    single: "one raise only",
    midpoint: "midpoint of two raises that disagree",
    none: "never raised",
  };
  // "trips" as a detail is a board pair plus one hole card. It used to read "one
  // hole card", which looks like a player who showed one card.
  const DETAIL = { trips: "paired board", set: "set", board_pair: "on board only" };
  const label = (c, detail) => detail ? (DETAIL[c.class] || c.class.replace(/_/g, " ")) : c.class.replace(/_/g, " ");
  // Rows for a made-hand breakdown. A detail that covers every hand of its class
  // is folded into the class row: drawn separately, it repeats the same hands.
  function classRows(classes) {
    const out = [];
    for (const c of classes) {
      const ds = c.details || [];
      if (ds.length === 1 && ds[0].n === c.n) {
        out.push({ c, detail: false, text: `${label(c, false)} · ${label(ds[0], true)}` });
        continue;
      }
      out.push({ c, detail: false, text: label(c, false) });
      for (const dd of ds) out.push({ c: dd, detail: true, text: label(dd, true) });
    }
    return out;
  }
  const TITLE = {
    preflop: "Starting hands", made: "What they had made", sizing: "What they had, by bet size",
    review: "Hands to review", beats: "Bad beats", session: "Session",
  };

  function render() {
    const d = state.data;
    const view = state.by;
    const review = isListView(view);
    const table = state.table && !review;
    if (view === SESSION_VIEW) renderSessionTiles(d);
    else if (review) renderReviewTiles(d, view);
    else if (view === "sizing") renderSizingTiles(d);
    else renderRangeTiles(d);
    $("subtitle").textContent = `${d.player} · ${d.filter || "all hands"}`;
    $("note").textContent = review ? REVIEW_NOTE[view]
      : view === "sizing" ? KIND_NOTE[d.kind]
      : (d.filter || "").split(",").some(t => JAM_TERM.test(t.trim())) ? `${RANGE_NOTE} ${JAM_NOTE}` : RANGE_NOTE;
    $("colorseg").classList.toggle("hidden", view !== "preflop");
    $("sizingctl").classList.toggle("hidden", view !== "sizing");
    $("reviewctl").classList.toggle("hidden", !review);
    $("tabletoggle").classList.toggle("hidden", review);
    $("card-title").textContent = TITLE[view];
    $("grid").classList.toggle("hidden", view !== "preflop" || table);
    $("scale").classList.toggle("hidden", view !== "preflop" || table);
    $("bars").classList.toggle("hidden", view !== "made" || table);
    $("sizing").classList.toggle("hidden", view !== "sizing" || table);
    $("table").classList.toggle("hidden", !table);
    $("review").classList.toggle("hidden", !review);
    applyLayout();
    if (view === SESSION_VIEW) { renderSession(d); return; }
    if (review) { renderReview(d, view); return; }
    if (view === "preflop") renderGrid(d);
    else if (view === "made") renderClassBars($("bars"), d.classes, "");
    else renderSizing(d);
    renderTable(d, view);
  }

  function setRaiseKey(text, small) {
    $("t-raise-k").replaceChildren();
    $("t-raise-k").append(text + " ");
    const sm = document.createElement("small");
    sm.textContent = small;
    $("t-raise-k").appendChild(sm);
  }

  // The tile captions the range views print; the review views swap in their own.
  function setTileKeys(hands, known, cov) {
    $("t-hands-k").textContent = hands; $("t-known-k").textContent = known; $("t-cov-k").textContent = cov;
  }

  function renderRangeTiles(d) {
    setTileKeys("hands in this spot ›", "cards known", "coverage");
    $("t-hands").textContent = d.hands;
    $("t-known").textContent = d.known;
    $("t-cov").textContent = fmtPct(d.coverage);
    const rs = d.raise;
    $("t-raise").textContent = rs ? `${rs.median} bb` : "–";
    setRaiseKey("usual preflop raise", rs
      ? `median · ${rs.mode == null ? "no repeated size" : "mode " + rs.mode} · mean ${rs.mean} · ${rs.min}–${rs.max} · n=${rs.n}`
      : "no raises in this spot");
  }

  function renderSizingTiles(d) {
    setTileKeys("hands in this spot ›", "cards known", "coverage");
    const known = d.blocks.reduce((s, b) => s + b.known, 0);
    // Faced c-bets: only the hands that continued can be shown, so they are the base.
    const base = d.blocks.reduce((s, b) => s + (b.continued ?? b.n), 0);
    $("t-hands").textContent = d.hands;
    $("t-known").textContent = known;
    $("t-cov").textContent = fmtPct(base ? Math.round(1000 * known / base) / 10 : null);
    $("t-raise").textContent = d.spot;
    setRaiseKey(KIND_SPOT[d.kind], `on the ${d.street}`);
  }

  // The rows a review view lists: its own group, minus the flags switched off.
  const reviewRows = (d, view) => d.hands.filter(h =>
    REVIEW_KINDS[view].some(([k]) => k === h.kind) && !state.hide.has(h.kind));

  function renderReviewTiles(d, view) {
    const rows = reviewRows(d, view);
    setTileKeys("hands in this spot ›", "showdowns, every hand shown", "of showdowns shown");
    $("t-hands").textContent = d.examined;
    $("t-known").textContent = d.known_showdowns;
    $("t-cov").textContent = fmtPct(d.showdowns ? Math.round(1000 * d.known_showdowns / d.showdowns) / 10 : null);
    const biggest = Math.max(...rows.map(h => h.pot_bb ?? 0), 0);
    $("t-raise").textContent = rows.length ? `${Math.round(biggest)} bb` : "–";
    const skipped = d.skipped.stack_unknown ? ` · ${d.skipped.stack_unknown} with a stack unknown` : "";
    setRaiseKey("biggest pot flagged", `${rows.length} flagged · ${d.skipped.cards_unknown} showdowns mucked${skipped}`);
  }

  function renderSessionTiles(d) {
    setTileKeys("hands dealt", "hands played", "net");
    const net = d.hands.reduce((s, h) => s + (h.net_bb ?? 0), 0);
    $("t-hands").textContent = d.hands.length;
    $("t-known").textContent = d.hands.filter(played).length;
    $("t-cov").textContent = d.hands.length ? fmtBb(net) : "–";
    $("t-raise").textContent = d.hands.filter(h => h.flags.length).length;
    const seen = d.hands.filter(h => h.reviewed).length;
    setRaiseKey("flagged for review", `${seen} of ${d.hands.length} marked reviewed`);
  }

  // value -> [fillColor, deep?] for the current color mode
  function colorer(d) {
    const cells = Object.values(d.cells).filter(c => c.n > 0);
    if (state.color === "net") {
      const max = Math.max(1, ...cells.map(c => Math.abs(c.net_bb)));
      const B = ramp(BLUE), R = ramp(RED);
      return {
        fill(c) {
          if (c.n === 0) return null;
          const t = Math.sqrt(Math.abs(c.net_bb) / max);
          if (t < 0.05) return "var(--mid)";
          const i = Math.min(6, Math.floor(t * 7));
          return (c.net_bb > 0 ? B : R)[i];
        },
        legend: { left: `−${max.toFixed(0)} bb loss`, right: `+${max.toFixed(0)} bb profit`, steps: [...ramp(RED).slice().reverse(), "var(--mid)", ...ramp(BLUE)] },
      };
    }
    if (state.color === "pfr") {
      // Raise frequency: raised / preflop opportunities, on a fixed 0-100 scale
      // so the same colour means the same percentage on every chart.
      const B = ramp(BLUE);
      return {
        fill(c) {
          if (c.n === 0) return null;
          if (c.raise_pct == null) return "var(--mid)";
          return B[Math.min(6, Math.floor((c.raise_pct / 100) * 7 - 1e-9))];
        },
        legend: { left: "0% raised", right: "100% raised, of preflop decisions", steps: B },
      };
    }
    // raise size, relative to how this player usually sizes in this spot.
    // Gray = at the usual size; red = smaller than usual; blue = larger. The
    // usual size comes from every hand in the spot, shown or not, so it has
    // full coverage. Absolute values live in the tooltip and table. A
    // light->dark ramp on absolute size put a 2bb-opener's whole chart on one
    // step; centring on the median is what makes the exceptions visible.
    const usual = d.raise ? d.raise.median : null;
    const SPAN = 3; // +-3bb from usual reaches the deepest step; beyond saturates
    const B = ramp(BLUE), R = ramp(RED);
    return {
      fill(c) {
        if (c.n === 0) return null;
        if (c.raise_typical == null || usual == null) return "var(--mid)";
        const delta = c.raise_typical - usual;
        if (Math.abs(delta) < 0.25) return "var(--mid)";
        const t = Math.min(1, Math.abs(delta) / SPAN);
        const i = Math.min(6, Math.floor(t * 7 - 1e-9));
        return (delta > 0 ? B : R)[i];
      },
      legend: {
        left: `−${SPAN}bb smaller`,
        right: `+${SPAN}bb larger than usual (${usual == null ? "–" : usual + "bb"})`,
        steps: [...ramp(RED).slice().reverse(), "var(--mid)", ...ramp(BLUE)],
      },
    };
  }

  // Make an element open the hand list for `ids`, by click or Enter.
  function pickable(el, title, ids) {
    el.classList.add("pick");
    const open = () => openHands(title, ids);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); open(); } });
  }

  function renderGrid(d) {
    const col = colorer(d);
    const grid = $("grid");
    grid.replaceChildren();
    for (const row of d.rows) {
      for (const label of row) {
        const c = d.cells[label];
        const el = document.createElement("div");
        el.className = "cell";
        el.tabIndex = 0;
        el.setAttribute("role", "gridcell");
        const l = document.createElement("span"); l.className = "l"; l.textContent = label;
        const n = document.createElement("span"); n.className = "n";
        n.textContent = state.color === "pfr" ? (c.raise_pct == null ? "–" : Math.round(c.raise_pct) + "%")
          : state.color === "size" ? (c.raise_typical == null ? "–" : c.raise_typical)
          : c.n;
        el.append(l, n);
        const f = col.fill(c);
        if (!f) el.classList.add("empty");
        else { el.style.background = f; const k = inkClass(f); if (k) el.classList.add(k); }
        if (c.n > 0) pickable(el, `${label} · shown ${c.n}×`, c.hand_ids);
        el.setAttribute("aria-label", tipText(label, c).join(", "));
        el.addEventListener("pointermove", (ev) => showTip(ev, label, c));
        el.addEventListener("pointerleave", hideTip);
        el.addEventListener("focus", (ev) => showTip(ev, label, c));
        el.addEventListener("blur", hideTip);
        grid.appendChild(el);
      }
    }
    const s = $("scale");
    s.replaceChildren();
    const left = document.createElement("span"); left.textContent = col.legend.left;
    const bar = document.createElement("span"); bar.className = "bar";
    for (const hex of col.legend.steps) { const i = document.createElement("i"); i.style.background = hex; bar.appendChild(i); }
    const right = document.createElement("span"); right.textContent = col.legend.right;
    const note = document.createElement("span"); note.style.marginLeft = "auto"; note.style.color = "var(--muted)";
    note.textContent = state.color === "size"
      ? "outlined = never shown · grey = sized as usual · click a hand to list it"
      : "outlined cells were never shown in this spot · click a hand to list it";
    s.append(left, bar, right, note);
  }

  function tipText(label, c) {
    if (c.n === 0) return [label, "never shown in this spot"];
    const out = [`${label}: shown ${c.n}×`, `net ${fmtBb(c.net_bb)}`, `won ${c.won} of ${c.n}`,
      c.pf_opp ? `raised ${c.pfr} of ${c.pf_opp} preflop decisions (${c.raise_pct}%)` : "no preflop decision"];
    if (c.raise) out.push(`typically ${c.raise_typical}bb (${BASIS[c.raise_basis]}), median ${c.raise.median}, mean ${c.raise.mean}, ${c.raise.min}–${c.raise.max} of ${c.raise.n}`);
    return out;
  }

  function showTip(ev, label, c) {
    const tip = $("tip");
    tip.replaceChildren();
    const big = document.createElement("div"); big.className = "big";
    big.textContent = c.n === 0 ? label : `${c.n}× ${label}`;
    tip.appendChild(big);
    const rows = c.n === 0 ? [["never shown in this spot", ""]] : [
      ["net", fmtBb(c.net_bb)],
      ["won", `${c.won} / ${c.n}`],
      ["raised", c.pf_opp ? `${c.pfr} / ${c.pf_opp} (${c.raise_pct}%)` : "no decision"],
      ...(c.raise ? [
        ["typical raise", c.raise_typical == null ? "–" : `${c.raise_typical} bb`],
        ["from", BASIS[c.raise_basis]],
        ["raise median", `${c.raise.median} bb`],
        ["mode", c.raise.mode == null ? "none repeats" : `${c.raise.mode} bb`],
        ["mean", `${c.raise.mean} bb`],
        ["min – max", `${c.raise.min} – ${c.raise.max}`],
        ["raised", `${c.raise.n} of ${c.n}`],
      ] : [["raised", "0 of " + c.n]]),
    ];
    for (const [k, v] of rows) {
      const r = document.createElement("div"); r.className = "row";
      const kk = document.createElement("span"); kk.textContent = k;
      const vv = document.createElement("b"); vv.textContent = v;
      r.append(kk, vv); tip.appendChild(r);
    }
    tip.style.display = "block";
    const rect = (ev.currentTarget || ev.target).getBoundingClientRect();
    const x = ev.clientX ?? rect.right, y = ev.clientY ?? rect.top;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + 14, innerWidth - w - 8) + "px";
    tip.style.top = Math.min(y + 14, innerHeight - h - 8) + "px";
  }
  function hideTip() { $("tip").style.display = "none"; }

  // Made-hand bars into `bars`. `context` prefixes the hand list's title.
  function renderClassBars(bars, classes, context) {
    bars.replaceChildren();
    if (!classes.length) {
      const p = document.createElement("div"); p.className = "lab"; p.textContent = "no shown hands in this spot";
      bars.appendChild(p); return;
    }
    const max = Math.max(...classes.map(c => c.pct));
    for (const { c, detail, text } of classRows(classes)) {
      const title = `${context}${text} · shown ${c.n}×`;
      const lab = document.createElement("div"); lab.className = "lab" + (detail ? " detail" : "");
      lab.textContent = text;
      lab.tabIndex = 0; lab.setAttribute("role", "button");
      pickable(lab, title, c.hand_ids);
      const track = document.createElement("div"); track.className = "track";
      const fill = document.createElement("div"); fill.className = "fill" + (detail ? " detail" : "");
      fill.style.width = (c.pct / max * 100) + "%";
      track.appendChild(fill);
      pickable(track, title, c.hand_ids);
      const val = document.createElement("div"); val.className = "val";
      val.textContent = fmtPct(c.pct);
      const sm = document.createElement("small"); sm.textContent = `${c.n} · ${fmtBb(c.net_bb)}`;
      val.appendChild(sm);
      bars.append(lab, track, val);
    }
  }

  function blockSummary(d, b) {
    const parts = [`${b.n}× · ${fmtPct(b.pct)} of ${KIND_SPOT[d.kind]}`];
    if (d.kind === "faced_cbet" && b.n) parts.push(`fold ${fmtPct(b.fold)} · call ${fmtPct(b.call)} · raise ${fmtPct(b.raise)}`);
    if (b.n) parts.push(`${b.known} shown (${fmtPct(b.coverage)})`);
    return parts.join(" · ");
  }

  function renderSizing(d) {
    const wrap = $("sizing");
    wrap.replaceChildren();
    if (!d.spot) {
      const p = document.createElement("p"); p.className = "muted";
      p.textContent = `no ${KIND_SPOT[d.kind]} on the ${d.street} in this spot`;
      wrap.appendChild(p); return;
    }
    for (const b of d.blocks) {
      const block = document.createElement("div"); block.className = "block" + (b.n ? "" : " none");
      const h = document.createElement("h3");
      const name = document.createElement("span"); name.textContent = SIZE_LABEL[b.size];
      const sm = document.createElement("small"); sm.textContent = blockSummary(d, b);
      h.append(name, sm);
      if (b.n) {
        const btn = document.createElement("button"); btn.type = "button"; btn.textContent = `${b.n} hands ›`;
        btn.addEventListener("click", () => openHands(`${d.street} ${KIND_SPOT[d.kind]} · ${SIZE_LABEL[b.size]}`, b.hand_ids));
        h.appendChild(btn);
      }
      block.appendChild(h);
      if (b.n) {
        const bars = document.createElement("div"); bars.className = "bars";
        renderClassBars(bars, b.classes, `${SIZE_LABEL[b.size]} · `);
        block.appendChild(bars);
      }
      wrap.appendChild(block);
    }
  }

  function renderTable(d, view) {
    const wrap = $("table");
    wrap.replaceChildren();
    const t = document.createElement("table");
    const head = document.createElement("tr");
    const faced = view === "sizing" && d.kind === "faced_cbet";
    const cols = view === "preflop" ? ["hand", "shown", "net bb", "won", "raise %", "raised / decisions", "typical bb", "from", "median", "mode", "mean", "min", "max"]
      : view === "made" ? ["class", "% of known", "n", "net bb", "won"]
      : ["size", "n", `% of ${KIND_SPOT[d.kind]}`, ...(faced ? ["fold", "call", "raise"] : []), "shown", "coverage"];
    for (const c of cols) { const th = document.createElement("th"); th.textContent = c; head.appendChild(th); }
    t.appendChild(head);
    // Every row stands for a set of hands, so clicking one lists them -- the
    // same drill-down the grid cells and bars have. Without it the table is the
    // one view you cannot get from a number back to the hands behind it.
    const row = (vals, { detail = false, title = null, ids = null } = {}) => {
      const tr = document.createElement("tr");
      vals.forEach((v, i) => { const td = document.createElement("td"); if (detail && i === 0) td.className = "detail"; td.textContent = v ?? "–"; tr.appendChild(td); });
      if (ids?.length) {
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.setAttribute("aria-label", `${title} — list these hands`);
        pickable(tr, title, ids);
      }
      t.appendChild(tr);
    };
    if (view === "preflop") {
      Object.entries(d.cells).filter(([, c]) => c.n > 0).sort((a, b) => b[1].n - a[1].n)
        .forEach(([label, c]) => row([label, c.n, c.net_bb.toFixed(1), c.won,
          c.raise_pct, `${c.pfr} / ${c.pf_opp}`, c.raise_typical, c.raise ? BASIS[c.raise_basis] : null,
          c.raise?.median, c.raise?.mode, c.raise?.mean, c.raise?.min, c.raise?.max],
          { title: `${label} · shown ${c.n}×`, ids: c.hand_ids }));
    } else if (view === "made") {
      for (const { c, detail, text } of classRows(d.classes)) {
        row([text, fmtPct(c.pct), c.n, c.net_bb.toFixed(1), c.won],
          { detail, title: `${text} · shown ${c.n}×`, ids: c.hand_ids });
      }
    } else {
      for (const b of d.blocks) {
        row([SIZE_LABEL[b.size], b.n, fmtPct(b.pct),
          ...(faced ? [fmtPct(b.fold), fmtPct(b.call), fmtPct(b.raise)] : []),
          b.known, fmtPct(b.coverage)],
          { title: `${d.street} ${KIND_SPOT[d.kind]} · ${SIZE_LABEL[b.size]}`, ids: b.hand_ids });
      }
    }
    wrap.appendChild(t);
    const hint = document.createElement("p");
    hint.className = "note";
    hint.style.margin = "10px 0 0";
    hint.textContent = "click a row to list the hands behind it, then a hand to replay it";
    wrap.appendChild(hint);
  }

  // ---- hand list and replay ------------------------------------------------
  const HAND_LIMIT = 300;

  async function handRows() {
    const key = `${state.player}|${state.filter}`;
    if (state.handRows?.key === key) return state.handRows.rows;
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    const body = await getJson(`/players/${encodeURIComponent(state.player)}/hands?` + q);
    // Checked before caching, so a stale answer is never memoized for the session.
    if (body.hands.length && !("ip" in body.hands[0])) {
      throw new Error("the running server is older than this page: restart `pnt service`");
    }
    state.handRows = { key, rows: body.hands };
    return body.hands;
  }

  async function openHands(title, ids) {
    $("hands").classList.remove("hidden");
    $("hands-title").textContent = title;
    $("hands-count").textContent = "";
    $("replay").classList.add("hidden");
    const list = $("hand-rows");
    list.replaceChildren(message("loading…"));
    state.handIds = ids; // remembered so a change of order re-lists the same set
    try {
      const rows = await handRows();
      const want = ids ? new Set(ids) : null;
      renderHandRows(want ? rows.filter(r => want.has(r.hand_id)) : rows);
    } catch (e) {
      list.replaceChildren(message(String(e.message || e), "err"));
    }
    $("hands").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function message(text, cls = "muted") {
    const p = document.createElement("p"); p.className = cls; p.textContent = text; return p;
  }

  // The row has one line; the tooltip is where "who was I facing" is spelled out.
  function handTitle(h) {
    const bits = [[h.game_id, `${h.players} dealt in`, h.ts].filter(Boolean).join(" · ")];
    if (h.ip != null) {
      bits.push((h.ip ? "in position" : "out of position")
        + (h.pos_players > 2 ? ` · acts ${h.pos_order + 1} of ${h.pos_players} postflop` : ""));
    }
    if (h.vs?.length) bits.push("vs " + h.vs.join(", "));
    for (const [st, who] of Object.entries(h.vs_cbet || {})) bits.push(`${st}: ${who} c-bet at them`);
    for (const [st, who] of Object.entries(h.led_into || {})) bits.push(`${st}: could lead into ${who}`);
    return bits.join("\n");
  }

  // Chips first, since that is what the filter takes; blinds alongside when known.
  const fmtPot = (h) => h.bb ? `${h.pot.toLocaleString()} (${Math.round(h.pot / h.bb)}bb)` : h.pot.toLocaleString();

  function renderHandRows(rows) {
    const list = $("hand-rows");
    list.replaceChildren();
    // The server lists newest first; "biggest pot" reorders that, ties newest first.
    if (state.handSort === "pot") rows = [...rows].sort((a, b) => (b.pot ?? -1) - (a.pot ?? -1));
    $("hands-count").textContent = rows.length > HAND_LIMIT
      ? `${state.handSort === "pot" ? "biggest" : "newest"} ${HAND_LIMIT} of ${rows.length}`
      : `${rows.length} hand${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) { list.appendChild(message("no hands")); return; }
    for (const h of rows.slice(0, HAND_LIMIT)) list.appendChild(handRowButton(h, list, $("replay")));
  }

  // One hand as a row: the drill-down list and the review views both build them
  // here, so the two can never drift. `opts.kind`, `opts.vs`, `opts.sizes` and
  // `opts.why` let a review row say what it was flagged for.
  function handRowButton(h, list, replayBox, opts = {}) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "hand-row"; b.setAttribute("aria-pressed", "false");
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; b.appendChild(s); return s; };
    if (opts.kind) span("kind", opts.kind.text).dataset.group = opts.kind.group;
    span("num", `#${h.hand_number}`);
    // Whether they closed the action, not where they sat: every postflop stat
    // on these pages is defined against an aggressor, not against a seat.
    span("pos", h.ip == null ? "–" : h.ip ? "IP" : "OOP");
    // One name plus a count. The row is a wrapping flexbox and three names
    // break it; the full list is in the tooltip.
    span("vs", opts.vs ?? (h.vs?.length
      ? `vs ${h.vs[0]}${h.vs.length > 1 ? ` +${h.vs.length - 1}` : ""}` : ""));
    span("hole cards", h.hole_cards ? pretty(h.hole_cards) : "?? ??");
    span("board cards", h.board.length ? pretty(h.board.join("")) : "no flop");
    span("pot", h.pot == null ? "" : `pot ${fmtPot(h)}`);
    span("sizes", opts.sizes ?? Object.entries(h.bet_size).map(([s, z]) => `${s} ${SHORT_SIZE[z]}`).join(" · "));
    span("net", h.net_bb == null ? "–" : fmtBb(h.net_bb));
    if (opts.why) span("why", opts.why);
    b.title = handTitle(h) + (opts.title ? "\n" + opts.title : "");
    b.addEventListener("click", () => {
      list.querySelectorAll(".hand-row").forEach(x => x.setAttribute("aria-pressed", x === b));
      pntReplay.show(replayBox, h.hand_id);
    });
    return b;
  }

  // Newest is the server's order; the others sort that, ties staying newest first.
  function orderReview(rows, view) {
    const order = orderOf(view);
    // Hand order is the order it was dealt: one game, so the hand number is enough.
    if (order === "hand") return [...rows].sort((a, b) => a.hand_number - b.hand_number);
    if (order === "pot") return [...rows].sort((a, b) => (b.pot_bb ?? b.pot ?? -1) - (a.pot_bb ?? a.pot ?? -1));
    if (order === "swing") return [...rows].sort((a, b) => Math.abs(b.diff_bb ?? b.net_bb ?? 0) - Math.abs(a.diff_bb ?? a.net_bb ?? 0));
    return rows;
  }

  // What the row's "sizes" slot says for each flag.
  function reviewDetail(h) {
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (h.kind === "failed_bluff") {
      const size = h.bluff_size ? SHORT_SIZE[h.bluff_size] : h.bluff_pot != null ? `${pct(h.bluff_pot)} pot` : "";
      return [`${h.bluff_kind} ${h.street}`, size, h.answer].filter(Boolean).join(" · ");
    }
    if (h.equity != null && h.street !== "river") return `${pct(h.equity)} to win on the ${h.street}`;
    return [h.eff_bb != null ? `${Math.round(h.eff_bb)}bb deep` : "", h.spr != null ? `SPR ${h.spr}` : ""].filter(Boolean).join(" · ");
  }

  function reviewTitle(h) {
    const bits = [];
    if (h.eff_bb != null) bits.push(`effective ${Math.round(h.eff_bb)}bb` + (h.spr != null ? `, SPR ${h.spr} on the flop` : ""));
    for (const v of h.villains) {
      const profile = [v.archetype, v.wtsd_pct != null ? `WTSD ${v.wtsd_pct}%` : null,
        v.folds_river_pct != null ? `folds to river bets ${v.folds_river_pct}%` : null].filter(Boolean).join(", ");
      const range = v.uncapped == null ? "" : v.uncapped ? " · bet or raised earlier: uncapped" : " · only called before: capped";
      bits.push(`${v.player}${v.cards ? " " + pretty(v.cards) : ""}${v.made ? ` (${v.made.label})` : ""}${profile ? " · " + profile : ""}${range}`);
    }
    return bits.join("\n");
  }

  function renderReview(d, view) {
    // Flag chips for this view, each with its count; pressed means listed.
    const chips = $("review-kinds");
    chips.replaceChildren();
    for (const [kind, label] of REVIEW_KINDS[view]) {
      const b = document.createElement("button"); b.type = "button";
      b.dataset.kind = kind;
      b.setAttribute("aria-pressed", !state.hide.has(kind));
      b.append(label);
      const n = document.createElement("small"); n.textContent = d.counts[kind]; b.appendChild(n);
      b.addEventListener("click", () => {
        if (state.hide.has(kind)) state.hide.delete(kind); else state.hide.add(kind);
        writeUrl(); render();
      });
      chips.appendChild(b);
    }
    syncListControls(view);

    const all = reviewRows(d, view);
    const rows = orderReview(listedReview(all), view);
    const list = $("review-rows");
    list.replaceChildren();
    resetReplay();
    setReviewCount();
    if (!rows.length) {
      const hidden = state.hideSeen && all.length;
      list.appendChild(message(hidden ? "every flagged hand here is reviewed" : "nothing flagged in this spot"));
      return;
    }
    for (const h of rows.slice(0, HAND_LIMIT)) {
      const v = h.villains[0];
      const row = handRowButton(h, list, $("review-replay"), {
        kind: { text: KIND_LABEL[h.kind], group: h.group },
        vs: v ? `vs ${v.player}${v.cards ? " " + pretty(v.cards) : ""}${h.villains.length > 1 ? ` +${h.villains.length - 1}` : ""}` : "",
        sizes: reviewDetail(h),
        why: h.why,
        title: reviewTitle(h),
      });
      list.appendChild(reviewedRow(h, row));
    }
  }

  // The controls every list view shares, set for this one: the orders it offers,
  // and the session picker only where there is a session.
  function syncListControls(view) {
    const sort = $("review-sort");
    [...sort.options].forEach(o => { o.hidden = o.disabled = !ORDERS[view].includes(o.value); });
    sort.value = orderOf(view);
    const session = view === SESSION_VIEW;
    $("session-game").classList.toggle("hidden", !session);
    $("session-played").classList.toggle("hidden", !session);
    $("session-played").setAttribute("aria-pressed", state.played);
  }

  // A hand counts as played when they put chips in by choice or saw a flop; a
  // flagged hand is always listed, whatever it was.
  const played = (h) => h.vpip || h.saw_flop;
  const sessionRows = (d) => d.hands.filter(h => !state.played || played(h) || h.flags.length);
  const listRows = (view) => view === SESSION_VIEW ? sessionRows(state.data) : reviewRows(state.data, view);

  function renderSession(d) {
    $("review-kinds").replaceChildren();
    syncListControls(SESSION_VIEW);
    const all = sessionRows(d);
    const rows = orderReview(listedReview(all), SESSION_VIEW);
    const list = $("review-rows");
    list.replaceChildren();
    resetReplay();
    setReviewCount();
    if (!rows.length) {
      list.appendChild(message(!state.game ? "no sessions for this player"
        : state.hideSeen && all.length ? "every hand here is reviewed"
        : d.hands.length ? "no hands played in this spot — turn off Played only" : "no hands in this spot"));
      return;
    }
    for (const h of rows.slice(0, HAND_LIMIT)) {
      const f = h.flags[0];
      const row = handRowButton(h, list, $("review-replay"), {
        kind: f ? { text: f.label, group: f.group } : null,
        why: h.flags.map(x => x.why).filter(Boolean).join(" · ") || undefined,
        title: h.flags.length > 1 ? "flagged: " + h.flags.map(x => x.label).join(", ") : "",
      });
      list.appendChild(reviewedRow(h, row));
    }
  }

  // ---- side by side ------------------------------------------------------
  // In the split layout the replay pane is always there, so the right half does
  // not collapse before a hand is picked.
  function resetReplay() {
    const box = $("review-replay");
    if (state.split && isListView(state.by)) {
      box.classList.remove("hidden");
      box.replaceChildren(message("click a hand to replay it · ↑ ↓ to step through"));
    } else {
      box.classList.add("hidden");
    }
  }

  function applyLayout() {
    const split = state.split && isListView(state.by);
    $("review").classList.toggle("split", split);
    document.body.classList.toggle("wide", split);
    $("review-split").setAttribute("aria-pressed", state.split);
  }

  // ---- marking a hand reviewed, and noting what went wrong ----------------
  // Both are on the hand, and it is the server that holds them: a click or a
  // typed note is not believed until the write comes back. See SPEC.md, "Marking
  // a hand reviewed, and writing down what went wrong", and schema.sql for why
  // neither is stored against the hand id. The two are independent -- unmarking
  // a hand keeps its note.

  const listedReview = (rows) => rows.filter(h => !(state.hideSeen && h.reviewed));

  // How many rows this view lists, how many of its flags are marked, and how
  // many carry a note. Read off state rather than passed in, so a toggle can
  // refresh it without a render.
  function setReviewCount() {
    const all = listRows(state.by);
    const n = listedReview(all).length;
    const seen = all.filter(h => h.reviewed).length;
    const noted = all.filter(h => h.note).length;
    const what = state.by === SESSION_VIEW ? "hand" : "flagged hand";
    const order = $("review-sort").value;
    const head = n > HAND_LIMIT
      ? `${order === "newest" ? "newest" : order === "hand" ? "first" : "top"} ${HAND_LIMIT} of ${n} ${what}s`
      : `${n} ${what}${n === 1 ? "" : "s"}`;
    $("review-count").textContent = [head, seen ? `${seen} reviewed` : "", noted ? `${noted} noted` : ""]
      .filter(Boolean).join(" · ");
  }

  // One hand's rows are one hand: a missed bluff and a beat on the same replay
  // move together, including the rows of the view that is not on show.
  // The session view and the review views hold their own copies of a hand, so a
  // mark made in one is carried into the other.
  function applyToHand(hand_id, fields) {
    for (const hands of new Set([state.data?.hands, state.review?.data.hands, state.session?.data.hands])) {
      for (const other of hands || []) {
        if (other.hand_id === hand_id) Object.assign(other, fields);
      }
    }
  }

  function showErr(e) {
    $("err").textContent = String(e.message || e);
    $("err").classList.remove("hidden");
  }

  function reviewedRow(h, row) {
    const wrap = document.createElement("div");
    wrap.className = "rev-row";
    const marks = document.createElement("div");
    marks.className = "marks";
    const body = document.createElement("div");
    body.className = "rev-body";
    const note = document.createElement("p");
    note.className = "rev-note";

    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "seen";
    const pen = document.createElement("button");
    pen.type = "button";
    pen.className = "note";
    pen.textContent = "✎";

    const paint = () => {
      wrap.dataset.reviewed = String(!!h.reviewed);
      mark.setAttribute("aria-pressed", String(!!h.reviewed));
      mark.textContent = h.reviewed ? "✓" : "";
      mark.title = h.reviewed
        ? `reviewed ${(h.reviewed_at || "").slice(0, 10)} — click to unmark`
        : "mark this hand reviewed";
      mark.setAttribute("aria-label", `hand ${h.hand_number} reviewed`);
      pen.setAttribute("aria-pressed", String(!!h.note));
      pen.title = h.note
        ? `noted ${(h.noted_at || "").slice(0, 10)} — click to edit`
        : "write down what went wrong";
      pen.setAttribute("aria-label", `note on hand ${h.hand_number}`);
      note.textContent = h.note || "";
      note.classList.toggle("empty", !h.note);
    };
    paint();

    mark.addEventListener("click", async () => {
      mark.disabled = true;
      try {
        const out = await postJson(`/hands/${h.hand_id}/reviewed`, { reviewed: !h.reviewed });
        applyToHand(h.hand_id, { reviewed: out.reviewed, reviewed_at: out.reviewed_at });
        // Hidden rows leave the list, which needs the render; otherwise the row
        // is repainted where it is, so an open replay stays open.
        if (state.hideSeen) { render(); return; }
        paint();
        setReviewCount();
      } catch (e) {
        showErr(e);
      } finally {
        mark.disabled = false;
      }
    });

    // The editor replaces the note in place, so the row never moves under the
    // cursor. Ctrl+Enter or leaving the box saves, Escape abandons the edit.
    // `edit` is the row's, not the click's: the pen has to be able to close an
    // editor a previous click opened.
    let edit = null;

    function closeEdit() {
      if (!edit) return;
      // Cleared first: taking the focused box out of the page can fire its own
      // blur, and that handler must find the edit already over.
      const box = edit;
      edit = null;
      box.replaceWith(note);
      paint();
    }

    async function save(box) {
      if (!edit) return;
      if (box.value.trim() === (h.note || "").trim()) { closeEdit(); return; }
      box.disabled = true;
      try {
        const out = await postJson(`/hands/${h.hand_id}/note`, { note: box.value });
        applyToHand(h.hand_id, { note: out.note, noted_at: out.noted_at });
        closeEdit();
        setReviewCount();
      } catch (e) {
        // The note is still in the box, and the box stays open with it.
        box.disabled = false;
        box.focus();
        showErr(e);
      }
    }

    pen.addEventListener("click", () => {
      // A click on the pen while editing has already blurred the box, which
      // saved and closed it; this is the one that opens it again.
      if (edit) { closeEdit(); return; }
      edit = document.createElement("div");
      edit.className = "rev-edit";
      const box = document.createElement("textarea");
      box.value = h.note || "";
      box.setAttribute("aria-label", `note on hand ${h.hand_number}`);
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "Ctrl+Enter or click away to save · Esc to cancel · empty to delete";
      edit.append(box, hint);
      note.replaceWith(edit);
      pen.setAttribute("aria-pressed", "true");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); closeEdit(); }
        else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(box); }
      });
      box.addEventListener("blur", () => save(box));
    });

    marks.append(mark, pen);
    body.append(row, note);
    wrap.append(marks, body);
    return wrap;
  }

  function closeHands() {
    $("hands").classList.add("hidden");
    $("hand-rows").replaceChildren();
    $("replay").classList.add("hidden");
  }

  // ---- postflop strip ------------------------------------------------------
  // The same spot, read as frequencies: how often they c-bet it, fold to one,
  // raise one, or lead into it. Sample sizes are in the tooltips.
  async function loadStrip() {
    const el = $("strip");
    try {
      const q = new URLSearchParams();
      if (state.filter) q.set("filter", state.filter);
      renderStrip(await getJson(`/players/${encodeURIComponent(state.player)}/stats?` + q));
    } catch {
      el.classList.add("hidden"); // an older server has no per-player stats
    }
  }

  function renderStrip(s) {
    const el = $("strip");
    el.replaceChildren();
    const head = document.createElement("div"); head.className = "strip-head";
    const b = document.createElement("b"); b.textContent = "Postflop, in this spot";
    const a = document.createElement("a");
    const q = new URLSearchParams();
    if (state.filter) q.set("filter", state.filter);
    if (theme) q.set("theme", theme);
    a.href = "stats.html?" + q; a.textContent = "all players ›";
    head.append(b, a);
    const grid = document.createElement("div"); grid.className = "strip-grid";
    const cell = (text, cls, title) => {
      const d = document.createElement("div");
      if (cls) d.className = cls;
      d.textContent = text;
      if (title) d.title = title;
      grid.appendChild(d);
    };
    // This strip is rowed by street, so the hover text names the aggressor
    // generically rather than naming a specific previous street.
    const HEADS = [
      ["", ""],
      ["c-bet", "Continuation bet: they were the previous street's aggressor and bet this "
        + "street first-in."],
      ["fold vs c-bet", "How often they fold facing that aggressor's c-bet, counted before "
        + "anyone raises over it."],
      ["raise c-bet", "How often they raise it instead. Same denominator as fold vs c-bet, "
        + "so fold + call + raise = 100%."],
      ["lead", "Lead, or donk bet: betting into the previous street's aggressor before that "
        + "player gets to act."],
      ["c-bet sizes", "Share of their c-bets at each size."],
    ];
    for (const [h, tip] of HEADS) cell(h, "h", tip);
    for (const st of ["flop", "turn", "river"]) {
      const faced = s._opp[`fold_to_cbet_${st}`];
      cell(st, "st");
      cell(fmtPct(s[`cbet_${st}`]), "", `${s._opp[`cbet_${st}`]} c-bet chances`);
      cell(fmtPct(s[`fold_to_cbet_${st}`]), "", `${faced} c-bets faced`);
      cell(fmtPct(s[`raise_cbet_${st}`]), "", `${faced} c-bets faced`);
      cell(fmtPct(s[`donk_${st}`]), "", `${s._opp[`donk_${st}`]} lead chances`);
      const mix = s[`cbet_${st}_sizes`];
      cell(SIZES.map(([lab, k]) => `${lab} ${mix[k].pct == null ? "–" : Math.round(mix[k].pct) + "%"}`).join(" · "),
        "mix", "share of their c-bets at each size");
    }
    el.append(head, grid);
    el.classList.remove("hidden");
  }

  // ---- wiring ----------------------------------------------------------
  function apply() {
    state.player = $("player").value;
    state.filter = $("filter").value.trim();
    state.review = null; // Apply always asks the server again
    state.session = null;
    syncChips();
    closeHands();
    writeUrl();
    load();
  }
  $("apply").addEventListener("click", apply);
  $("clear").addEventListener("click", () => { $("filter").value = ""; apply(); });
  $("filter").addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
  $("player").addEventListener("change", apply);
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.by = b.dataset.view; writeUrl(); load();
  }));
  document.querySelectorAll("[data-color]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-color]").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.color = b.dataset.color; writeUrl(); if (state.data) render();
  }));
  $("street").addEventListener("change", () => { state.street = $("street").value; writeUrl(); load(); });
  $("kind").addEventListener("change", () => { state.kind = $("kind").value; writeUrl(); load(); });
  $("tabletoggle").addEventListener("click", () => {
    state.table = !state.table; $("tabletoggle").setAttribute("aria-pressed", state.table); if (state.data) render();
  });
  $("t-hands-tile").addEventListener("click", () => {
    // The session view is already the list of its hands.
    if (state.player && state.by !== SESSION_VIEW) openHands("All hands in this spot", null);
  });
  // The drill-down list and the review views read separate data; opening a view
  // with the list showing would leave a stale list under the new card.
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", closeHands));
  $("review-sort").addEventListener("change", () => {
    state.order = $("review-sort").value; writeUrl(); if (state.data && isListView(state.by)) render();
  });
  $("session-game").addEventListener("change", () => {
    state.game = $("session-game").value; writeUrl(); load();
  });
  $("session-played").addEventListener("click", () => {
    state.played = !state.played; writeUrl(); if (state.data && state.by === SESSION_VIEW) render();
  });
  $("review-split").addEventListener("click", () => {
    state.split = !state.split;
    try { localStorage.setItem(LAYOUT_KEY, state.split ? "split" : "stacked"); } catch { /* this visit only */ }
    applyLayout();
    // A replay already open stays open; with none, the pane shows its placeholder
    // (or goes away again when leaving the split).
    if (!$("review-rows").querySelector(".hand-row[aria-pressed=true]")) resetReplay();
  });
  // Up and down step through the list, replaying each hand as they land on it.
  $("review-rows").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (e.target.closest("textarea")) return;
    const rows = [...$("review-rows").querySelectorAll(".hand-row")];
    if (!rows.length) return;
    const cur = rows.indexOf(e.target.closest(".hand-row") || $("review-rows").querySelector(".hand-row[aria-pressed=true]"));
    const next = rows[cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)))];
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    next.click();
  });
  $("review-seen").addEventListener("click", () => {
    state.hideSeen = !state.hideSeen;
    $("review-seen").setAttribute("aria-pressed", state.hideSeen);
    writeUrl();
    if (state.data && isListView(state.by)) render();
  });
  $("hands-close").addEventListener("click", closeHands);
  $("hands-sort").addEventListener("change", () => {
    state.handSort = $("hands-sort").value;
    if (!$("hands").classList.contains("hidden")) openHands($("hands-title").textContent, state.handIds);
  });
  $("pot").addEventListener("change", () => { setPotTerm($("pot").value); apply(); });
  $("pot").addEventListener("keydown", (e) => { if (e.key === "Enter") { setPotTerm($("pot").value); apply(); } });
  $("vs").addEventListener("change", () => { setVsTerm($("vs").value); apply(); });
  for (const [name, f] of PRESETS) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = name; b.title = f;
    b.dataset.preset = f;
    // Clicking the preset that is already showing clears it, rather than
    // re-applying the same spot with no way back to all hands.
    b.addEventListener("click", () => {
      $("filter").value = $("filter").value.trim() === f ? "" : f;
      apply();
    });
    $("presets").appendChild(b);
  }
  for (const [name, key, what] of LINES) {
    const row = document.createElement("div"); row.className = "presets";
    const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = name; lbl.title = what;
    row.appendChild(lbl);
    for (const [text, term] of [["any", key], ...SIZES.map(([t, b]) => [t, `${key}=${b}`])]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = term;
      b.dataset.term = term;
      b.addEventListener("click", () => { setGroupTerm(key, term); apply(); });
      row.appendChild(b);
    }
    $("lines").appendChild(row);
  }
  for (const [name, key, what] of JAM_ROWS) {
    const row = document.createElement("div"); row.className = "presets";
    const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = name; lbl.title = what;
    row.appendChild(lbl);
    for (const [text, term] of [["any", key], ...JAM_STREETS.map(s => [s, `${key}_${s}`])]) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = term;
      b.dataset.term = term;
      b.addEventListener("click", () => { setJamTerm(key, term); apply(); });
      row.appendChild(b);
    }
    $("jams").appendChild(row);
  }
  for (const t of TEXTURES) {
    if (!t) { const s = document.createElement("span"); s.className = "sep"; $("textures").appendChild(s); continue; }
    const [name, tag] = t;
    const b = document.createElement("button"); b.type = "button"; b.textContent = name; b.title = `flop=${tag}`;
    b.dataset.term = `flop=${tag}`;
    b.addEventListener("click", () => { toggleTerm(b.dataset.term); apply(); });
    $("textures").appendChild(b);
  }
  $("filter").addEventListener("input", syncChips);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.data && render());

  // The HUD overlay embeds this page and posts {type: "pnt-refresh"} when the
  // player on show has played new hands. Only the data is fetched again: the spot,
  // view and colour mode stay exactly as they are, and nothing flashes while it loads.
  //
  // It posts {type: "pnt-spot", player, filter} as the live hand moves: the spot
  // the action is on, for the player it is on. That goes through the same path
  // as typing the spot and pressing apply -- the box, the chips and the URL all
  // follow, and `writeUrl` reports the result back up so the HUD can tell its own
  // spot from one the user typed. The view and colour mode are left alone unless
  // the message names a view (a tag chip opens the hands behind it in the view
  // that shows them, made hands or sizing): a made-hand view stays a made-hand
  // view as the hand moves.
  addEventListener("message", (e) => {
    // Only the side panel that frames this page steers it: same origin, and its parent.
    if (!e.data || e.source !== parent || e.origin !== location.origin) return;
    if (e.data.type === "pnt-refresh") load({ quiet: true });
    if (e.data.type === "pnt-spot") {
      const player = e.data.player;
      if (player && [...$("player").options].some(o => o.value === player)) $("player").value = player;
      $("filter").value = e.data.filter || "";
      state.player = $("player").value;
      state.filter = $("filter").value.trim();
      if (VIEWS.includes(e.data.by)) {
        state.by = e.data.by;
        document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", x.dataset.view === state.by));
      }
      if (["flop", "turn", "river"].includes(e.data.street)) { state.street = e.data.street; $("street").value = state.street; }
      if (["cbet", "bet", "faced_cbet"].includes(e.data.kind)) { state.kind = e.data.kind; $("kind").value = state.kind; }
      syncChips();
      closeHands();
      writeUrl();
      load({ quiet: true });
    }
  });

  // Embedded in the HUD, a link to the index would navigate the panel away from
  // the chart with no way back, so it only appears in a real tab.
  if (parent !== window) $("crumb").classList.add("hidden");
  readUrl();
  $("filter").value = state.filter;
  $("street").value = state.street;
  $("kind").value = state.kind;
  if (state.order) $("review-sort").value = state.order;
  $("review-split").setAttribute("aria-pressed", state.split);
  $("session-played").setAttribute("aria-pressed", state.played);
  $("review-seen").setAttribute("aria-pressed", state.hideSeen);
  syncChips();
  document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", x.dataset.view === state.by));
  document.querySelectorAll("[data-color]").forEach(x => x.setAttribute("aria-pressed", x.dataset.color === state.color));
  loadPlayers().then(load).catch(e => { $("err").textContent = String(e.message || e); $("err").classList.remove("hidden"); });
})();
