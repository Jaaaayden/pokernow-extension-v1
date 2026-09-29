"""What scripts/build_extension.py puts in the extension people install.

The Pyodide download is left to enginehost.test.mjs, which runs the built result;
these check the parts built from this repository, offline.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import zipfile

import pytest

from tests.conftest import HU, ROOT

spec = importlib.util.spec_from_file_location("build_extension", ROOT / "scripts" / "build_extension.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def test_the_companion_only_build_ships_no_tests_and_the_packages_version(tmp_path):
    out = build.build(tmp_path / "ext", engine=False)
    assert (out / "manifest.json").is_file() and (out / "offscreen.html").is_file()
    assert not list(out.rglob("*.test.mjs"))
    assert not (out / "vendor").exists() and not (out / "engine").exists()
    assert json.loads((out / "manifest.json").read_text(encoding="utf-8"))["version"] == build.version()


def test_the_engine_zip_runs_with_nothing_the_server_needs(tmp_path):
    """The zip is the whole of the Python the built-in tracker has. Unpacked alone,
    with the server's dependencies made unimportable, it must still answer."""
    dest = tmp_path / "pnt.zip"
    build.engine_zip(dest)
    names = zipfile.ZipFile(dest).namelist()
    assert "pnt/engine.py" in names and "pnt/db/schema.sql" in names
    assert "pnt/logs/aliases.csv" in names and any(n.startswith("pnt/logs/poker_now_log_") for n in names)
    assert not [n for n in names if n.startswith(("pnt/server/", "pnt/extension/")) or n == "pnt/cli.py"]

    lib = tmp_path / "lib"
    zipfile.ZipFile(dest).extractall(lib)
    code = f"""
import json, sys
class Refuse:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {{"fastapi", "pydantic", "starlette", "uvicorn", "typer", "httpx"}}:
            raise ImportError(name + " is not in Pyodide")
sys.meta_path.insert(0, Refuse())
sys.path.insert(0, {str(lib)!r})
import pnt.engine
assert pnt.engine.__file__.startswith({str(lib)!r}), pnt.engine.__file__
from pnt.ingest.csv_source import read_csv
e = pnt.engine.Engine({str(tmp_path / "db.sqlite")!r}, journal_mode="MEMORY")
entries = [dict(entry=r.entry, at=r.at, order=r.ord) for r in read_csv({str(HU)!r})]
status, body = e.handle("POST", "/ingest", dict(game_id="g1", entries=entries))
print(status, body["hands"])
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=tmp_path, check=False)
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ["200", "188"]


def test_a_journal_mode_is_checked_before_it_reaches_sql(tmp_path):
    from pnt.engine import Engine

    with pytest.raises(ValueError):
        Engine(tmp_path / "x.sqlite", journal_mode="MEMORY; DROP TABLE hands")


def test_every_icon_the_manifest_names_is_a_png_of_that_size():
    """The Web Store refuses a package without its 128 px icon; Chrome shows a grey
    square for a missing toolbar one. `scripts/make_icons.py` draws them."""
    import struct

    manifest = json.loads((build.EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    icons = {**manifest["icons"], **manifest["action"]["default_icon"]}
    assert "128" in manifest["icons"]
    for size, path in icons.items():
        data = (build.EXTENSION / path).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", path
        assert struct.unpack(">II", data[16:24]) == (int(size), int(size)), path
