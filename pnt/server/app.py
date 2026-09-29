"""Local HTTP service over the tracker database: the FastAPI face of `pnt.api`.

Exists so the HUD and your analysis scripts read the same data through the same
definitions. The database stays a plain SQLite file on disk, so pandas can open it
directly and ignore this server entirely -- keeping the data out of the browser is
the point, and IndexedDB would have trapped it in one profile.

Every JSON route is declared in `pnt/api.py` and mounted here, so the copy of the
tracker that runs inside the extension (`pnt.engine`) serves exactly the same API.
What lives here is only what an HTTP server on this machine adds: the static pages,
the log-folder sync thread, and the checks on who may call it.

Run with:  pnt serve      (or: uvicorn pnt.server.app:app --port 52000)
"""

from __future__ import annotations

import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from email.message import Message
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi import Path as FastApiPath
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pnt import api
from pnt.db.conn import connect
from pnt.ingest import log_folder, sync

DB_PATH = Path(os.environ.get("PNT_DB", "pokernow.sqlite"))
#: The dashboard pages. They live in the extension, which ships them as its own pages.
PAGES = Path(__file__).parents[1] / "extension" / "pages"

#: Live capture also keeps each game's CSV in the log folder, so the folder stays a
#: running record: every game in the database, as a file `pnt import` could rebuild
#: it from. On unless PNT_SAVE_LOGS=0.
SAVE_LOGS = log_folder.SAVE_LOGS

log = logging.getLogger(__name__)

#: Seconds between log-folder syncs while the server runs; 0 turns them off. Each
#: pass is a stat per file, so a short interval costs nothing between changes.
SYNC_SECONDS = float(os.environ.get("PNT_SYNC_SECONDS", "5"))


def _sync_loop(stop: threading.Event) -> None:
    """Keep the database in step with the log folder until `stop` is set.

    Its own connection: sqlite3 connections belong to the thread that opened them.
    Never raises -- a sync that fails is logged and tried again next interval.
    """
    conn = db()
    skip: dict[str, tuple[int, int]] = {}
    try:
        while True:
            try:
                out = sync.sync_folder(conn, log_folder.LOG_DIR, skip)
                for s in out.imported:
                    if s["entries_new"]:
                        log.info("imported %s: %d new entries", s["file"], s["entries_new"])
                for path, why in out.failed.items():
                    log.warning("could not import %s: %s", path, why)
            except Exception:
                log.exception("log folder sync failed")
                if conn.in_transaction:
                    conn.rollback()
            if stop.wait(SYNC_SECONDS):
                return
    finally:
        conn.close()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    stop = threading.Event()
    worker = None
    if SYNC_SECONDS > 0:
        worker = threading.Thread(target=_sync_loop, args=(stop,), name="log-sync", daemon=True)
        worker.start()
    try:
        yield
    finally:
        stop.set()
        if worker is not None:
            worker.join(timeout=10)


app = FastAPI(title="PokerNow Tracker", version="0.1.0", lifespan=_lifespan)

# This is a local database with no auth, so what reaches it is limited three ways.
#
# * No CORS at all. The extension's background worker is the only other caller,
#   and its host permission lets it read the answers without CORS. An allowlist
#   for PokerNow's origins would only have let PokerNow's own pages read every
#   hand stored here, hole cards included.
# * The Host header must name this machine. A page on a domain that re-points
#   itself at 127.0.0.1 (DNS rebinding) is then refused rather than served.
# * Every write carries WRITE_HEADER. CORS does not stop a cross-site POST from
#   being *sent*, only its answer from being read. A body-less POST (/rebuild)
#   needs no content type at all, and FastAPI before its strict content-type
#   check parsed a body sent with none as JSON, which any open tab can send. A
#   custom header cannot be sent cross-site without a CORS preflight, which this
#   server never grants, so it holds whatever FastAPI does. A foreign Origin is
#   refused too.
LOCAL_HOSTS = ["127.0.0.1", "localhost"]
#: `pnt serve --host` names one more address the server may be reached by.
ALLOWED_HOSTS = LOCAL_HOSTS + [
    h for h in [os.environ.get("PNT_HOST", "")] if h and h not in LOCAL_HOSTS and h not in ("0.0.0.0", "::")
]
WRITE_HEADER = "x-pnt"
_READS = {"GET", "HEAD", "OPTIONS"}


def _trusted_origin(origin: str) -> bool:
    """The extension, or one of this server's own pages."""
    parts = urlsplit(origin)
    return parts.scheme == "chrome-extension" or parts.hostname in ALLOWED_HOSTS


@app.middleware("http")
async def _writes_from_here_only(request: Request, call_next):
    if request.method not in _READS:
        origin = request.headers.get("origin")
        if WRITE_HEADER not in request.headers or (origin is not None and not _trusted_origin(origin)):
            return JSONResponse(
                {"detail": f"writes need the {WRITE_HEADER} header and a local origin"},
                status_code=403,
            )
    return await call_next(request)


app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


def db():
    return connect(DB_PATH)


def _page(name: str) -> HTMLResponse:
    """One of the static pages.

    Re-read from disk on every request, with `no-store` so the browser holds no
    old copy -- but the Python behind it is loaded once, so after changing stat
    code, restart the server (`pnt service restart`).
    """
    return HTMLResponse(
        (PAGES / name).read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/", include_in_schema=False)
def index() -> HTMLResponse:
    """The front door: what is in the database and where everything is.

    Without it, `127.0.0.1:52000` answered 404 and every page had to be reached by
    typing its path -- fine for whoever built it, useless for anyone else.
    """
    return _page("index.html")


@app.get("/chart", include_in_schema=False)
def chart() -> HTMLResponse:
    """The range chart page, also at /chart.html: the address older bookmarks use.

    Query parameters (`?player=henry&filter=opener,srp&by=made&color=size`) seed
    the page state, so a bookmark lands on a specific player and spot.
    """
    return _page("chart.html")


# The pages and their scripts, by file name. The same files are the extension's
# own pages (pnt/extension/pages/): they link to each other relatively and reach
# the API through api.js, so they work from either place. `/stats`, `/allin`,
# `/pots` and `/players` also serve their page to a browser (see `_endpoint`).
_FILE = r"^[a-z][a-z-]*$"


def _pages_file(name: str, suffix: str) -> Path:
    path = PAGES / f"{name}{suffix}"
    if not path.is_file():
        raise HTTPException(404, "Not Found")
    return path


@app.get("/{name}.html", include_in_schema=False)
def page(name: Annotated[str, FastApiPath(pattern=_FILE)]) -> HTMLResponse:
    return _page(_pages_file(name, ".html").name)


@app.get("/{name}.js", include_in_schema=False)
def script(name: Annotated[str, FastApiPath(pattern=_FILE)]) -> Response:
    return Response(
        _pages_file(name, ".js").read_text(encoding="utf-8"),
        media_type="text/javascript",
        headers={"Cache-Control": "no-store"},
    )


def _context() -> api.Context:
    """Read per request: tests (and nothing else) swap SAVE_LOGS and LOG_DIR live."""
    return api.Context(
        connect=db, db_path=str(DB_PATH), log_dir=log_folder.LOG_DIR if SAVE_LOGS else None
    )


async def _json_body(request: Request) -> Any:
    """The request's JSON body, or 422. JSON is only read from a request that says
    it is JSON -- the rule FastAPI applies to its own body parameters."""
    raw = await request.body()
    if not raw:
        raise HTTPException(422, "a JSON body is required")
    ctype = Message()
    ctype["content-type"] = request.headers.get("content-type", "")
    subtype = ctype.get_content_subtype()
    if ctype.get_content_maintype() != "application" or not (subtype == "json" or subtype.endswith("+json")):
        raise HTTPException(422, "the body must be sent as application/json")
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise HTTPException(422, f"the body is not valid JSON: {exc}") from exc


def _endpoint(route: api.Route):
    async def endpoint(request: Request) -> Any:
        # A browser navigating here asks for HTML and gets the page; every other
        # caller (the HUD, a script, curl) asks for anything and gets the JSON.
        if route.page and "text/html" in request.headers.get("accept", ""):
            return _page(route.page)
        body = await _json_body(request) if route.body is not None else None
        try:
            # Handlers are blocking SQLite work, so off the event loop they go.
            return await run_in_threadpool(
                api.call, route, _context(), request.path_params, request.query_params, body
            )
        except api.ApiError as exc:
            raise HTTPException(exc.status, exc.detail) from exc

    endpoint.__name__ = route.handler.__name__
    return endpoint


_SCHEMA_TYPES = {str: "string", int: "integer", float: "number", bool: "boolean"}


def _schema(p: api.Param) -> dict:
    # A shaped kind (a list of log entries) is left untyped rather than described wrong.
    out: dict[str, Any] = {"type": _SCHEMA_TYPES[p.kind]} if p.kind in _SCHEMA_TYPES else {}
    for key, value in (("minimum", p.ge), ("exclusiveMinimum", p.gt), ("maximum", p.le), ("pattern", p.pattern)):
        if value is not None:
            out[key] = value
    if not p.required and p.default is not None:
        out["default"] = p.default
    return out


def _openapi(route: api.Route) -> dict:
    """What /docs shows for a route: the same parameters `api.call` checks."""
    out: dict[str, Any] = {
        "parameters": [
            {
                "name": p.alias or name,
                "in": "path" if name in route.path_names else "query",
                "required": name in route.path_names or p.required,
                "schema": _schema(p),
                "description": p.description,
            }
            for name, p in route.params.items()
        ]
    }
    if route.body is not None:
        properties = {name: {**_schema(p), "description": p.description} for name, p in route.body.items()}
        required = [name for name, p in route.body.items() if p.required]
        out["requestBody"] = {
            "required": True,
            "content": {"application/json": {"schema": {"type": "object", "properties": properties, "required": required}}},
        }
    return out


for _route in api.ROUTES:
    app.add_api_route(
        _route.path,
        _endpoint(_route),
        methods=[_route.method],
        summary=_route.summary or None,
        description=_route.handler.__doc__ or "",
        openapi_extra=_openapi(_route),
    )
