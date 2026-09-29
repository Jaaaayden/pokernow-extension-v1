# Sample logs

PokerNow exports, redacted and anonymized for publication by
`pnt redact --anonymize`. They ship inside the package and the extension:
- `pnt import` and `pnt setup` fall back to them when your own log folder is empty;
- the extension offers them as **Try it with sample data** while its database is empty.

That way a fresh install has something to query instead of an empty page.

**These are someone else's hands.** Every player is a stand-in (`player 12`), and
every PokerNow ID and game ID is invented. Drop your own exports in
`~/Downloads/pokernow-logs` and re-run to add yours, or pass `--no-sample` to skip
these entirely.

```bash
pnt import path/to/pnt/logs      # or just `pnt import` with an empty log folder
```

Two things changed from the originals, and nothing else:

- **Hole cards nobody saw.** A `Your hand is` entry survives only where the same two
  cards also appear in a `shows a` entry for that hand. Hands the log owner did not
  show down no longer name their holding. Every opponent's cards are untouched:
  those were only ever in the log because they were shown at the table.
- **Who was playing.** Each name, player ID and game ID is replaced by the same
  stand-in everywhere, across every file and in `aliases.csv`. A real game ID
  would be enough to fetch the original log from PokerNow, so those go too. The
  stand-ins come from a key that was never kept, so a real ID cannot be checked
  against them.

Every stat `pnt` derives comes from the action stream, and the stand-ins map one
to one. These give the same numbers the raw exports do: the same hands, heroes and
merges. What is thinner is one player's range coverage, now at the showdown-only
level everybody else is at.

`tests/test_sample_logs.py` re-checks this folder on every run. It fails if anything
here names a holding that never reached showdown, or a player who is not a
stand-in. To add a log, put the raw export in your log folder and run
`pnt redact --anonymize --aliases <file> --out pnt/logs`. Never copy an export in
by hand.
