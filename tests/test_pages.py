"""The dashboard pages, which are the extension's own pages and the server's too.

An extension page runs under Manifest V3's content security policy: no inline
script, no inline event handler, no `javascript:` URL. A page that breaks it loads
blank in the extension and still works from the server, so nothing else would
notice. And one set of files serves two origins -- chrome-extension://.../pages/
and 127.0.0.1:52000/ -- which only works while every link is relative and every
request goes through api.js.
"""

from __future__ import annotations

import re

import pytest

from pnt.cli import EXTENSION_DIR

PAGES = EXTENSION_DIR / "pages"
HTML = sorted(PAGES.glob("*.html"))
SCRIPTS = sorted(PAGES.glob("*.js"))


def test_there_are_pages():
    assert {p.name for p in HTML} >= {"index.html", "chart.html", "stats.html", "allin.html", "pots.html", "players.html"}


@pytest.mark.parametrize("page", HTML, ids=lambda p: p.name)
def test_a_page_runs_no_inline_script(page):
    html = page.read_text(encoding="utf-8")
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), "inline <script>: move it to a .js file"
    assert not re.search(r"\son[a-z]+\s*=", html), "inline event handler: use addEventListener"
    assert "javascript:" not in html


@pytest.mark.parametrize("page", HTML, ids=lambda p: p.name)
def test_a_page_loads_api_js_first_and_only_scripts_that_exist(page):
    srcs = re.findall(r'<script[^>]*\bsrc="([^"]+)"', page.read_text(encoding="utf-8"))
    assert srcs[0] == "api.js", "every other script may reach the tracker, so api.js comes first"
    for src in srcs:
        assert (PAGES / src).is_file(), f"{src} is not in pages/"


@pytest.mark.parametrize("page", HTML, ids=lambda p: p.name)
def test_links_between_pages_are_relative(page):
    """`/stats.html` is the server's root, and nothing at all in the extension."""
    html = page.read_text(encoding="utf-8")
    absolute = [h for h in re.findall(r'href="(/[^"]*)"', html) if h != "/docs"]
    assert absolute == []


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_scripts_reach_the_tracker_only_through_api_js(script):
    if script.name == "api.js":
        return
    text = script.read_text(encoding="utf-8")
    # A fetch to the tracker must be pntFetch, which works from the extension too.
    # One to PokerNow itself (an absolute https:// URL) is not the tracker's.
    bare = re.findall(r"(?<![\w.])fetch\((?!\s*[`\"']https://)", text)
    assert not bare, "use pntFetch to reach the tracker"
    assert not re.search(r"""\.href\s*=\s*["'`]/""", text), "links between pages are relative"
