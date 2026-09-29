// players.html's script: a file of its own, since an extension page may run no inline script.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let players = [];
  let openAlias = null;

  const api = async (path, body) => {
    const r = await pntFetch(path, body ? {
      // x-pnt: the server refuses writes without it (see app.py).
      method: "POST", headers: { "content-type": "application/json", "x-pnt": "1" }, body: JSON.stringify(body),
    } : undefined);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `${r.status} ${r.statusText}`);
    return data;
  };

  let toastTimer = null;
  function toast(msg, action) {
    clearTimeout(toastTimer);
    $("toast-msg").textContent = msg;
    $("toast-act").replaceChildren();
    $("toast").classList.toggle("bad", !action && /could not|failed/i.test(msg));
    if (action) {
      const b = document.createElement("button");
      b.className = "small"; b.textContent = action.label;
      b.addEventListener("click", () => { hideToast(); action.run(); });
      $("toast-act").appendChild(b);
    }
    $("toast").classList.remove("hidden");
    // An undo needs long enough to notice and reach; a plain confirmation does not.
    toastTimer = setTimeout(hideToast, action ? 15000 : 4000);
  }
  const hideToast = () => { clearTimeout(toastTimer); $("toast").classList.add("hidden"); };

  async function load() {
    players = await api("/players");
    players.sort((a, b) => b.hands - a.hands);
    $("count").textContent = `${players.length} player${players.length === 1 ? "" : "s"}`
      + ` · ${players.reduce((n, p) => n + p.n_ids, 0)} PokerNow ids`;
    render();
  }

  const fmt = (n) => Number(n).toLocaleString();
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function render() {
    const list = $("list");
    list.replaceChildren();
    if (!players.length) {
      list.appendChild(el("div", "empty", "No players yet — import a log or let the extension capture a hand."));
      return;
    }
    for (const p of players) list.appendChild(card(p));
  }

  function card(p) {
    const card = el("div", "card" + (p.alias === openAlias ? " open" : ""));

    const row = el("div", "row");
    row.appendChild(el("span", "chev", "›"));
    const tw = el("div", "tw");
    tw.appendChild(el("div", "alias", p.alias));
    const names = p.identities.map((i) => i.name).filter(Boolean);
    // The names are the evidence for a merge, so they lead rather than hide in the fold.
    tw.appendChild(el("div", "names", names.length ? names.join(" · ") : "no name recorded"));
    row.appendChild(tw);
    const num = el("div", "num");
    num.appendChild(el("b", null, fmt(p.hands)));
    num.appendChild(el("span", null, `hands · ${p.n_ids} id${p.n_ids === 1 ? "" : "s"}`));
    row.appendChild(num);
    row.addEventListener("click", () => {
      openAlias = p.alias === openAlias ? null : p.alias;
      render();
    });
    card.appendChild(row);

    card.appendChild(body(p));
    return card;
  }

  function body(p) {
    const body = el("div", "body");

    const t = el("table", "ids");
    const hr = document.createElement("tr");
    for (const [h, cls] of [["PokerNow id", ""], ["shown as", ""], ["hands", "r"], ["last seen", "r"]]) {
      const th = el("th", cls, h); hr.appendChild(th);
    }
    t.appendChild(hr);
    const single = p.identities.length === 1;
    for (const i of p.identities) {
      const tr = el("tr", single ? "only" : "");
      tr.appendChild(el("td", "id", i.pn_id));
      tr.appendChild(el("td", null, i.name || "—"));
      tr.appendChild(el("td", "r", fmt(i.hands)));
      tr.appendChild(el("td", "r dim", (i.last_seen_at || "").slice(0, 10) || "—"));
      if (!single) {
        const td = el("td", "r");
        const b = el("button", "small", "split off");
        b.title = `Move ${i.pn_id} onto a player of its own`;
        b.addEventListener("click", (e) => { e.stopPropagation(); splitOne(p, i); });
        td.appendChild(b); tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    body.appendChild(t);

    const acts = el("div", "acts");
    const chart = el("a", "link");
    chart.href = "chart.html?player=" + encodeURIComponent(p.alias);
    chart.textContent = "range chart ↗";
    chart.target = "_blank"; chart.rel = "noopener";
    acts.appendChild(chart);
    const stats = el("a", "link");
    stats.href = "stats.html";
    stats.textContent = "stats ↗";
    stats.target = "_blank"; stats.rel = "noopener";
    acts.appendChild(stats);
    acts.appendChild(el("span", "sep"));

    const rn = el("button", "small", "rename");
    rn.addEventListener("click", (e) => { e.stopPropagation(); doRename(p); });
    acts.appendChild(rn);
    body.appendChild(acts);

    if (players.length > 1) body.appendChild(mergePanel(p));
    return body;
  }

  function mergePanel(p) {
    const wrap = el("div", "sub");
    wrap.appendChild(el("p", null, `If one of the other rows is the same person as ${p.alias}, fold it in here.`));
    const line = el("div", "line");
    line.appendChild(el("span", null, "Merge"));

    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = ""; none.textContent = "choose a player…";
    sel.appendChild(none);
    for (const o of players) {
      if (o.alias === p.alias) continue;
      const opt = document.createElement("option");
      opt.value = o.alias;
      opt.textContent = `${o.alias} (${fmt(o.hands)} hands, ${o.n_ids} id${o.n_ids === 1 ? "" : "s"})`;
      sel.appendChild(opt);
    }
    line.appendChild(sel);
    line.appendChild(el("span", null, `into ${p.alias}`));

    const go = el("button", "primary small", "Merge");
    go.disabled = true;
    sel.addEventListener("change", () => {
      go.disabled = !sel.value;
      preview.replaceChildren();
      if (sel.value) preview.appendChild(previewOf(players.find((x) => x.alias === sel.value), p));
    });
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      doMerge(players.find((x) => x.alias === sel.value), p);
    });
    line.appendChild(go);
    wrap.appendChild(line);

    const preview = el("div");
    wrap.appendChild(preview);
    return wrap;
  }

  function previewOf(source, target) {
    // Shown before the click, not after: a merge deletes the source player row, and
    // the only thing that can put it back is the list of ids being moved.
    const box = el("div", "warnbox");
    box.appendChild(el("b", null, `${source.alias} disappears.`));
    box.append(document.createTextNode(
      ` Its ${source.n_ids} PokerNow id${source.n_ids === 1 ? "" : "s"} and ${fmt(source.hands)} hands`
      + ` move to ${target.alias}, which then has ${fmt(source.hands + target.hands)}.`));
    const ul = document.createElement("ul");
    for (const i of source.identities) {
      const li = document.createElement("li");
      const code = el("code", null, i.pn_id);
      li.appendChild(code);
      li.append(document.createTextNode(` — ${i.name || "no name"}, ${fmt(i.hands)} hands`));
      ul.appendChild(li);
    }
    box.appendChild(ul);
    return box;
  }

  async function doMerge(source, target) {
    try {
      const res = await api("/aliases/merge", { source: source.alias, target: target.alias });
      openAlias = target.alias;
      await load();
      toast(`Merged ${source.alias} into ${target.alias}.`, {
        label: "Undo",
        run: async () => {
          try {
            await api("/aliases/split", { pn_ids: res.undo.pn_ids, alias: res.undo.alias });
            openAlias = res.undo.alias;
            await load();
            toast(`Put ${res.undo.alias} back.`);
          } catch (e) { toast("Could not undo: " + e.message); }
        },
      });
    } catch (e) { toast("Merge failed: " + e.message); }
  }

  async function splitOne(p, identity) {
    const name = prompt(
      `Move ${identity.pn_id} (${identity.name || "no name"}, ${fmt(identity.hands)} hands) off ${p.alias}.\n\n`
      + "Name for the player it moves to:",
      identity.name || identity.pn_id);
    if (name === null) return;
    try {
      await api("/aliases/split", { pn_ids: [identity.pn_id], alias: name.trim() });
      openAlias = name.trim();
      await load();
      toast(`Split ${identity.pn_id} off as ${name.trim()}.`);
    } catch (e) { toast("Split failed: " + e.message); }
  }

  async function doRename(p) {
    const next = prompt(`Rename ${p.alias} to:`, p.alias);
    if (next === null || next.trim() === p.alias) return;
    try {
      await api("/aliases/rename", { old: p.alias, new: next });
      openAlias = next.trim();
      await load();
      toast(`Renamed to ${next.trim()}.`);
    } catch (e) { toast("Rename failed: " + e.message); }
  }

  load().catch((e) => {
    $("err").textContent = "could not load players: " + (e.message || e);
    $("err").classList.remove("hidden");
  });
})();
