"""The in-process engine: what the extension runs on Pyodide when no server is installed.

What it answers is checked route by route in test_api.py and test_identity_api.py,
which run every case against the server and the engine alike. This file holds what
is particular to the engine: that it can run on Pyodide at all, and how it answers
a request that matches no route.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from pnt.engine import Engine
from tests.conftest import HU, ROOT


def test_the_engine_needs_nothing_pyodide_lacks():
    """Pyodide ships the standard library and nothing else the server installs, and
    cannot start threads. Importing the engine must pull in none of the server's
    dependencies -- a stray `import fastapi` in pnt.api would pass every other test
    here and fail only in the browser."""
    code = (
        "import sys, threading; import pnt.engine; "
        "bad = sorted({'fastapi', 'pydantic', 'starlette', 'uvicorn', 'typer', 'httpx'} & set(sys.modules)); "
        "print(bad, threading.active_count())"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT, check=True)
    assert out.stdout.strip() == "[] 1"


def test_every_api_route_is_mounted_on_the_server():
    pytest.importorskip("fastapi")
    from pnt import api
    from pnt.server.app import app

    mounted = {(m, r.path) for r in app.routes for m in getattr(r, "methods", ())}
    assert {(r.method, r.path) for r in api.ROUTES} <= mounted


@pytest.fixture()
def engine(tmp_path):
    e = Engine(tmp_path / "engine.sqlite")
    yield e
    e.close()


def _call(engine, method, url, body=None):
    out = json.loads(engine.handle_json(method, url, body))
    return out["status"], out["body"]


def test_unknown_routes_and_methods(engine):
    assert _call(engine, "GET", "/nowhere") == (404, {"detail": "Not Found"})
    assert _call(engine, "POST", "/health")[0] == 405


def test_a_body_that_is_not_a_json_object_is_refused(engine):
    assert _call(engine, "POST", "/ingest", "{not json")[0] == 422
    assert _call(engine, "POST", "/ingest", "[1, 2]")[0] == 422
    assert _call(engine, "POST", "/ingest")[0] == 422
    missing = _call(engine, "POST", "/ingest", json.dumps({"game_id": "g1"}))
    assert missing == (422, {"detail": "entries: required"})


def test_a_game_captured_through_the_engine_can_be_queried(engine):
    """The extension's whole loop, in-process: ingest a game's lines, read it back."""
    from pnt.ingest.csv_source import read_csv

    entries = [{"entry": e.entry, "at": e.at, "order": e.ord} for e in read_csv(HU)]
    status, body = _call(engine, "POST", "/ingest", json.dumps({"game_id": "g1", "entries": entries}))
    assert status == 200 and body["hands"] == 188
    status, rows = _call(engine, "GET", "/stats?game=g1")
    assert status == 200 and sum(r["hands"] for r in rows) == 188 * 2
    status, hud = _call(engine, "GET", "/hud/g1")
    assert status == 200 and len(hud["seats"]) == 2
    assert _call(engine, "GET", "/health")[1]["log_folder"] is None  # no disk to keep logs on
