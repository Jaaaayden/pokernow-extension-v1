"""The tracker's JSON API, independent of how it is reached.

Every route is declared once here: its path, the parameters it takes with their
limits, and a handler that returns plain data or raises `ApiError`. Two transports
serve this one table, so they cannot drift apart:

* `pnt.server.app` mounts every route on FastAPI -- the local server that the
  CLI's users and the extension's companion mode talk to over HTTP.
* `pnt.engine` dispatches the same routes with no web framework at all, for the
  copy of the tracker that runs inside the browser extension on Pyodide.

That second use is why nothing here imports FastAPI or pydantic, and why input
checks (a game ID's shape, `min >= 1`, `by` in `preflop|made`) are made here in
plain Python rather than by FastAPI's annotations: both transports must refuse
exactly what the other refuses. `tests/test_api.py` runs every case through both.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import re
import sqlite3
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

from pnt.ingest import log_folder, sync
from pnt.ingest.csv_source import RawEntry, game_id_from_filename, has_hands, parse_csv
from pnt.ingest.importer import (
    apply_aliases,
    export_aliases,
    ingest_entries,
    merge_players,
    rebuild_game,
    rename_player,
    split_identities,
)
from pnt.stats.allin import allin_hand_list, allin_report
from pnt.stats.derive import Facts
from pnt.stats.filters import parse_filter, vocabulary
from pnt.stats.live import snapshot
from pnt.stats.pots import DEFAULT_DAYS, DEFAULT_LIMIT, DEFAULT_MIN_POT, big_pots
from pnt.stats.queries import (
    aggregate,
    display_names,
    facts_cached,
    facts_for,
    hand_list,
    player_games,
    positional_report,
    report,
)
from pnt.stats.ranges import composition, range_grid, sizing_tells
from pnt.stats.review import (
    hand_notes,
    mark_reviewed,
    restore_judgements,
    review_hand_list,
    reviewed_marks,
    set_note,
)
from pnt.stats.tags import tags_for

log = logging.getLogger(__name__)

#: A PokerNow game ID, as `log_folder.GAME_ID`: the one shape allowed near a file name.
GAME_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"


class ApiError(Exception):
    """A request the API refuses: the HTTP status and a message for the caller.

    400 a request that is well-formed but wrong (an unknown filter term),
    404 something named that does not exist, 422 a malformed parameter or body.
    """

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------ the context ---


@dataclass
class Context:
    """What a handler needs from the transport serving it.

    `connect` opens the database. The server opens one connection per request,
    since each runs on a worker thread and a SQLite connection belongs to the
    thread that made it; the in-browser engine has one thread and hands back one
    connection every time. `log_dir` is where captured games are kept as CSVs, or
    None when they are not kept (PNT_SAVE_LOGS=0, or no disk to keep them on).
    """

    connect: Callable[[], sqlite3.Connection]
    db_path: str
    log_dir: Path | None = None

    @cached_property
    def conn(self) -> sqlite3.Connection:
        return self.connect()


# --------------------------------------------------------------- parameters ---

_REQUIRED = object()


@dataclass(frozen=True)
class Param:
    """One path, query or body parameter: its type, default and limits.

    `kind` is str, int, float, bool, or a function that converts a JSON value
    (raising ValueError or TypeError) for anything shaped, like a list of log entries.
    `alias` is the name on the wire when it differs from the handler's.
    """

    kind: Any = str
    default: Any = _REQUIRED
    alias: str | None = None
    ge: float | None = None
    gt: float | None = None
    le: float | None = None
    pattern: str | None = None
    description: str = ""

    @property
    def required(self) -> bool:
        return self.default is _REQUIRED


_TRUE = {"1", "true", "on", "yes"}
_FALSE = {"0", "false", "off", "no"}


def _convert(name: str, p: Param, value: Any, from_text: bool) -> Any:
    """`value` as `p.kind`, within `p`'s limits, or ApiError(422).

    Path and query values arrive as text and are parsed; body values arrive as
    JSON and must already have the right type (a JSON 5 is not the string "5").
    """
    kind = p.kind
    try:
        if kind is bool:
            if isinstance(value, bool):
                out = value
            elif from_text and str(value).lower() in _TRUE | _FALSE:
                out = str(value).lower() in _TRUE
            else:
                raise ValueError("not a boolean")
        elif kind is int:
            if isinstance(value, bool) or not (isinstance(value, int) or from_text):
                raise ValueError("not an integer")
            out = int(value)
        elif kind is float:
            if isinstance(value, bool) or not (isinstance(value, int | float) or from_text):
                raise ValueError("not a number")
            out = float(value)
        elif kind is str:
            if not isinstance(value, str):
                raise ValueError("not a string")
            out = value
        else:
            out = kind(value)
    except (ValueError, TypeError) as exc:
        raise ApiError(422, f"{name}: {exc}") from exc
    if p.ge is not None and out < p.ge:
        raise ApiError(422, f"{name}: must be at least {p.ge:g}")
    if p.gt is not None and out <= p.gt:
        raise ApiError(422, f"{name}: must be more than {p.gt:g}")
    if p.le is not None and out > p.le:
        raise ApiError(422, f"{name}: must be at most {p.le:g}")
    if p.pattern is not None and not re.fullmatch(p.pattern.removeprefix("^").removesuffix("$"), out):
        raise ApiError(422, f"{name}: {out!r} does not match {p.pattern}")
    return out


def _entries(value: Any) -> list[RawEntry]:
    """The /ingest `entries` list: `{entry, at, order}` per log line."""
    if not isinstance(value, list):
        raise TypeError("not a list")
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise TypeError("each entry must be an object")
        entry, at, order = item.get("entry"), item.get("at"), item.get("order")
        if not isinstance(entry, str) or not isinstance(at, str):
            raise TypeError("each entry needs `entry` and `at` as strings")
        if isinstance(order, bool) or not isinstance(order, int):
            raise TypeError("each entry needs `order` as an integer")
        out.append(RawEntry(ord=order, at=at, entry=entry))
    return out


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise TypeError("not a list of strings")
    return value


# ------------------------------------------------------------------- routes ---


@dataclass(frozen=True)
class Route:
    """One endpoint. `params` covers the path and the query string; `body` is the
    fields of a JSON object body, or None for a route that takes none. `page` is
    the static page a browser navigating here gets instead of the JSON."""

    method: str
    path: str
    handler: Callable[..., Any]
    params: Mapping[str, Param] = field(default_factory=dict)
    body: Mapping[str, Param] | None = None
    page: str | None = None
    summary: str = ""

    @cached_property
    def path_names(self) -> frozenset[str]:
        return frozenset(re.findall(r"{(\w+)}", self.path))

    @cached_property
    def regex(self) -> re.Pattern[str]:
        return re.compile("^" + re.sub(r"{(\w+)}", r"(?P<\1>[^/]+)", self.path) + "$")


ROUTES: list[Route] = []


def route(method: str, path: str, *, page: str | None = None, body: Mapping[str, Param] | None = None, **params: Param):
    def register(fn: Callable[..., Any]) -> Callable[..., Any]:
        doc = (fn.__doc__ or "").strip()
        ROUTES.append(Route(method, path, fn, params, body, page, doc.split("\n\n")[0]))
        return fn

    return register


def call(
    r: Route,
    ctx: Context,
    path_params: Mapping[str, str],
    query: Mapping[str, str],
    body: Any = None,
) -> Any:
    """Validate a request against `r` and run its handler."""
    kwargs: dict[str, Any] = {}
    for name, p in r.params.items():
        wire = p.alias or name
        if name in r.path_names:
            kwargs[name] = _convert(wire, p, path_params[name], from_text=True)
        elif wire in query:
            kwargs[name] = _convert(wire, p, query[wire], from_text=True)
        elif p.required:
            raise ApiError(422, f"{wire}: required")
        else:
            kwargs[name] = p.default
    if r.body is not None:
        if not isinstance(body, dict):
            raise ApiError(422, "the body must be a JSON object")
        for name, p in r.body.items():
            if name in body:
                kwargs[name] = _convert(name, p, body[name], from_text=False)
            elif p.required:
                raise ApiError(422, f"{name}: required")
            else:
                kwargs[name] = p.default
    return r.handler(ctx, **kwargs)


def match(method: str, path: str) -> tuple[Route, dict[str, str]]:
    """The route for a request, and its path parameters; ApiError 404/405 if none."""
    allowed = False
    for r in ROUTES:
        m = r.regex.match(path)
        if m:
            if r.method == method:
                return r, m.groupdict()
            allowed = True
    raise ApiError(405, "method not allowed") if allowed else ApiError(404, "Not Found")


# ------------------------------------------------------------------ helpers ---

_GAME_ID = Param(str, pattern=GAME_ID_PATTERN)
_FILTER = "A spot, e.g. '3bet,position=BTN'. See GET /filters."
_GAME = Param(str, None, description="Restrict to one game_id.")


def _predicate(conn: sqlite3.Connection, filter: str | None):
    """Compile a spot filter, or 400 on a term the parser does not know."""
    try:
        return parse_filter(filter, display_names(conn)) if filter else None
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc


def _spot_facts(conn: sqlite3.Connection, alias: str, filter: str | None, game: str | None) -> list[Facts]:
    """One player's hands in a spot: 400 on a bad filter, 404 on an unknown alias."""
    # The name map is what lets `vs=henry` name a person rather than an ID.
    pred = _predicate(conn, filter)
    try:
        facts = facts_for(conn, alias, game)
    except ValueError as exc:
        raise ApiError(404, str(exc)) from exc
    return [f for f in facts if pred(f)] if pred is not None else facts


def _not_found(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """`fn(...)`, with its ValueError (an unknown alias) as a 404."""
    try:
        return fn(*args, **kwargs)
    except ValueError as exc:
        raise ApiError(404, str(exc)) from exc


def save_log(ctx: Context, game_id: str) -> None:
    """Bring the game's CSV in the log folder up to date with the database.

    Tied to rebuilds, not to every ingest: the extension ingests a history walk page
    by page and rebuilds at checkpoints, and a rewrite is O(game) just as a rebuild
    is (~40 ms for an 8,500-line game). Never fails the request -- the database
    already has the lines, and a CSV open in Excel must not stop capture.
    """
    if ctx.log_dir is None:
        return
    conn = ctx.conn
    try:
        # A log deleted since the last save means the game is to go, not to be
        # written straight back out of the database.
        if sync.prune(conn, [game_id]):
            return
        log_folder.save_game(conn, game_id, ctx.log_dir)
        path = log_folder.log_path(ctx.log_dir, game_id)
        if path.exists():
            sync.record_file(conn, path, game_id)
    except (OSError, ValueError, csv.Error, sqlite3.Error) as exc:  # locked, unwritable, malformed
        log.warning("could not save the log for %s to %s: %s", game_id, ctx.log_dir, exc)


# ---------------------------------------------------------------- endpoints ---


@route("GET", "/filters")
def filters(ctx: Context) -> dict:
    """Every term a `filter` parameter understands, grouped, with an example each."""
    return vocabulary()


@route("GET", "/health")
def health(ctx: Context) -> dict:
    """What is in the database, and where it and the log folder are."""
    row = ctx.conn.execute(
        "SELECT (SELECT COUNT(*) FROM hands) h, (SELECT COUNT(*) FROM raw_entries) e,"
        " (SELECT COUNT(*) FROM parse_misses) m"
    ).fetchone()
    return {
        "db": ctx.db_path,
        "hands": row["h"],
        "entries": row["e"],
        "parse_misses": row["m"],
        "log_folder": str(ctx.log_dir) if ctx.log_dir is not None else None,
        # Which process answered: `pnt service restart` tells the new server from
        # one that outlived it on the same port.
        "pid": os.getpid(),
    }


@route(
    "POST",
    "/ingest",
    body={
        "game_id": _GAME_ID,
        "entries": Param(_entries, description="Log lines as {entry, at, order}."),
        "source": Param(str, "extension"),
        "rebuild": Param(
            bool,
            True,
            description="Re-derive the game after ingesting. Live capture may set this False "
            "on most hands and True periodically, since a rebuild is O(game).",
        ),
    },
)
def ingest(ctx: Context, game_id: str, entries: list[RawEntry], source: str, rebuild: bool) -> dict:
    """Accept raw log entries. Idempotent: entries dedupe on (game_id, order).

    This is the endpoint the extension calls. Because it takes *raw log lines* --
    the same ones the CSV export contains -- live capture and backfill run through
    one parser and cannot drift apart.
    """
    conn = ctx.conn
    offered, n_new = ingest_entries(conn, game_id, entries, source)
    # The oldest line stored for the game: the extension's history walk jumps to it
    # when it meets stored lines, rather than assuming everything older is stored.
    oldest = conn.execute("SELECT MIN(ord) FROM raw_entries WHERE game_id = ?", (game_id,)).fetchone()[0]
    out = {"game_id": game_id, "offered": offered, "new": n_new, "oldest": oldest}
    if rebuild and n_new:
        out |= rebuild_game(conn, game_id)
        save_log(ctx, game_id)
    return out


@route("POST", "/rebuild/{game_id}", game_id=_GAME_ID)
def rebuild(ctx: Context, game_id: str) -> dict:
    """Re-derive one game from its stored lines."""
    out = rebuild_game(ctx.conn, game_id)
    save_log(ctx, game_id)
    return out


@route(
    "GET",
    "/stats",
    page="stats.html",
    game=_GAME,
    filter=Param(str, None, description=_FILTER),
    min_hands=Param(int, 1),
)
def stats(ctx: Context, game: str | None, filter: str | None, min_hands: int) -> list[dict]:
    """Per-player stats, optionally restricted to a spot.

    The filter compiles to a predicate over derived per-hand facts, which is only
    possible because actions are stored raw with street and sequence.
    """
    conn = ctx.conn
    return report(conn, game_id=game, min_hands=min_hands, predicate=_predicate(conn, filter))


@route(
    "GET",
    "/allin",
    page="allin.html",
    game=_GAME,
    filter=Param(str, None, description="e.g. 'position=BTN,3bet_pot'"),
    min_hands=Param(int, 1),
)
def allin(ctx: Context, game: str | None, filter: str | None, min_hands: int) -> list[dict]:
    """Per player: all-in showdowns, actual net, all-in adjusted net, and the gap.

    Equities are memoized in `equity_cache`, so the first request after an import
    pays for the sampling once -- about half a second per preflop all-in -- and
    every request after it is a read.
    """
    conn = ctx.conn
    return allin_report(conn, game_id=game, min_hands=min_hands, predicate=_predicate(conn, filter))


@route(
    "GET",
    "/pots",
    page="pots.html",
    days=Param(float, DEFAULT_DAYS, gt=0, description="Window in days, counted back from now."),
    all_time=Param(bool, False, description="Ignore the window and read all of history."),
    min_pot=Param(int, DEFAULT_MIN_POT, ge=0, description="Chips a pot must reach to be listed."),
    game=_GAME,
    player=Param(str, None, description="Only hands this player was dealt into."),
    limit=Param(int, DEFAULT_LIMIT, ge=1, le=500),
)
def pots(
    ctx: Context, days: float, all_time: bool, min_pot: int, game: str | None, player: str | None, limit: int
) -> dict:
    """The biggest pots in a window, largest first -- everyone's, not one player's.

    `all_time` is how "no window" is asked for, since a window of zero days would
    otherwise have to mean two different things. See SPEC.md, "Biggest pots".
    """
    return _not_found(
        big_pots,
        ctx.conn,
        days=None if all_time else days,
        min_pot=min_pot,
        game_id=game,
        player=player,
        limit=limit,
    )


@route("GET", "/players/{alias}/allin", alias=Param(str), filter=Param(str, None, description="e.g. 'vs=henry'"), game=_GAME)
def player_allin(ctx: Context, alias: str, filter: str | None, game: str | None) -> dict:
    """One player's all-in showdowns, oldest first: the rows behind their two lines."""
    pred = _predicate(ctx.conn, filter)
    return {"filter": filter, **_not_found(allin_hand_list, ctx.conn, alias, game, pred)}


@route("GET", "/players/{alias}/review", alias=Param(str), filter=Param(str, None, description="e.g. 'srp,vs=henry'"), game=_GAME)
def player_review(ctx: Context, alias: str, filter: str | None, game: str | None) -> dict:
    """One player's flagged hands, newest first: the mistakes worth a replay and the
    bad beats, one row per hand and flag. See SPEC.md, "Hand review"."""
    pred = _predicate(ctx.conn, filter)
    return {"filter": filter, **_not_found(review_hand_list, ctx.conn, alias, game, pred)}


@route("GET", "/players", page="players.html")
def players(ctx: Context) -> list[dict]:
    """Every canonical player, the PokerNow IDs behind them, and hands per ID.

    Hand counts come straight from `hand_players` rather than through `report()`.
    That is a plain join -- milliseconds -- where the derived path walks every hand
    in the database, and nothing on the players page needs a derived statistic.
    """
    conn = ctx.conn
    counts = {
        r["pn_id"]: r["n"]
        for r in conn.execute("SELECT pn_id, COUNT(*) AS n FROM hand_players GROUP BY pn_id")
    }
    out: dict[str, dict] = {}
    for r in conn.execute(
        "SELECT p.alias, pi.pn_id, pi.last_seen_name, pi.first_seen_at, pi.last_seen_at"
        " FROM players p JOIN player_identities pi ON pi.player_id = p.player_id"
        " ORDER BY p.alias, pi.pn_id"
    ):
        entry = out.setdefault(
            r["alias"], {"alias": r["alias"], "n_ids": 0, "hands": 0, "identities": []}
        )
        entry["n_ids"] += 1
        entry["hands"] += counts.get(r["pn_id"], 0)
        entry["identities"].append(
            {
                "pn_id": r["pn_id"],
                "name": r["last_seen_name"],
                "hands": counts.get(r["pn_id"], 0),
                "first_seen_at": r["first_seen_at"],
                "last_seen_at": r["last_seen_at"],
            }
        )
    rows = list(out.values())
    for entry in rows:
        # Kept for callers written against the original shape -- the chart page's
        # dropdown among them.
        entry["pn_ids"] = ",".join(i["pn_id"] for i in entry["identities"])
        entry["names"] = ",".join(
            dict.fromkeys(i["name"] for i in entry["identities"] if i["name"])
        )
    return rows


@route("GET", "/players/{alias}/positions", alias=Param(str), split_by_size=Param(bool, False))
def positions(ctx: Context, alias: str, split_by_size: bool) -> list[dict]:
    """One player's stats split by position."""
    return _not_found(positional_report, ctx.conn, alias, pool=not split_by_size)


@route("GET", "/players/{alias}/stats", alias=Param(str), filter=Param(str, None, description="e.g. 'srp,flop=ace_high'"), game=_GAME)
def player_stats(ctx: Context, alias: str, filter: str | None, game: str | None) -> dict:
    """One player's stats inside a spot -- what the chart page's postflop strip reads."""
    return {"player": alias, "filter": filter, **aggregate(_spot_facts(ctx.conn, alias, filter, game))}


@route(
    "GET",
    "/players/{alias}/range",
    alias=Param(str),
    filter=Param(str, None, description="e.g. 'opener,open_bb>=4,srp'"),
    by=Param(str, "preflop", pattern="^(preflop|made)$"),
    game=_GAME,
)
def player_range(ctx: Context, alias: str, filter: str | None, by: str, game: str | None) -> dict:
    """The range chart (`by=preflop`) or line composition (`by=made`) for one player.

    Every cell of the 169-grid is present, in chart order, so the client needs no
    card logic of its own.
    """
    facts = _spot_facts(ctx.conn, alias, filter, game)
    out = range_grid(facts) if by == "preflop" else composition(facts)
    return {"player": alias, "filter": filter, "by": by, **out}


@route(
    "GET",
    "/players/{alias}/sizing",
    alias=Param(str),
    street=Param(str, "flop", pattern="^(flop|turn|river)$"),
    kind=Param(str, "cbet", pattern="^(cbet|bet|faced_cbet)$"),
    filter=Param(str, None, description="e.g. 'srp,flop=ace_high'"),
    game=_GAME,
)
def player_sizing(ctx: Context, alias: str, street: str, kind: str, filter: str | None, game: str | None) -> dict:
    """What a player had at each bet size on one street, within a spot."""
    facts = _spot_facts(ctx.conn, alias, filter, game)
    return {"player": alias, "filter": filter, **sizing_tells(facts, street, kind)}


@route("GET", "/players/{alias}/hands", alias=Param(str), filter=Param(str, None, description="e.g. 'cbet_flop=overbet'"), game=_GAME)
def player_hands(ctx: Context, alias: str, filter: str | None, game: str | None) -> dict:
    """Every hand in a spot as a compact row, newest first. Replay one with /hands/{id}."""
    conn = ctx.conn
    facts = _spot_facts(conn, alias, filter, game)
    rows = hand_list(facts, display_names(conn))
    # The marks and notes the review rows carry, so any hand -- flagged or not --
    # can be ticked off and written on from the session view.
    marks = reviewed_marks(conn, game)
    notes = hand_notes(conn, game)
    for r in rows:
        key = (r["game_id"], r["hand_number"])
        note = notes.get(key) or {}
        r.update(
            reviewed=key in marks,
            reviewed_at=marks.get(key),
            note=note.get("note"),
            noted_at=note.get("noted_at"),
        )
    return {"player": alias, "filter": filter, "hands": rows}


@route("GET", "/players/{alias}/games", alias=Param(str))
def player_game_list(ctx: Context, alias: str) -> list[dict]:
    """Every game one player was dealt into, newest first: the session view's picker."""
    return _not_found(player_games, ctx.conn, alias)


@route("GET", "/players/{alias}/tags", alias=Param(str), filter=Param(str, None, description="e.g. 'players>=4'"), game=_GAME)
def player_tags(ctx: Context, alias: str, filter: str | None, game: str | None) -> dict:
    """One player's archetype and exploit tags, judged on the hands in a spot.

    Each tag carries the count it was judged on and the filter that puts those
    hands on the chart. See SPEC.md, "Tags", for every rule and threshold.
    """
    return {"player": alias, "filter": filter, **tags_for(_spot_facts(ctx.conn, alias, filter, game))}


@route("GET", "/hands/{hand_id}", hand_id=Param(int))
def hand(ctx: Context, hand_id: int) -> dict:
    """Full replay of one hand -- for spot-checking a stat you do not believe."""
    conn = ctx.conn
    h = conn.execute(
        "SELECT h.*, COALESCE(h.bb, g.bb) AS bb_effective"
        " FROM hands h LEFT JOIN games g ON g.game_id = h.game_id WHERE h.hand_id = ?",
        (hand_id,),
    ).fetchone()
    if h is None:
        raise ApiError(404, "no such hand")
    return {
        "hand": dict(h),
        "players": [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM hand_players WHERE hand_id = ? ORDER BY seats_from_button",
                (hand_id,),
            )
        ],
        # pn_id -> the name a replay should print: the canonical alias when there
        # is one, otherwise the last name PokerNow showed for that ID.
        "names": {
            r["pn_id"]: r["alias"] or r["last_seen_name"] or r["pn_id"]
            for r in conn.execute(
                "SELECT hp.pn_id, p.alias, pi.last_seen_name FROM hand_players hp"
                " LEFT JOIN player_identities pi ON pi.pn_id = hp.pn_id"
                " LEFT JOIN players p ON p.player_id = pi.player_id"
                " WHERE hp.hand_id = ?",
                (hand_id,),
            )
        },
        "actions": [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM actions WHERE hand_id = ? ORDER BY seq", (hand_id,)
            )
        ],
        # Shown after the hand ended -- never part of `players[].hole_cards`.
        "voluntary_shows": [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM voluntary_shows WHERE hand_id = ? ORDER BY ord", (hand_id,)
            )
        ],
    }


def _hand_key(conn: sqlite3.Connection, hand_id: int) -> sqlite3.Row:
    """The (game_id, hand_number) a hand is stored under, or 404.

    Both judgement writes take a `hand_id` -- that is what a row on the page
    already holds -- and store what they are told under the hand's own number in
    its game, which a rebuild does not move. See schema.sql.
    """
    row = conn.execute(
        "SELECT game_id, hand_number FROM hands WHERE hand_id = ?", (hand_id,)
    ).fetchone()
    if row is None:
        raise ApiError(404, "no such hand")
    return row


@route("POST", "/hands/{hand_id}/reviewed", hand_id=Param(int), body={"reviewed": Param(bool, True)})
def set_reviewed(ctx: Context, hand_id: int, reviewed: bool) -> dict:
    """Mark one hand as reviewed, or clear the mark.

    Stored under the hand's (game_id, hand_number) -- see `_hand_key` -- so the
    mark survives the rebuild that gives the hand a new id.
    """
    row = _hand_key(ctx.conn, hand_id)
    at = mark_reviewed(ctx.conn, row["game_id"], row["hand_number"], reviewed)
    return {
        "hand_id": hand_id,
        "game_id": row["game_id"],
        "hand_number": row["hand_number"],
        "reviewed": at is not None,
        "reviewed_at": at,
    }


@route("GET", "/reviewed", game=_GAME)
def reviewed(ctx: Context, game: str | None) -> list[dict]:
    """Every hand marked reviewed, newest mark first."""
    marks = reviewed_marks(ctx.conn, game)
    return [
        {"game_id": g, "hand_number": n, "reviewed_at": at}
        for (g, n), at in sorted(marks.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    ]


@route(
    "POST",
    "/hands/{hand_id}/note",
    hand_id=Param(int),
    body={"note": Param(str, "", description="Empty, or nothing but spaces, clears the note.")},
)
def write_note(ctx: Context, hand_id: int, note: str) -> dict:
    """Write down what went wrong in one hand, or clear the note.

    Keyed like the mark, and addressed by `hand_id` for the same reason. Setting a
    note does not mark the hand reviewed and clearing the mark does not erase the
    note: the two are separate judgements, and a hand you have written a question
    about is often one you have not finished with.
    """
    row = _hand_key(ctx.conn, hand_id)
    saved = set_note(ctx.conn, row["game_id"], row["hand_number"], note)
    return {
        "hand_id": hand_id,
        "game_id": row["game_id"],
        "hand_number": row["hand_number"],
        "note": saved["note"] if saved else None,
        "noted_at": saved["noted_at"] if saved else None,
    }


@route("GET", "/notes", game=_GAME)
def notes(ctx: Context, game: str | None) -> list[dict]:
    """Every hand you have written a note on, newest note first."""
    rows = hand_notes(ctx.conn, game)
    return [
        {"game_id": g, "hand_number": n, **v}
        for (g, n), v in sorted(rows.items(), key=lambda kv: (kv[1]["noted_at"], kv[0]), reverse=True)
    ]


@route("GET", "/hud/{game_id}", game_id=_GAME_ID)
def hud(ctx: Context, game_id: str) -> dict:
    """Stats for everyone currently at a table, keyed by PokerNow ID.

    Keyed by `pn_id` rather than seat on purpose: the overlay must re-resolve
    seat -> player every hand from the live dealt-in roster, because seats are
    reused as players come and go.

    Each seat carries two reports with identical keys: `stats`, lifetime across
    every game and merged identity, and `session`, this game alone -- the pair
    the overlay prints side by side so a player drifting from their history is
    visible while it happens. Both come from `report()`, whose cache is keyed on
    the game, so a 30-second poll re-derives nothing between hands.

    `tags` is the player's lifetime archetype and exploit tags (SPEC.md, "Tags").
    They read the same per-alias `Facts` cache `/live` fills on every poll, so
    they cost a few milliseconds on top of it.
    """
    conn = ctx.conn
    latest = conn.execute(
        "SELECT hand_id FROM hands WHERE game_id = ? ORDER BY ord DESC LIMIT 1",
        (game_id,),
    ).fetchone()
    if latest is None:
        raise ApiError(404, "no hands for that game")
    seated = conn.execute(
        "SELECT hp.pn_id, hp.seat, p.alias FROM hand_players hp"
        " LEFT JOIN player_identities pi ON pi.pn_id = hp.pn_id"
        " LEFT JOIN players p ON p.player_id = pi.player_id"
        " WHERE hp.hand_id = ?",
        (latest["hand_id"],),
    ).fetchall()

    by_alias = {r["player"]: r for r in report(conn)}
    by_session = {r["player"]: r for r in report(conn, game_id=game_id)}
    return {
        "game_id": game_id,
        "seats": [
            {
                "seat": r["seat"],
                "pn_id": r["pn_id"],
                "alias": r["alias"],
                # Lifetime stats across every game and every merged identity --
                # not just this session.
                "stats": by_alias.get(r["alias"], {"hands": 0}),
                # The same figures over this game only.
                "session": by_session.get(r["alias"], {"hands": 0}),
                # Lifetime tags; a seat with no identity yet has none.
                "tags": tags_for(facts_cached(conn, r["alias"]) if r["alias"] else []),
            }
            for r in seated
        ],
    }


@route(
    "GET",
    "/live/{game_id}",
    game_id=_GAME_ID,
    min_hands=Param(int, 1, alias="min", ge=1, description="hands a spot needs before it counts"),
    min_known=Param(
        int, 5, alias="known", ge=0, description="shown hands a spot narrowed to this board's texture must keep"
    ),
)
def live(ctx: Context, game_id: str, min_hands: int, min_known: int) -> dict:
    """The hand in progress: everyone's spot right now, resolved against their history.

    Read straight from the raw lines, so it needs no rebuild and is current as of
    the last poll. Between hands it is `{"hand": null}`. Each player still in
    carries `resolved`: the closest spot with at least `min` hands behind it, the
    filter that names it (paste it into the chart), how they played it there, and
    what they showed up with per decision (`showings`), read on the live street.
    A postflop spot is narrowed to boards like this one while at least `known`
    shown hands survive the narrowing.
    """
    return snapshot(ctx.conn, game_id, min_hands=min_hands, min_known=min_known)


@route("POST", "/aliases/merge", body={"source": Param(str), "target": Param(str)})
def merge(ctx: Context, source: str, target: str) -> dict:
    """Fold every ID of `source` into `target`. Returns the IDs that moved.

    The IDs are returned, not just counted, so the caller can undo this: the source
    player row is deleted here, and this list is the only remaining record of what
    was behind it. `POST /aliases/split` with it puts things back.
    """
    moved = _not_found(merge_players, ctx.conn, source, target)
    return {
        "moved": len(moved),
        "pn_ids": moved,
        "source": source,
        "target": target,
        "undo": {"pn_ids": moved, "alias": source},
    }


def _bad_request(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc


@route("POST", "/aliases/split", body={"pn_ids": Param(_strings), "alias": Param(str)})
def split(ctx: Context, pn_ids: list[str], alias: str) -> dict:
    """Move PokerNow IDs onto a new player. Undo for a merge, and the fix when two
    people were joined by mistake."""
    n = _bad_request(split_identities, ctx.conn, pn_ids, alias)
    return {"moved": n, "alias": alias, "pn_ids": pn_ids}


@route("POST", "/aliases/rename", body={"old": Param(str), "new": Param(str)})
def rename(ctx: Context, old: str, new: str) -> dict:
    """Give a player a new alias."""
    _bad_request(rename_player, ctx.conn, old, new)
    return {"old": old, "new": new.strip()}


# ------------------------------------------------------------ getting hands in ---

#: The sample corpus `pnt import` falls back to, shipped with the package and in the
#: extension's engine zip. Redacted and anonymized: see pnt/logs/README.md.
SAMPLE_DIR = Path(__file__).parent / "logs"


def _import_entries(ctx: Context, game_id: str, entries: list[RawEntry], source: str) -> dict:
    """One export's lines in, and its game rebuilt when they brought anything."""
    if not has_hands(entries):
        return {"game_id": game_id, "hands": 0, "skipped": "no hand in this log"}
    offered, n_new = ingest_entries(ctx.conn, game_id, entries, source)
    known = ctx.conn.execute("SELECT 1 FROM games WHERE game_id = ?", (game_id,)).fetchone()
    out = {"game_id": game_id, "offered": offered, "new": n_new}
    if n_new or not known:
        out |= rebuild_game(ctx.conn, game_id)
        save_log(ctx, game_id)
    return out


@route(
    "POST",
    "/import",
    body={
        "name": Param(str, description="The file's name, as PokerNow exports it: poker_now_log_<game id>.csv"),
        "text": Param(str, description="The file's contents."),
    },
)
def import_export(ctx: Context, name: str, text: str) -> dict:
    """Import one PokerNow log export, sent as text: what the import page does with
    a file dropped on it. Idempotent, like /ingest: lines dedupe on their order."""
    game_id = game_id_from_filename(name)
    if not game_id or not re.fullmatch(GAME_ID_PATTERN.strip("^$"), game_id):
        raise ApiError(422, f"{name}: not named like a PokerNow export (poker_now_log_<game id>.csv)")
    try:
        entries = parse_csv(io.StringIO(text), name)
    except (ValueError, csv.Error) as exc:
        raise ApiError(422, str(exc)) from exc
    return {"file": name, **_import_entries(ctx, game_id, entries, f"csv:{name}")}


@route("POST", "/import/sample")
def import_sample(ctx: Context) -> dict:
    """Import the bundled sample corpus -- someone else's hands, to try things on.
    Its aliases come with it, so its players arrive already merged."""
    paths = sorted(SAMPLE_DIR.glob("poker_now_log_*.csv"))
    if not paths:
        raise ApiError(404, "no sample logs in this build")
    games = []
    for path in paths:
        entries = parse_csv(io.StringIO(path.read_text(encoding="utf-8")), path.name)
        games.append(_import_entries(ctx, game_id_from_filename(path) or path.stem, entries, "sample"))
    aliases = SAMPLE_DIR / "aliases.csv"
    if aliases.exists():
        with aliases.open(encoding="utf-8", newline="") as fh:
            apply_aliases(ctx.conn, [(r["pn_id"], r["alias"]) for r in csv.DictReader(fh)])
    return {"games": len(games), "hands": sum(g.get("hands", 0) for g in games)}


# ----------------------------------------------- moving between two trackers ---
# The built-in tracker and the companion each keep a database. Moving from one to
# the other copies what cannot be rebuilt: every game's raw lines (everything else
# about a game is derived from them) and the judgements (aliases, review marks,
# notes). background.js reads these from one and writes them to the other.


@route("GET", "/export/games")
def export_games(ctx: Context) -> list[dict]:
    """Every game with stored lines, and how many."""
    return [
        {"game_id": r["game_id"], "entries": r["n"]}
        for r in ctx.conn.execute(
            "SELECT game_id, COUNT(*) AS n FROM raw_entries GROUP BY game_id ORDER BY MIN(ord)"
        )
    ]


@route("GET", "/export/games/{game_id}", game_id=_GAME_ID)
def export_game(ctx: Context, game_id: str) -> dict:
    """One game's raw lines, oldest first, in the shape /ingest takes."""
    rows = ctx.conn.execute(
        "SELECT ord, at, entry FROM raw_entries WHERE game_id = ? ORDER BY ord", (game_id,)
    ).fetchall()
    if not rows:
        raise ApiError(404, f"no lines stored for {game_id}")
    return {"game_id": game_id, "entries": [{"entry": r["entry"], "at": r["at"], "order": r["ord"]} for r in rows]}


def _records(value: Any) -> list[dict]:
    if not isinstance(value, list) or not all(isinstance(v, dict) for v in value):
        raise TypeError("not a list of objects")
    return value


def _pairs(value: Any) -> list[tuple[str, str]]:
    """`[[pn_id, alias], ...]`, as `export_aliases` gives them."""
    if not isinstance(value, list) or not all(
        isinstance(v, list) and len(v) == 2 and all(isinstance(x, str) for x in v) for v in value
    ):
        raise TypeError("not a list of [pn_id, alias] pairs")
    return [(i, a) for i, a in value]


@route("GET", "/export/judgements")
def export_judgements(ctx: Context) -> dict:
    """Aliases, review marks and notes: every judgement a person made."""
    return {
        "aliases": [list(pair) for pair in export_aliases(ctx.conn)],
        "reviewed": [
            {"game_id": g, "hand_number": n, "reviewed_at": at} for (g, n), at in reviewed_marks(ctx.conn).items()
        ],
        "notes": [{"game_id": g, "hand_number": n, **v} for (g, n), v in hand_notes(ctx.conn).items()],
    }


@route(
    "POST",
    "/export/judgements",
    body={"aliases": Param(_pairs, []), "reviewed": Param(_records, []), "notes": Param(_records, [])},
)
def import_judgements(
    ctx: Context, aliases: list[tuple[str, str]], reviewed: list[dict], notes: list[dict]
) -> dict:
    """Apply judgements exported from another tracker. Aliases go last in a move --
    after the games, whose identities they name. Safe to apply twice."""
    try:
        moved, unknown = apply_aliases(ctx.conn, aliases)
        n_marks, n_notes = restore_judgements(ctx.conn, reviewed, notes)
    except (KeyError, TypeError, ValueError) as exc:
        raise ApiError(422, f"malformed judgements: {exc}") from exc
    return {"aliases_moved": moved, "aliases_unknown": unknown, "reviewed": n_marks, "notes": n_notes}
