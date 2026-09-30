# PokerNow Tracker

**Know what they have before they act.**

PokerNow Tracker records every hand you play on PokerNow and remembers every
opponent, even across renames and devices. While a hand is being played, a side
panel shows what the player to act has shown up with *in this exact spot*: how often
they fold to a flop c-bet, and whether their calls are value, draws or air. When the
session ends, it lists the hands you should look at again.

Other PokerNow HUDs show you a VPIP number. This shows you the spot.

| | Similar PokerNow HUD Extensions | PokerNow Tracker |
|---|:-:|:-:|
| Live hand capture that follows each decision as it happens | – | ✓ |
| This session's stats beside lifetime | – | ✓ |
| Hand review: missed bluffs, missed value, bad beats | – | ✓ |
| Aggregate stats across every game you've played | – | ✓ |
| Range charts from showdowns, in any spot | – | ✓ |
| One player across renames and devices | – | ✓ |

Everything runs on your computer. The tracker is built into the Chrome extension,
so once the extension is built and loaded there is nothing else to install. Add the
optional companion app when you want the command line, a log folder kept in sync,
or a database file you can open yourself. [Setup →](#setup)

---

## Features

### Live HUD that follows the hand

The HUD sits in Chrome's side panel, beside the table and never on top of it. You can also
set it to float as a box on the page you can drag around (⚙ → HUD). As the
hand is played, it tracks each player's spot as it builds (`BTN open → faced 3-bet →
called → faced small flop c-bet`) and shows what they have shown up with there:

```
facing flop c-bet → call · value 50% · draw 25% · air 25% (4 of 9 shown)
```

The range chart underneath follows the player to act and updates within about a
second of each action. If a spot has no history yet, it widens step by step to the
nearest one that does, and says so with **≈**.
[More in the guide →](docs/guide.md#the-live-hud)

### Session vs lifetime, side by side

Every HUD figure appears twice: tonight first, with lifetime in grey beside it. When
a regular is playing ten points looser than usual, the number turns blue, so you see
it while it's happening rather than in next week's review.

### Exploit tags

The tracker turns a player's numbers into plain advice, with the count behind every
claim:

```
henry  FISH  5061 hands
  NO BLUFF               6.9% of 276   Bet or raised the river and showed air 6.9% of the time (19 of 276 shown). Fold to their river bets without a strong hand.
  FOLDS RIVER           51.0% of 965   Folded to a river bet 51.0% of the time (492 of 965). Bet the river.
  LIMPER                46.2% of 3051  Limped 46.2% of unopened pots (1411 of 3051). Iso-raise.
```

Each player gets an archetype, judged against what's normal at that table size.
Tags that only one wild session supports are kept apart from real habits, and a tag
with too small a sample stays silent. The tags also show as chips in the HUD, and
clicking one opens the hands behind it. `pnt tags` ·
[guide](docs/guide.md#tags)

### Hand review

After a session, the tracker lists the hands you should look at again: missed
bluffs, missed value, failed bluffs, suckouts and coolers. Each row comes with the
context needed to judge it:

```
x #267  Missed bluff     pot   20bb  20bb pot checked down on the river: K-high vs K-high (henry)
    | he checks back every king here -- bet 1/3 and he folds everything worse
  #85   Postflop cooler  pot  166bb  set into set (harry) on the flop, all in on the flop, 4% to win, lost 81bb
```

Tick hands off as you go, and write a note on any hand. The note shows up next time
the hand comes up. Click any row to replay it. `pnt review <you>` ·
[guide](docs/guide.md#hand-review)

### Range charts for any spot

Ask "what does he overbet the river with?" and get a 13×13 chart or a made-hand
breakdown built from his showdowns, with coverage stated up front, so you know how
much of the range is missing:

```bash
pnt range henry --filter "pfa,srp,cbet_flop,cbet_turn,bet_river=overbet" --by made
```

```
hands in this spot: 12   cards known: 7   coverage: 58.3%

class                       n    pct  won   net bb
straight                    2   28.6    2     61.5
two_pair                    2   28.6    1    -34.0
pair                        3   42.9    2     36.0
```

A spot can be anything: position, pot type, preflop line, bet size bucket, facing a
jam, board texture, pot size, or who you were against. Sizing views show what each
bet size is made of, and every cell opens the hands behind it with a replay.
[Filter reference →](docs/guide.md#filters)

### All-in EV

The tracker separates luck from play. For every all-in showdown, it compares what
each player won with what their equity was worth:

```
player                 Hands    Eq%   Actual Adjusted     Diff
jayden                   380   51.6  6356.99   5557.4   799.59
harry                    130   48.9   -577.8   -50.63  -527.17
```

Harry's all-in losses are almost all the deck: by equity he'd be down 51bb, not
578bb. The page draws each player's actual and adjusted lines over time.
`pnt allin` · [guide](docs/guide.md#all-in-ev)

### Biggest pots

The pots that mattered this week, from everyone at the table, sized against each
other so the outliers stand out, with one click to replay:

```
  6,650   133bb  2026-09-16T02:59 henry +3,350 vs luis -3,300       6d 4s Kd Qc Qd
  5,596   112bb  2026-09-16T03:10 jayden +2,798 vs luis -2,798      7h 7c Tc 8d 6d
```

`pnt pots` · [guide](docs/guide.md#biggest-pots)

### Stats across every game you've played

VPIP, PFR, 3-bet, c-bet, WTSD, bb/100 and more for every player, across every game,
in one sortable table. You can break any of them down by position or narrow them to
any spot (`pnt stats --filter "faced_cbet_flop,players>=3"`). An empty sample shows
`--`, never a misleading `0%`. `pnt stats` · `pnt positions <player>` ·
[guide](docs/guide.md#stats)

### One player, many names

PokerNow gives the same person a new ID on every device, and players rename
constantly. The players page shows every name each ID has used, so you can merge
the ones you recognise:

```
harry    <-  bread, Woolball (har), wool, wool ball, fish
```

Before you confirm a merge, the page shows exactly what it will move, and every
merge can be undone. [guide](docs/guide.md#players-and-aliases)

### Your log folder is the database

Drop an export in the folder and it's imported. Delete one and the game is removed.
Live capture writes every game you play there automatically, and `pnt backfill`
fetches old games by link, so the folder is a complete, portable record of your
games. [guide](docs/guide.md#getting-hands-in)

### Share logs safely

A raw PokerNow export reveals your hole cards on every hand, including the ones you
folded. `pnt redact` writes copies that keep only the cards the table already saw,
and `--audit` checks a folder before you commit it.
[guide](docs/guide.md#publishing-logs)

---

## Setup

### The extension

It isn't on the Chrome Web Store yet, so you build it from this repo. You need
**Python 3.11+** and git; the build uses nothing but Python's standard library.

```bash
git clone https://github.com/Jaaaayden/pokernow-extension-v1
cd pokernow-extension-v1
python scripts/build_extension.py
```

The build writes the extension to `dist/extension`. The first build downloads
Pyodide (Python compiled to WebAssembly), checks it against the hash
npm publishes, and keeps it in `build/`, so later builds are offline. Then, in
Chrome:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**
   and pick the `dist/extension` folder.
2. Pin the extension, open a PokerNow game, and click its icon. The side panel
   opens and starts recording the table.
3. Open the ⚙ settings, then **tracker ↗**, for stats, charts, review, pots and
   players.
4. Add games you played before installing it on that same page: drop PokerNow's
   log exports on it, have it watch the folder they download to, or paste game
   links to fetch. **Try it with sample data** fills an empty tracker with
   someone else's (anonymized) hands to look around with.

Your hands are kept in the extension's own storage, in this Chrome profile only.
Removing the extension deletes them. Move them to the companion first (below) if
you want to keep them.

**Always load it from the same folder.** Chrome names an unpacked extension by its
folder's path, and its storage goes with that name. Loaded from a copy somewhere
else, it is a different extension with an empty tracker (and a new ID, which the
companion would need to be told about with `pnt connect`).

### Updating the extension

```bash
git pull
python scripts/build_extension.py
```

Then press the reload arrow on the extension's card in `chrome://extensions`, and
reload any open PokerNow tabs so they get the new capture script. The build
replaces `dist/extension` in place, so the extension keeps its ID and your hands.

Every change to the extension, including the tracker's own Python, needs this
rebuild and reload: the extension runs what was copied into `dist/extension`, not
the files in `pnt/`.

A game already captured keeps the reading it was derived with, and is re-derived
when more of it is captured. So after an update that changes how hands are read,
older games keep the old reading. The companion re-derives everything with
`pnt rebuild`; the built-in tracker has no button for that yet.

### The companion app (optional)

The companion app runs the same tracker as a small server on your machine and adds:
- the `pnt` command line;
- a log folder kept in sync with the database;
- a SQLite file you can open yourself;
- native speed on a long history.

You need **pipx** as well as Python. If you have Python but not pipx, run
`python -m pip install --user pipx`, then `python -m pipx ensurepath`, and open a new
terminal. On Windows, use the python.org installer rather than the Microsoft Store
build, which sandboxes the files a background server needs. From your clone:

```bash
pipx install .
pnt setup --extension-id <the ID shown in the extension's ⚙ settings>
```

`pnt setup` handles the first run and is safe to run again:
- It creates the database and imports any exports it finds in
  `~/Downloads/pokernow-logs`, or the bundled sample if there are none
  (`--no-sample` skips it).
- It registers the companion with Chrome, so Chrome starts the server whenever
  Chrome is running, on Windows, macOS and Linux alike (`pnt connect`).
- On Windows, it also installs an always-on background server (`pnt service`).

Then, in the extension's ⚙ settings, set **Tracker** to **Companion app** and press
**Save**. Chrome asks to let the extension reach the server on your computer. Tick
**Copy my hands to it** to bring along everything the built-in tracker already
holds: every game, and every merge, note and review mark. The companion's pages
are also at **<http://127.0.0.1:52000>**.

If the tracker can't be reached, the HUD and the ⚙ settings say why.

### Updating the companion

After `git pull`, reinstall it and restart the server, because a running server
keeps the old code:

```bash
pipx install --force .
pnt service restart        # Windows; elsewhere, restart Chrome
pnt rebuild                # only if the update changed how hands are read
```

The restart checks that the new server is the one answering. If an old one (a
`pnt serve` left open in a terminal) still holds the port, it names the process
to end. Rebuild and reload the extension too (above): the two are updated
separately.

### Companion commands

These need the companion app. The built-in tracker does the same things from its
pages.

```bash
pnt import                                   # every log in ~/Downloads/pokernow-logs
pnt import path/to/log.csv                   # or specific files, a folder, or a glob
pnt sync                                     # match the log folder: new logs in, deleted logs out
pnt backfill -f links.txt                    # download old games by link into the log folder
pnt stats                                    # every player, most hands first
pnt positions genericpoker                   # one player, split by position
pnt range henry --filter "opener,srp"        # what they had in a spot
pnt sizing henry --street flop --kind cbet   # what each bet size is made of
pnt tags                                     # archetype and exploit tags
pnt review jayden                            # hands to review
pnt note <game_id> 161 "turn barrel was bad" # write down what went wrong in one hand
pnt allin                                    # all-in EV: actual vs adjusted
pnt pots                                     # biggest pots in the last 7 days
pnt alias list                               # the player names you can query
pnt alias merge onlybluffs genericpoker      # one person, two devices
pnt redact --out pnt/logs                    # copies you can publish
pnt redact --anonymize --out shared          # ...with every player replaced by a stand-in
pnt connect <extension-id>                   # let Chrome start the server while it runs
pnt where                                    # which database, log folder and extension
```

Commands that take a player take an **alias** from `pnt alias list`. The log folder
defaults to `~/Downloads/pokernow-logs`; set `PNT_LOG_DIR` to change it.

| Background server (Windows) | |
|---|---|
| `pnt service status` | Whether it's up, and which database it has open |
| `pnt service restart` | **Run after updating the companion.** If an old server still holds the port, it names the process to end |
| `pnt service log` | The last lines of `~\.pnt\server.log` |
| `pnt service stop` / `start` | Stop until the next login, or start again |
| `pnt service uninstall` | Remove it; the database is untouched |

### Documentation

| File | Contents |
|---|---|
| [`docs/guide.md`](docs/guide.md) | The full reference for every feature: filters, the HUD, tags, review, sync rules |
| [`docs/architecture.md`](docs/architecture.md) | How it works inside: design, parser rules, live capture, the background server, tests |
| [`docs/findings.md`](docs/findings.md) | The PokerNow log format: identity, ordering, amounts, line vocabulary, traps |
| [`pnt/stats/SPEC.md`](pnt/stats/SPEC.md) | Every stat, tag and review flag, defined exactly |
| [`tests/fixtures/README.md`](tests/fixtures/README.md) | What each fixture log exercises |
| [`pnt/logs/README.md`](pnt/logs/README.md) | The bundled sample corpus |
| [`docs/privacy.md`](docs/privacy.md) | What the extension stores, what it sends, and why each permission |

### Development

```bash
git clone https://github.com/Jaaaayden/pokernow-extension-v1 && cd pokernow-extension-v1
pip install -e ".[dev]"
pytest -q
python scripts/build_extension.py      # dist/extension, then reload it in chrome://extensions
node --test pnt/extension/*.test.mjs   # the extension, and the built-in tracker on real Pyodide
```

The source of the extension is `pnt/extension/`, and the tracker it runs is the
Python in `pnt/`. Chrome runs neither directly: after any change, run the build
again and press reload on the extension's card (and reload open PokerNow tabs when
`content.js` or the scripts it loads changed). `enginehost.test.mjs` runs against
the build, so build before running the node tests.

| Build | |
|---|---|
| `python scripts/build_extension.py` | The extension people install, with the built-in tracker |
| `--zip` | Also packs `dist/pokernow-tracker-<version>.zip` for the Web Store |
| `--no-engine` | Companion-only: no Pyodide and no Python, about 300 KB |
| `--out DIR` | Build somewhere other than `dist/extension` (a different extension to Chrome) |

The version in the manifest comes from `pyproject.toml`. Loading `pnt/extension/`
directly also works, as the companion-only extension.

See [architecture.md](docs/architecture.md#testing) for what the suite guarantees.
