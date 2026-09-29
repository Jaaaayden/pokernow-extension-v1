"""Let Chrome start the companion server: a native messaging host.

The companion is the local server (`pnt serve`). Something has to keep it running,
and until now that was a Windows Task Scheduler task (`pnt service`): Windows only,
and running whether or not Chrome is. A native messaging host does the same job on
every OS, and only while it is wanted:

* `pnt connect <extension-id>` registers this module with Chrome as the host
  `com.pokernow.tracker`, allowed to talk to that extension alone.
* While the extension's tracker is set to the companion, its background worker
  keeps a port open to the host (`chrome.runtime.connectNative`). Chrome starts
  `python -m pnt.native`, which runs the server in the same process.
* An open port keeps the extension's service worker alive, and the port stays open
  while the browser runs. When Chrome closes, stdin closes, and the server stops.

If something already answers on the port -- `pnt service`, or a `pnt serve` in a
terminal -- the host starts nothing and only reports. The two can be installed
side by side.

Chrome's protocol: each message is JSON preceded by its length as a 32-bit
little-endian integer, on stdin and stdout. Stdout is therefore not for printing:
everything else goes to the server log (`pnt service log`).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import threading
from pathlib import Path
from typing import BinaryIO

from pnt import service as svc

HOST_NAME = "com.pokernow.tracker"
#: The Chrome Web Store build's ID, allowed without being named on the command line.
#: None until the store assigns one.
STORE_EXTENSION_ID: str | None = None
EXTENSION_ID = re.compile(r"[a-p]{32}")

#: Chrome, and the Chromium browsers people run it in, each look in their own place.
_WINDOWS_KEYS = [
    rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
    rf"Software\Chromium\NativeMessagingHosts\{HOST_NAME}",
    rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
]


def _browser_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
        return [base / "Google" / "Chrome", base / "Chromium", base / "Microsoft Edge"]
    return [home / ".config" / "google-chrome", home / ".config" / "chromium", home / ".config" / "microsoft-edge"]


# ------------------------------------------------------------------ protocol ---


def read_message(stream: BinaryIO) -> dict | None:
    """The next message, or None once Chrome has closed the port."""
    header = stream.read(4)
    if len(header) < 4:
        return None
    (size,) = struct.unpack("<I", header)
    body = stream.read(size)
    if len(body) < size:
        return None
    return json.loads(body)


def write_message(stream: BinaryIO, message: dict) -> None:
    body = json.dumps(message).encode("utf-8")
    stream.write(struct.pack("<I", len(body)) + body)
    stream.flush()


# ---------------------------------------------------------------------- host ---


def run_host(db: Path, host: str, port: int, stdin: BinaryIO, stdout: BinaryIO) -> None:
    """Serve until Chrome closes the port. The server runs on this thread, where
    uvicorn can install its signal handlers; Chrome's messages are read on another."""
    import uvicorn

    server: uvicorn.Server | None = None
    closed = threading.Event()
    lock = threading.Lock()

    def status() -> dict:
        up = svc.health(host, port)
        return {
            "type": "status",
            "url": f"http://{host}:{port}",
            "running": up is not None,
            # False: something else (pnt service, a terminal) holds the port.
            "owned": server is not None and server.started,
            "db": (up or {}).get("db"),
        }

    def listen() -> None:
        try:
            while (msg := read_message(stdin)) is not None:
                if msg.get("type") == "status":
                    with lock:
                        write_message(stdout, status())
        finally:
            closed.set()
            if server is not None:
                server.should_exit = True

    threading.Thread(target=listen, name="chrome", daemon=True).start()
    if not db.exists():
        print(f"pnt native: no database at {db}; not starting the server", flush=True)
    elif svc.port_in_use(host, port):
        print(f"pnt native: {host}:{port} is already served; reporting only", flush=True)
    else:
        os.environ["PNT_DB"] = str(db)
        os.environ["PNT_HOST"] = host
        server = uvicorn.Server(
            uvicorn.Config(
                "pnt.server.app:app", host=host, port=port, log_config=svc._file_log_config(), access_log=False
            )
        )
        if not closed.is_set():
            print(f"pnt native: starting pid {os.getpid()}: http://{host}:{port}  db {db}", flush=True)
            server.run()
    closed.wait()


def main(argv: list[str] | None = None) -> None:
    # Chrome adds arguments of its own (the caller's origin; on Windows a window
    # handle), so unknown ones are ignored.
    ap = argparse.ArgumentParser(prog="python -m pnt.native")
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--host", default=svc.DEFAULT_HOST)
    ap.add_argument("--port", type=int, default=svc.DEFAULT_PORT)
    args, _ = ap.parse_known_args(argv)
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    log = svc._open_log()
    sys.stdout = sys.stderr = log  # nothing but the protocol may reach Chrome's stdout
    try:
        run_host(args.db, args.host, args.port, stdin, stdout)
    finally:
        log.close()


# -------------------------------------------------------------- registration ---


def launcher_path() -> Path:
    return svc.LOG_DIR / ("native-host.bat" if sys.platform == "win32" else "native-host.sh")


def manifest_path() -> Path:
    return svc.LOG_DIR / f"{HOST_NAME}.json"


def _launcher(db: Path, host: str, port: int) -> str:
    """What Chrome runs. A script, because Chrome runs one path with no arguments of
    ours; it fixes the interpreter (the one `pnt` is installed in) and the database."""
    python = Path(sys.executable)
    if python.name.lower() == "pythonw.exe":  # stdio needs a console interpreter
        python = python.with_name("python.exe")
    if sys.platform == "win32":
        return f'@echo off\r\n"{python}" -m pnt.native --db "{db}" --host {host} --port {port} %*\r\n'
    return f'#!/bin/sh\nexec "{python}" -m pnt.native --db "{db}" --host {host} --port {port} "$@"\n'


def _register(manifest: Path) -> list[str]:
    """Tell each browser where the manifest is. Returns where it was registered."""
    done = []
    if sys.platform == "win32":
        import winreg

        for key in _WINDOWS_KEYS:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
                winreg.SetValue(k, "", winreg.REG_SZ, str(manifest))
            done.append(rf"HKCU\{key}")
        return done
    for browser in _browser_dirs():
        if browser.name not in ("Chrome", "google-chrome") and not browser.exists():
            continue  # only the browsers that are installed, and always Chrome
        target = browser / "NativeMessagingHosts" / manifest.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(manifest.read_text(encoding="utf-8"), encoding="utf-8")
        done.append(str(target))
    return done


def _unregister() -> list[str]:
    done = []
    if sys.platform == "win32":
        import winreg

        for key in _WINDOWS_KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
                done.append(rf"HKCU\{key}")
            except FileNotFoundError:
                pass
        return done
    for browser in _browser_dirs():
        target = browser / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        if target.exists():
            target.unlink()
            done.append(str(target))
    return done


def allowed_ids() -> list[str]:
    """The extensions an existing registration lets in."""
    try:
        origins = json.loads(manifest_path().read_text(encoding="utf-8"))["allowed_origins"]
    except (OSError, ValueError, KeyError):
        return []
    return [o.removeprefix("chrome-extension://").rstrip("/") for o in origins]


def install(extension_ids: list[str], db: Path, host: str = svc.DEFAULT_HOST, port: int = svc.DEFAULT_PORT) -> dict:
    """Register the host for these extensions, and any it already allowed.

    Refuses a database that does not exist, for the reason `pnt service install`
    does: a server started on a missing file creates it empty and shows nothing.
    """
    bad = [i for i in extension_ids if not EXTENSION_ID.fullmatch(i)]
    if bad:
        raise svc.ServiceError(f"not an extension ID: {', '.join(bad)} (32 letters a-p, shown in the extension's settings)")
    db = db.resolve()
    if not db.exists():
        raise svc.ServiceError(f"no database at {db}; run `pnt setup` first")
    ids = list(dict.fromkeys([*allowed_ids(), *extension_ids, *([STORE_EXTENSION_ID] if STORE_EXTENSION_ID else [])]))
    if not ids:
        raise svc.ServiceError("give the extension's ID: it is shown in the extension's settings")
    launcher = launcher_path()
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text(_launcher(db, host, port), encoding="utf-8", newline="")
    launcher.chmod(0o755)
    manifest = manifest_path()
    manifest.write_text(
        json.dumps(
            {
                "name": HOST_NAME,
                "description": "PokerNow Tracker: starts the companion server while Chrome runs",
                "path": str(launcher),
                "type": "stdio",
                "allowed_origins": [f"chrome-extension://{i}/" for i in ids],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return {"ids": ids, "db": str(db), "manifest": str(manifest), "registered": _register(manifest)}


def uninstall() -> list[str]:
    removed = _unregister()
    for path in (manifest_path(), launcher_path()):
        path.unlink(missing_ok=True)
    return removed


if __name__ == "__main__":  # pragma: no cover -- what Chrome runs
    main()
