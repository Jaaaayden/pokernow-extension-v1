"""Build the extension that ships: the one with the tracker built in.

    python scripts/build_extension.py            # -> dist/extension/, load it unpacked
    python scripts/build_extension.py --zip      # and dist/pokernow-tracker-<version>.zip
    python scripts/build_extension.py --no-engine  # companion-only, like `pnt extension`

`pnt/extension/` on its own is the companion-only extension: every script it runs,
none of the engine's weight. This adds what the built-in tracker needs:

* `vendor/pyodide/`: CPython compiled to WebAssembly, from the pinned npm release,
  checked against the integrity hash npm publishes for it. The Web Store forbids
  loading code from anywhere but the package, so it is copied in, not fetched.
* `engine/pnt.zip`: the Python the engine runs -- `pnt.api`, `pnt.engine` and what
  they import. Not the server, the CLI or the service: Pyodide has no FastAPI, and
  `tests/test_build_extension.py` checks the zip imports without it.

The version in manifest.json is stamped from pyproject.toml, so the two cannot drift.
The download is cached in `build/`, and checked again on every use.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import shutil
import sys
import tarfile
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "pnt" / "extension"
CACHE = ROOT / "build"

PYODIDE_VERSION = "314.0.7"
PYODIDE_URL = f"https://registry.npmjs.org/pyodide/-/pyodide-{PYODIDE_VERSION}.tgz"
#: npm's `dist.integrity` for that tarball.
PYODIDE_INTEGRITY = "sha512-0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/6V5JEsOlD2R1A=="
#: What loading Pyodide in a worker reads. sqlite3 is built into the stdlib zip.
PYODIDE_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json")

#: The engine's Python: every package under pnt/ except these, which need the server's
#: dependencies or a terminal. The sample logs come too (`POST /import/sample`).
ENGINE_EXCLUDE = {"server", "extension", "cli.py", "service.py", "native.py"}

#: A fixed timestamp for every zip entry, so the same sources build the same bytes.
EPOCH = (2026, 1, 1, 0, 0, 0)


def version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def copy_extension(out: Path) -> None:
    shutil.copytree(
        EXTENSION,
        out,
        ignore=shutil.ignore_patterns("*.test.mjs", "vendor", "engine", "__pycache__"),
    )
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    manifest["version"] = version()
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def pyodide_tarball() -> bytes:
    path = CACHE / f"pyodide-{PYODIDE_VERSION}.tgz"
    if path.exists():
        data = path.read_bytes()
    else:
        print(f"downloading {PYODIDE_URL}")
        with urllib.request.urlopen(PYODIDE_URL, timeout=120) as r:
            data = r.read()
    algo, _, want = PYODIDE_INTEGRITY.partition("-")
    got = base64.b64encode(hashlib.new(algo, data).digest()).decode()
    if got != want:
        path.unlink(missing_ok=True)
        sys.exit(f"{PYODIDE_URL}: integrity mismatch (got {algo}-{got}); refusing to ship it")
    CACHE.mkdir(exist_ok=True)
    path.write_bytes(data)
    return data


def vendor_pyodide(out: Path) -> None:
    dest = out / "vendor" / "pyodide"
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(pyodide_tarball()), mode="r:gz") as tar:
        for name in PYODIDE_FILES:
            member = tar.extractfile(f"package/{name}")
            if member is None:
                sys.exit(f"pyodide {PYODIDE_VERSION} has no {name}")
            (dest / name).write_bytes(member.read())
    (dest / "NOTICE").write_text(
        f"Pyodide {PYODIDE_VERSION} (https://pyodide.org), from {PYODIDE_URL}.\n"
        "Licensed under the Mozilla Public License 2.0: https://mozilla.org/MPL/2.0/\n"
        "It bundles CPython and SQLite, under their own licenses (PSF License; public domain).\n",
        encoding="utf-8",
    )


def engine_sources() -> list[Path]:
    pnt = ROOT / "pnt"
    out = []
    for path in sorted(pnt.rglob("*")):
        rel = path.relative_to(pnt)
        if rel.parts[0] in ENGINE_EXCLUDE or "__pycache__" in rel.parts or not path.is_file():
            continue
        if path.suffix in (".py", ".sql") or (rel.parts[0] == "logs" and path.suffix == ".csv"):
            out.append(path)
    return out


def engine_zip(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for path in engine_sources():
            info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, path.read_bytes())


def store_zip(out: Path) -> Path:
    dest = out.parent / f"pokernow-tracker-{version()}.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(out.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(out).as_posix(), EPOCH)
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, path.read_bytes())
    return dest


def build(out: Path, *, engine: bool = True, pack: bool = False) -> Path:
    if out.exists():
        shutil.rmtree(out)
    copy_extension(out)
    if engine:
        vendor_pyodide(out)
        engine_zip(out / "engine" / "pnt.zip")
    if pack:
        print(f"store zip: {store_zip(out)}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "extension")
    ap.add_argument("--no-engine", action="store_true", help="companion-only: no Pyodide, no Python")
    ap.add_argument("--zip", action="store_true", help="also pack the folder for the Web Store")
    args = ap.parse_args()
    out = build(args.out.resolve(), engine=not args.no_engine, pack=args.zip)
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"built {out} ({size / 1e6:.1f} MB): load it at chrome://extensions > Load unpacked")


if __name__ == "__main__":
    main()
