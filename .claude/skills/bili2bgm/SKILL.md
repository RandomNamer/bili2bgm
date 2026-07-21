---
name: bili2bgm
description: Migrate a Bilibili anime/cinema follow list (追番/追剧 — watch status, personal ratings, short reviews) into a bgm.tv (Bangumi) collection. Use this skill whenever the user mentions moving, migrating, syncing, importing, or exporting bilibili watch history, 追番 lists, bangumi.tv/bgm.tv collections, or asks to get their bilibili anime data out — even if they do not name this tool, and even if they only describe half the pipeline ("scrape my bilibili follow list", "fill in my bgm ratings from bilibili"). Also use it to resume, continue, or finish a migration that was interrupted.
---

# bili2bgm — Bilibili → bgm.tv collection migration

You drive this migration end to end. It is a one-shot, four-stage pipeline with
exactly two moments where a human must act. Read `spec.md` in the project root
if you need the full rationale; this file is the operating manual.

```
Phase 1    you + the user's Chrome   ─▶ data/bili-export.json
Phase 1.5  scripts/phase15-plan.js   ─▶ data/plan.json + out/review-page.html
HUMAN      opens the page, signs off ─▶ data/decisions.json
Phase 2    scripts/phase2-apply.js   ─▶ out/state.jsonl + out/report.md
```

## The division of labor, and why it is drawn here

You own **judgment**: checking the session, pacing, reading errors, deciding
whether a count mismatch is drift or loss, walking the user through a login,
knowing when to stop.

The bundled scripts own **determinism**: the fetch loops, field mapping,
progress parsing, deduping, validation, checkpointing, resume manifests.

Do not blur this line. Concretely: **never write your own fetch loop.** The
snippets in `snippets/` encode pacing and abort rules that protect the user's
account, and an improvised loop at request 200 of 280 is exactly how those rules
get quietly dropped. Substitute the placeholders, run the file, move on.

## Before you start

Check things rather than asking about them. The only questions worth a user's
attention are the ones you genuinely cannot answer yourself.

1. **The browser must be the user's real Chrome** — the `claude-in-chrome` MCP
   tools (`mcp__claude-in-chrome__*`), which carry their logged-in sessions. The
   in-app preview browser has no bilibili cookies and would be rejected by the
   anti-bot layer exactly like a headless profile. If those tools are not
   loaded, load them with ToolSearch:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool`
   If the extension is not connected at all, say so and stop — nothing else in
   this skill works without it.
2. **Resume or fresh?** Run `node <skill>/scripts/phase1-merge.js status`. If it
   reports existing work, tell the user what is already captured and confirm
   they want to continue it rather than start over (`reset` discards it).
3. **Go/no-go.** Phase 1 takes roughly 6–8 minutes of steady activity in their
   Chrome. Say that before you begin, and ask them to leave that window alone
   while it runs.

Everything else is a documented default: all six buckets, ~20 reviews per
chunk, output under `data/`. Only revisit those if the user raises them.

## Phase 1 — extraction

All scripts write to `data/` and `cache/` relative to the **current working
directory**, so run them from the project root, not from inside the skill
directory. `<skill>` below means the directory this SKILL.md lives in — use its
absolute path.

### Step 1: preflight

Open or focus a `*.bilibili.com` tab, then run `snippets/preflight.js` verbatim
through `javascript_tool`.

- `isLogin: true` → take `mid` as the uid. **This is the only source of the
  uid.** Never hardcode it, never ask the user for it, never read it from a
  previous run's data. Discovery is what lets this skill be published and work
  for whoever happens to be logged in.
- `isLogin: false` → tell the user to log into bilibili in that Chrome window,
  then rerun preflight. Do not proceed.
- `blocked: true` → the anti-bot wall is already up. Follow the -412 protocol
  below.

### Step 2: the six list passes

Six buckets: type 1 (anime 追番) and 2 (cinema 追剧) × follow_status 1 (wish),
2 (doing), 3 (done).

All six are mandatory. Each maps to a bgm collection status, so a bucket you
skip is a whole category missing from the user's migrated collection. `status`
prints `? / ?  NOT FETCHED YET` for buckets never queried — that is pending
work, never "empty". Only a bucket that has actually returned a page can be
called empty.

For each bucket, run `snippets/fetch-list-page.js` with `__VMID__`, `__TYPE__`,
`__STATUS__`, `__PN_START__`, `__PN_END__` substituted. Fetch page 1 alone
first — `total` in the response tells you how many pages exist (30 per page) —
then fetch the rest in one call as a range.

**Save each chunk to disk before merging.** Write the snippet's return value
verbatim to `cache/phase1/<bucket>-<pages>.json` with the Write tool, then:

```bash
node <skill>/scripts/phase1-merge.js merge lists < cache/phase1/<file>.json
```

Two reasons this beats piping the payload through a shell command. Payloads
carry Chinese titles, apostrophes and nested quotes, and `echo '<json>'` mangles
them in ways that surface as a confusing parse error rather than an obvious
one. And the raw chunk on disk means a merge that goes wrong can be replayed
without asking bilibili for the same data twice.

Merging after every chunk is what makes an interruption cheap. Never accumulate
several chunks in your context and merge at the end: a crash or a context
compaction takes them with it.

### Step 3: personal ratings and short reviews

`node <skill>/scripts/phase1-merge.js status --json` gives you
`pending_media_ids`. Take ~20, substitute into `snippets/fetch-reviews.js`,
run, save the return value to `cache/phase1/reviews-<n>.json`, then
`merge reviews < that file`. Repeat until `reviews_pending` is 0. Roughly 14
rounds for a typical account.

Per-item errors inside a batch (delisted season, region lock) are recorded and
the batch continues — those are terminal facts about the item, and the watch
status still migrates without a rating.

### If a chunk's tool call does not come back cleanly

Timeout, truncated response, tab reload: the requests already happened and
bilibili already counted them. Re-running the fetch pays that cost a second
time for data you probably still have.

Run `snippets/recover-chunk.js` **in the same bilibili tab, before starting the
next chunk** — each fetch snippet keeps a running cache in the page as results
land, but overwrites it when the next chunk begins. It returns a `payload` in
the same shape the fetch would have returned, so save it to `cache/phase1/` and
merge it normally. If it comes back `complete: false`, the loop was cut short:
merge what is there and let `status` tell you what is still missing, rather
than assuming the chunk finished.

### Step 4: finalize

```bash
node <skill>/scripts/phase1-merge.js finalize
```

It refuses if buckets are incomplete or reviews are pending, which is the
signal to keep going rather than to reach for `--force`. Count mismatches
against the API's own reported totals are warnings, not blockers — see the
judgment section.

## The -412 protocol

`code: -412` (or an HTML response body) means bilibili's soft rate limit has
tripped. The snippets stop their loop the moment they see it and return
everything captured so far.

When that happens, the run is over until the user says otherwise. Concretely:

1. **Merge whatever the snippet captured** — it is real data, already paid for.
2. **Abort the pipeline.** Do not start another chunk, do not move on to Phase
   1.5, do not finalize. A `-412` means Phase 1 is unfinished, and an unfinished
   Phase 1 invalidates everything downstream. (`finalize` and `phase15-plan.js`
   both refuse a partial export, but do not lean on that — stop deliberately.)
3. **Tell the user plainly, at the top of your reply**, not buried at the end.
   State: that bilibili rate-limited the run, exactly what is on disk, exactly
   what remains, the earliest safe resume time (block time + 10 minutes), and
   that nothing is lost. Something like:

   > Bilibili rate-limited the extraction (`-412`) at 01:05. Stopped — no
   > retry. On disk: all 266 items, 20 of 266 ratings/reviews. Remaining: 246
   > review calls. Earliest safe resume: 01:16. Nothing was lost; resuming
   > re-fetches only what is missing.

4. **If you do unrelated work during the wait** — writing code for a later
   phase, say — say so explicitly rather than letting it look like the
   migration is still progressing.

Waiting costs ten minutes. Getting this wrong costs the user their bilibili
account, so the asymmetry is not close.

**On resume, slow down.** A block is evidence the current pacing is too fast
for this account right now, so returning at the same rate invites the same
wall. Raise the review base to ~2.5 s and shrink the batch (10 or so), then
watch the first batch before continuing at that rate.

**If the resume is refused too, stop for much longer.** Observed live on
2026-07-21: `pgc/review/user` was still returning the 412 wall eleven minutes
after the first block, on every media_id tried. Ten minutes is a floor, not a
reliable cure — a persistent block wants 30–60 minutes, and possibly a session
the user has been browsing normally in between.

**Probe discipline.** When a resume fails you may spend **at most three**
spaced requests establishing whether the block is endpoint-wide or specific to
one item — try two different media_ids and the failing one. That distinction
matters, because a single poisoned id would otherwise stall every future resume
(the next batch always starts from the first pending id). Once you have the
answer, stop; do not keep probing to see if it cleared. Report and hand back to
the user.

**Never auto-retry a -412, and never "try just one more to check".** It is a
soft limit whose designed response is backing off; hammering it is how a soft
limit becomes a banned account. Waiting costs ten minutes, and getting this
wrong costs the user their bilibili account. There is no version of this where
retrying immediately is the right call.

## Judgment calls that are yours

- **Count mismatch.** A bucket's `collected` differing from its API-reported
  `total` usually means the list shifted under pagination while the user was
  watching something. Report it, name the bucket, and let the user decide
  whether to re-run that bucket. Do not silently accept it, and do not treat it
  as corruption.
- **Pacing.** If responses start slowing noticeably, wait longer between chunks.
  The jitter inside each snippet is a floor, not a ceiling.
- **Surprises.** Unfamiliar response shapes, odd progress strings, an endpoint
  returning something new: record it, keep going if the run can continue, and
  summarize at the end. Do not paper over it, and do not guess at a mapping —
  the raw payload is preserved per item precisely so a wrong guess is
  recoverable later.
- **What you never decide alone:** anything that writes to bgm.tv. That is
  gated on the review page and the token, below.

## Phase 1.5 — matching

> Both `phase15-plan.js` and `phase2-apply.js` exist and have been run end to
> end. Phase 2 always starts with `plan`, which sends nothing and writes
> `out/planned-calls.html` — one row per request with the literal JSON body.
> Read that before `apply`; it is the cheapest place to catch a systematic
> mistake, and `apply` sends exactly what it showed.

```bash
node <skill>/scripts/phase15-plan.js --bgm-user <name>
```

Searches bgm.tv for each item, dedups against the user's existing collection,
and writes `data/plan.json` plus `out/review-page.html`. It caches every search
to `cache/search/`, so reruns cost zero new requests. `--bgm-user` is only for
dedup; without it the script warns and skips dedup, and Phase 2's per-row
safety check still prevents clobbering existing collections.

Report the tier counts it prints: **perfect** (matched, included by default),
**attention** (ambiguous, excluded until the user resolves it), **dup**
(already on bgm, never touched).

## Human gate 1 — the review page

Tell the user to open `out/review-page.html` (double-click; it works offline
and talks to no network), make their choices, click Export, and save the JSON
as `data/decisions.json`.

This is a sign-off, not a formality, and it is theirs alone. Everything is
included by default except two things they must opt into: ambiguous matches,
and episode progress. Episode progress is off by default because the parse of
bilibili's free-text progress (`看到第7话`, `看到丰川祥子 0:23`) is heuristic
and about a quarter of it is unparseable — a wrong episode count silently
rewrites watch history. The page shows the raw string beside the parsed number
so they can audit it. Do not tick those boxes on their behalf, and do not
hand-write `decisions.json` for them.

## Human gate 2 — the token, then writing

Phase 2 needs `BGM_TOKEN` (from `next.bgm.tv/demo/access-token`) in the
environment. **Ask the user to export it in their shell themselves — never
have them paste it into the chat**, and never write it to a file, a log, or any
artifact.

```bash
node <skill>/scripts/phase2-apply.js apply --dry-run
node <skill>/scripts/phase2-apply.js apply
node <skill>/scripts/phase2-apply.js verify --sample 10
```

Always dry-run first and show the user the summary before the real run. The
apply step is resumable and idempotent: `out/state.jsonl` is append-only, and
a rerun skips rows already written. If it aborts on 401/403, that is a token or
UA problem — fix it, do not retry into it. Finish by reading `out/report.md`
back to the user: totals, failures, dups, and any unresolved attention rows.

## Non-negotiables, and why

- **No identity or secret ever lands in a file.** The uid is discovered, the
  bgm username is passed at runtime, the token is env-only. The whole point is
  that this skill can be published and the user's repo can be public.
- **Run the snippets, don't rewrite them.** Pacing and abort rules live there.
- **Merge every chunk immediately.** Context is not storage.
- **The two human gates are real.** Nothing writes to bgm.tv that the user did
  not approve on the page, and no episode is patched that they did not tick.
