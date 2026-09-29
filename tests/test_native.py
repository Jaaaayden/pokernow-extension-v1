"""The native messaging host: Chrome starting the companion server by itself.

Registration is checked with the browser half faked (no registry writes); the host
itself runs for real, in a subprocess spoken to the way Chrome speaks to it.
"""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import time

import pytest

from pnt import native
from pnt import service as svc
from tests.conftest import ROOT

EXT = "abcdefghijklmnopabcdefghijklmnop"


def test_messages_are_length_prefixed_json():
    buf = io.BytesIO()
    native.write_message(buf, {"type": "status", "n": "é"})
    native.write_message(buf, {"type": "second"})
    buf.seek(0)
    assert native.read_message(buf) == {"type": "status", "n": "é"}
    assert native.read_message(buf) == {"type": "second"}
    assert native.read_message(buf) is None, "a closed port reads as None"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """~/.pnt under tmp, and a record of what would have been registered."""
    monkeypatch.setattr(svc, "LOG_DIR", tmp_path / ".pnt")
    registered = []
    monkeypatch.setattr(native, "_register", lambda manifest: registered.append(manifest) or [str(manifest)])
    monkeypatch.setattr(native, "_unregister", lambda: ["unregistered"])
    monkeypatch.setattr(native, "STORE_EXTENSION_ID", None)
    db = tmp_path / "t.sqlite"
    from pnt.db.conn import connect

    connect(db).close()
    return tmp_path, db, registered


def test_install_writes_a_manifest_for_that_extension_alone(home):
    _, db, registered = home
    out = native.install([EXT], db)
    manifest = json.loads(native.manifest_path().read_text(encoding="utf-8"))
    assert manifest["name"] == native.HOST_NAME and manifest["type"] == "stdio"
    assert manifest["allowed_origins"] == [f"chrome-extension://{EXT}/"]
    launcher = native.launcher_path().read_text(encoding="utf-8")
    assert str(db.resolve()) in launcher and "-m pnt.native" in launcher
    assert manifest["path"] == str(native.launcher_path())
    assert registered and out["ids"] == [EXT]


def test_install_adds_ids_and_refuses_what_would_not_work(home):
    tmp, db, _ = home
    native.install([EXT], db)
    other = "p" * 32
    assert native.install([other], db)["ids"] == [EXT, other], "a second extension is added, not swapped in"
    with pytest.raises(svc.ServiceError, match="not an extension ID"):
        native.install(["not-an-id"], db)
    with pytest.raises(svc.ServiceError, match="no database"):
        native.install([EXT], tmp / "missing.sqlite")


def test_uninstall_removes_the_files(home):
    _, db, _ = home
    native.install([EXT], db)
    assert native.uninstall() == ["unregistered"]
    assert not native.manifest_path().exists() and not native.launcher_path().exists()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _host(tmp_path, db, port):
    """`python -m pnt.native` as Chrome starts it, with ~ (and so its log) under tmp."""
    env = dict(os.environ, HOME=str(tmp_path), USERPROFILE=str(tmp_path), PNT_SYNC_SECONDS="0")
    return subprocess.Popen(
        [sys.executable, "-m", "pnt.native", "--db", str(db), "--port", str(port), f"chrome-extension://{EXT}/"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=ROOT, env=env,
    )


def _status(proc) -> dict:
    native.write_message(proc.stdin, {"type": "status"})
    return native.read_message(proc.stdout)


def test_the_host_runs_the_server_until_chrome_closes_the_port(tmp_path):
    from pnt.db.conn import connect

    db = tmp_path / "t.sqlite"
    connect(db).close()
    port = _free_port()
    proc = _host(tmp_path, db, port)
    try:
        for _ in range(60):
            st = _status(proc)
            if st["running"]:
                break
            time.sleep(0.25)
        assert st["running"] and st["owned"] and st["db"] == str(db)
        assert st["url"] == f"http://127.0.0.1:{port}"
        proc.stdin.close()  # Chrome closing the port
        assert proc.wait(timeout=20) == 0
        assert not svc.port_in_use("127.0.0.1", port), "the server stops with the host"
    finally:
        proc.kill()


def test_the_host_only_reports_when_the_port_is_already_served(tmp_path):
    from pnt.db.conn import connect

    db = tmp_path / "t.sqlite"
    connect(db).close()
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        proc = _host(tmp_path, db, port)
        try:
            st = _status(proc)
            assert st["owned"] is False
            proc.stdin.close()
            assert proc.wait(timeout=20) == 0
        finally:
            proc.kill()
