"""Getting hands in without the companion, and moving between two trackers.

The import page sends an export's text to POST /import; the ⚙ settings move a
database from one tracker to the other through GET /export/... and the write
routes. Every case runs on both transports, like test_api.py.
"""

from __future__ import annotations

import shutil

import pytest

from pnt import api
from tests.conftest import ALL_LOGS, HU, STRADDLE, STRADDLE_GAME, EngineClient, local_client

pytest.importorskip("fastapi")


@pytest.fixture()
def factory(tmp_path, monkeypatch):
    """`make(name, logs, kind)`: a client of `kind` over a fresh database with `logs`
    imported. At most one server per test: app.py keeps its database in module
    globals, so a second would repoint the first."""
    import importlib

    from pnt.db.conn import connect
    from pnt.engine import Engine
    from pnt.ingest.importer import import_csv
    from pnt.server import app as app_module

    made = []

    def make(name, logs=(), kind="engine"):
        path = tmp_path / f"{name}.sqlite"
        conn = connect(path)
        for log in logs:
            import_csv(conn, log)
        conn.close()
        if kind == "server":
            assert "server" not in made, "one server per test"
            made.append("server")
            monkeypatch.setenv("PNT_DB", str(path))
            importlib.reload(app_module)
            return local_client(app_module.app)
        engine = Engine(path)
        made.append(engine)
        return EngineClient(engine)

    yield make
    for e in made:
        if e != "server":
            e.close()


@pytest.fixture(params=["server", "engine"])
def make_client(request, factory):
    return lambda name, logs=(): factory(name, logs, request.param)


def _upload(client, path, name=None):
    return client.post("/import", json={"name": name or path.name, "text": path.read_text(encoding="utf-8")})


def test_an_export_is_imported_by_its_name(make_client):
    client = make_client("a", ALL_LOGS)
    before = client.get("/health").json()["hands"]
    r = _upload(client, STRADDLE)
    assert r.status_code == 200
    body = r.json()
    assert body["game_id"] == STRADDLE_GAME and body["hands"] > 0 and body["new"] > 0
    assert client.get("/health").json()["hands"] == before + body["hands"]
    again = _upload(client, STRADDLE).json()
    assert again["new"] == 0, "importing twice is free"
    assert client.get("/health").json()["hands"] == before + body["hands"]


def test_a_file_not_named_or_shaped_like_an_export_is_refused(make_client):
    client = make_client("a")
    assert _upload(client, HU, name="my game.csv").status_code == 422
    assert _upload(client, HU, name="poker_now_log_../escape.csv").status_code == 422
    bad = client.post("/import", json={"name": "poker_now_log_x1.csv", "text": "a,b\n1,2\n"})
    assert bad.status_code == 422 and "missing required column" in bad.json()["detail"]


def test_a_log_with_no_hand_is_left_out(make_client):
    client = make_client("a")
    text = 'entry,at,order\n"The player ""a @ b"" joined the game with a stack of 100.",2026-01-01T00:00:00.000Z,1\n'
    r = client.post("/import", json={"name": "poker_now_log_empty1.csv", "text": text})
    assert r.status_code == 200 and r.json()["skipped"]
    assert client.get("/export/games").json() == []


def test_the_sample_comes_with_its_aliases(make_client, tmp_path, monkeypatch):
    sample = tmp_path / "sample"
    sample.mkdir()
    shutil.copy(HU, sample / HU.name)
    (sample / "aliases.csv").write_text("pn_id,alias\n5NARaPRkSp,sample player\n", encoding="utf-8")
    monkeypatch.setattr(api, "SAMPLE_DIR", sample)
    client = make_client("a")
    r = client.post("/import/sample")
    assert r.status_code == 200 and r.json() == {"games": 1, "hands": 188}
    assert "sample player" in {p["alias"] for p in client.get("/players").json()}

    monkeypatch.setattr(api, "SAMPLE_DIR", tmp_path / "none")
    assert client.post("/import/sample").status_code == 404


@pytest.mark.parametrize("kinds", [("engine", "server"), ("server", "engine")], ids=["to-companion", "to-builtin"])
def test_a_whole_tracker_moves_to_another_and_nothing_is_lost(factory, kinds):
    """What switching between the built-in tracker and the companion does."""
    source = factory("source", ALL_LOGS, kinds[0])
    # Judgements that no log could rebuild: a merge, a mark and a note.
    source.post("/aliases/merge", json={"source": "onlybluffs", "target": "genericpoker"})
    hand = source.get("/players/genericpoker/hands").json()["hands"][0]
    source.post(f"/hands/{hand['hand_id']}/reviewed", json={"reviewed": True})
    source.post(f"/hands/{hand['hand_id']}/note", json={"note": "fold the river"})

    target = factory("target", (), kinds[1])
    for game in source.get("/export/games").json():
        lines = source.get(f"/export/games/{game['game_id']}").json()["entries"]
        assert len(lines) == game["entries"]
        # In pieces, as the move sends them, then one rebuild.
        for i in range(0, len(lines), 1000):
            r = target.post("/ingest", json={"game_id": game["game_id"], "entries": lines[i : i + 1000], "rebuild": False})
            assert r.status_code == 200
        assert target.post(f"/rebuild/{game['game_id']}").status_code == 200
    judged = source.get("/export/judgements").json()
    r = target.post("/export/judgements", json=judged)
    assert r.status_code == 200 and r.json()["reviewed"] == 1 and r.json()["notes"] == 1

    assert target.get("/stats").json() == source.get("/stats").json()
    assert {p["alias"]: p["pn_ids"] for p in target.get("/players").json()} == {
        p["alias"]: p["pn_ids"] for p in source.get("/players").json()
    }
    assert target.get("/export/judgements").json() == judged
    # Twice is the same as once.
    target.post("/export/judgements", json=judged)
    assert target.get("/export/judgements").json() == judged


def test_malformed_judgements_are_refused(make_client):
    client = make_client("a", ALL_LOGS)
    assert client.post("/export/judgements", json={"aliases": [["only one"]]}).status_code == 422
    assert client.post("/export/judgements", json={"reviewed": [{"game_id": "g"}]}).status_code == 422
