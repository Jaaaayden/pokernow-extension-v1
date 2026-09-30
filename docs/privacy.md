# Privacy

Tracker for PokerNow keeps a record of the poker hands you play on PokerNow, on your
own computer. This page says what that record holds, where it goes, and what each
of the extension's permissions is for. Tracker for PokerNow is not affiliated with
PokerNow.

## What it stores

- **The logs of the games you open.** Every line PokerNow's own game log shows at
  the table: seats, actions, showdowns, stacks, and the names and PokerNow IDs of
  the players. Where PokerNow sends it to you, this includes your own hole cards.
- **What you add yourself:** which of a player's IDs are the same person (aliases),
  notes on hands, and marks on the hands you have reviewed.
- **Your settings.**

Everything shown (stats, charts, reviews) is worked out from those logs on your
computer.

## Where it is kept

- **Built into the extension (the default):** in the extension's own storage in
  your Chrome profile. Nothing leaves the browser. Removing the extension
  deletes it.
- **With the companion app:** in the SQLite file `pnt setup` created on your
  computer (`pnt where` names it), plus a CSV copy of each game in
  `~/Downloads/pokernow-logs`.
  The companion listens only on your own computer (127.0.0.1) and answers only the
  extension and its own pages.

Your settings are kept with Chrome's synced storage, so they follow your Chrome
account like any extension's settings. Nothing else is synced.

## What it sends, and to whom

- **To PokerNow:** requests for the log of a game you have open, or one whose link
  you pasted to fetch. They go from your browser, with your PokerNow login, exactly
  as the game page itself would ask.
- **To the companion app, if you use it:** the same logs, over your own computer's
  loopback address.
- **To anyone else: nothing.** No analytics, no crash reports, no accounts, no
  remote server of ours. The Python the built-in tracker runs (Pyodide) ships
  inside the extension and loads nothing from the network.

The data is not sold, shared, or used for anything but showing it back to you.

## Permissions, and why

| Permission | What it is used for |
|---|---|
| `pokernow.com/games/*`, `pokernow.club/games/*` | Read the game log of the table you are at, and recognise game tabs so the side panel can open on them |
| `storage`, `unlimitedStorage` | Settings; and the built-in tracker's database, which grows with every hand and must not be cleared by the browser to make room |
| `sidePanel` | Show the HUD beside the game, not over it |
| `offscreen` | Run the built-in tracker's database in a background worker |
| `127.0.0.1`, `localhost` (optional) | Reach the companion app, only when you choose it in the settings |
| `nativeMessaging` (optional) | Let Chrome start the companion app while it runs (`pnt connect`), only when you choose it |

## Deleting it

- **Built in:** remove the extension, or clear its data in `chrome://extensions`.
- **Companion:** delete the database file (`pnt where` names it) and the log folder.

## Questions

Open an issue at <https://github.com/Jaaaayden/pokernow-extension-v1/issues>.
