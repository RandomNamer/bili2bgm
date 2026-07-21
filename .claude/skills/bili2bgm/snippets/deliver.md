# How chunks get from the page to disk

The fetch snippets run inside a bilibili tab. The state-keeper runs on disk.
Getting a chunk from one to the other is the awkward part of this design, and
the two obvious routes are both closed:

**Returning the payload through the agent.** A single list page of 30 items is
~104 KB (measured live: ~3.5 KB per item once bilibili's covers, badges and
`new_ep` blobs are counted). A full extraction is ~925 KB, or roughly 230k
tokens of conversation. Beyond the cost, a truncated tool result would become a
silently truncated export.

**POSTing to a localhost server.** Blocked by bilibili's `connect-src` CSP —
the request never leaves the page (`TypeError: Failed to fetch`). A local sink
was built and discarded for this reason; don't rebuild it.

**What works: the download channel.** A page may always save a Blob it
constructed, and CSP does not govern downloads. Each snippet writes its chunk
to `~/Downloads/bili2bgm-<kind>-<label>.json` and returns only a short receipt.
The agent then moves the file into `cache/phase1/` and merges from there:

```bash
mv ~/Downloads/bili2bgm-lists-anime-done.json cache/phase1/
node <skill>/scripts/phase1-merge.js merge lists < cache/phase1/bili2bgm-lists-anime-done.json
```

Full fidelity (including each item's `raw`), near-zero context cost, and the
raw chunk stays on disk so a bad merge can be replayed without asking bilibili
for the same data twice.

Two things to know:
- Chrome may append ` (1)`, ` (2)` to a filename that already exists in
  Downloads. Move the file into `cache/phase1/` promptly and the collisions
  stop; if you see a suffixed name, that is what happened.
- The in-page `localStorage` buffer still runs alongside this
  (`snippets/recover-chunk.js`). It covers the narrower case where the download
  never fired because the chunk died mid-flight.
