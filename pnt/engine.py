"""The tracker's API with no server in front of it.

This is what the browser extension runs on Pyodide when no local server is
installed: the same routes as `pnt.server.app`, from the same table in `pnt.api`,
answered in-process. The extension's background worker hands each request over as
text and gets text back, so nothing but strings crosses from JavaScript to Python:

    engine = Engine("/data/pokernow.sqlite")
    engine.handle_json("GET", "/live/pglX...?min=1&known=5")
    # -> '{"status": 200, "body": {...}}'

Nothing here imports FastAPI, uvicorn or pydantic, and nothing starts a thread:
Pyodide has neither. There is one connection, reused for every request, because
there is one thread to use it; the server instead opens one per request.
"""

from __future__ import annotations

import dataclasses
import json
import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from pnt import api
from pnt.db.conn import connect

log = logging.getLogger(__name__)

_JOURNAL_MODES = {"DELETE", "TRUNCATE", "PERSIST", "MEMORY", "WAL", "OFF"}


def _jsonable(value: Any) -> Any:
    """What `json.dumps` cannot take natively, as FastAPI's encoder would send it."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    if isinstance(value, set | frozenset | tuple):
        return list(value)
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def dumps(value: Any) -> str:
    # allow_nan=False, as Starlette's JSONResponse: NaN is not JSON, and a stat
    # that came out NaN should fail loudly here rather than break the page reading it.
    return json.dumps(value, default=_jsonable, allow_nan=False, separators=(",", ":"))


class Engine:
    """One tracker database, answering API requests in-process."""

    def __init__(
        self,
        db_path: str | Path,
        *,
        log_dir: Path | None = None,
        journal_mode: str | None = None,
        db_label: str | None = None,
    ):
        """`journal_mode` overrides the WAL that `connect` sets. The extension keeps
        the database in memory and saves the whole file between requests, and a WAL
        would hold committed pages outside that file; it passes "MEMORY", which keeps
        rollback working with nothing beside the file.

        `db_label` is what /health says the database is, when a path would mean
        nothing to the person reading it (a file inside the browser's own storage)."""
        if journal_mode is not None and journal_mode.upper() not in _JOURNAL_MODES:
            raise ValueError(f"not a journal mode: {journal_mode!r}")
        self._conn = connect(db_path)
        if journal_mode is not None:
            mode = self._conn.execute(f"PRAGMA journal_mode = {journal_mode}").fetchone()[0]
            if mode.upper() != journal_mode.upper():
                raise RuntimeError(f"journal_mode {journal_mode} refused: still {mode}")
        self.ctx = api.Context(connect=lambda: self._conn, db_path=db_label or str(db_path), log_dir=log_dir)

    def close(self) -> None:
        self._conn.close()

    def handle(
        self, method: str, url: str, body: Any = None, query: Mapping[str, str] | None = None
    ) -> tuple[int, Any]:
        """Answer one request: `(status, data)`, where data is `{"detail": ...}` on an error.

        `url` is a path with an optional query string, as the pages write it
        (`/players/henry/range?filter=srp`); `query` adds parameters to it.
        """
        parts = urlsplit(url)
        params = dict(parse_qsl(parts.query, keep_blank_values=True))
        params.update(query or {})
        try:
            route, path_params = api.match(method.upper(), parts.path)
            path_params = {k: unquote(v) for k, v in path_params.items()}
            if route.body is not None and body is None:
                raise api.ApiError(422, "a JSON body is required")
            return 200, api.call(route, self.ctx, path_params, params, body)
        except api.ApiError as exc:
            return exc.status, {"detail": exc.detail}
        except Exception as exc:  # the server would answer 500 too, and keep serving
            log.exception("%s %s failed", method, url)
            if self._conn.in_transaction:
                self._conn.rollback()
            return 500, {"detail": f"{type(exc).__name__}: {exc}"}

    def handle_json(self, method: str, url: str, body: str | None = None) -> str:
        """`handle`, with the body and the answer as JSON text: the form that crosses
        from JavaScript to Python and back without either side converting objects."""
        if body:
            try:
                data = json.loads(body)
            except ValueError as exc:
                return dumps({"status": 422, "body": {"detail": f"the body is not valid JSON: {exc}"}})
        else:
            data = None
        status, out = self.handle(method, url, data)
        return dumps({"status": status, "body": out})
