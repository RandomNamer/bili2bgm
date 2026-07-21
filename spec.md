# PRD: Bilibili → Bangumi (bgm.tv) Collection Migration

**Version:** 4.0 — Phase 1 re-architected onto agent-driven browser control (2026-07-21). Supersedes 3.2, whose CDP transport is dead (§0.4).
**Type:** One-shot migration, three phases, delivered as **one self-contained Claude skill** (`.claude/skills/bili2bgm/`) that is publishable on its own.
**Division of labor:**
- **Phase 1** — the **coding agent drives the user's real, logged-in Chrome** through the claude-in-chrome MCP, executing bundled in-page fetch snippets (§2). A bundled Node CLI owns all state.
- **Phase 1.5** — plain Node against `api.bgm.tv`, invoked by the agent.
- **Review page** — generated self-contained HTML. **Exclusion-list picker only. Performs zero writes.** Emits a small decisions JSON. One of only two human touchpoints.
- **Phase 2** — CLI that consumes the artifacts and performs all bgm.tv writes with robust failure handling (retry, resume, partial-failure recovery). Writing stays in code so unexpected events (429 storms, mid-run network loss, schema surprises, Ctrl-C) are handled deterministically and the run is resumable.

**Split of responsibility between agent and code — the organizing principle of v4:** the agent owns *judgment* (preflight, pacing, interpreting errors, deciding whether a count mismatch is drift or loss, walking the user through login, orchestrating phases, stopping at human gates). Bundled code owns *determinism* (the exact fetch loops, field mapping, progress parsing, merging, validation, checkpointing, resume manifests). Anything whose correctness can be pinned down in advance is a script, because an agent improvising a fetch loop at request 200 of 280 is how pacing rules get quietly dropped.

**Human touchpoints (exactly two, unchanged):** (1) open the review page, pick exclusions, save `decisions.json`; (2) provide `BGM_TOKEN` for Phase 2. Precondition: a Chrome with the Claude extension connected, logged into bilibili.

---

## 0. Verified ground truth (live-tested with the user's session — the agent may rely on these without re-research)

1. *(2026-07-20)* Bilibili follow lists and the user's **own rating/short review** are retrievable via in-page `fetch` in a logged-in real Chrome tab; **no WBI signing needed** for `x/space/bangumi/follow/list` and `pgc/review/user`. Both endpoints' response shapes in §2 were captured from live responses. This account's totals at capture time: anime 98 watched / 124 watching / 0 wish; cinema 5 / 38 / 1 → **266 items**. **These are observation records, not configuration** — see §6a.4: the uid is read from the live session and the totals are never asserted against constants.
2. Bilibili personal score is 0–10 (stars×2, ∈ {2,4,6,8,10}) — same scale family as bgm.
3. bgm.tv `/v0` endpoints and payload schemas in §3/§5 were verified against the live OpenAPI spec (`bangumi/server` `openapi/v0.yaml`); search was exercised live and returns correct subjects for Chinese titles (e.g. 颂乐人偶 → subject 454684).
4. *(2026-07-21, the finding that forced v4)* **Chrome ≥136 ignores `--remote-debugging-port` when running on the default user-data-dir.** Observed directly: Chrome 150 relaunched with the flag in its argv, `pgrep` confirming the flag, and nothing ever listening on the port. This is an intentional upstream change against cookie-theft malware. The port *does* open with an explicit `--user-data-dir`, but that is a fresh profile with no bilibili login — and the login is the entire reason a browser is involved. **Therefore: no CDP, no Playwright.** The only remaining way into a logged-in real session is the browser-control tooling the agent already has.

## 1. Architecture & artifacts

```
Phase 1   (AGENT: claude-in-chrome MCP → in-page fetch in the user's own Chrome)
  preflight (uid discovery) ─▶ 6 list passes ─▶ per-item personal review
  every chunk ─▶ phase1-merge.js ─▶ ①data/bili-export.json

Phase 1.5 (script: plain Node; all responses cached to disk)
  bgm search matching ─▶ existing-collection dedup ─▶ ②plan.json + ③review-page.html (data inlined)

Review    (HUMAN: double-click the HTML)
  exclusion picking + fix-ups ─▶ ④decisions.json  (saved into the working directory)

Phase 2   (script: writer CLI; HUMAN provides BGM_TOKEN)
  ①+②+④ + BGM_TOKEN ─▶ throttled writes ─▶ ⑤state.jsonl + ⑥report.md
```

Serialization boundaries (anti-API-abuse): every network phase persists locally (`bili-export.json`, `cache/search/*.json`, `bgm-existing.json`). Reruns read cache; the review page triggers no network at all. In Phase 1 the boundary is per **chunk**, not per phase — see §2.

## 2. Phase 1 — Bilibili extraction (agent-driven, browser context mandatory)

Bilibili has real anti-scraping (WBI params, `buvid3`/`bili_ticket` fingerprinting, `-412`). Standalone HTTP clients with copied cookies and fresh headless profiles are **disallowed** — and as of §0.4, so is CDP against the default profile. The only permitted transport is **in-page `fetch(url, {credentials:'include'})` executed inside the user's real, logged-in Chrome** via the claude-in-chrome MCP `javascript_tool`.

Note for the implementing agent: this must be the **claude-in-chrome** surface (the user's actual Chrome, carrying their sessions), not the in-app preview browser, which has no bilibili login and would be rejected exactly like a headless profile.

### Mechanics

**Preflight.** Run `snippets/preflight.js` in a `*.bilibili.com` tab: it calls `x/web-interface/nav` and returns `{isLogin, mid}`. Assert `isLogin === true` and **take `vmid` from `mid`** — never from a constant, an argument, or a prompt. If not logged in, tell the user to log into bilibili in that Chrome window and stop. The uid being discovered is what lets this ship as a public skill (§6a.4).

**Chunked execution.** The agent does not issue 280 individual tool calls. Each `javascript_tool` call runs a bundled snippet that loops *inside the page*:
- `snippets/fetch-list-page.js` — one follow-list page.
- `snippets/fetch-reviews.js` — a batch of ~20 review calls.

Chunking is the compromise between supervision and cost: small enough that the agent inspects results, checkpoints, and can abort ~14 times over the run; large enough that pacing is not hostage to model round-trip latency. **The jitter lives inside the snippet loop**, so it holds regardless of how the agent is behaving between calls.

**Timing — jitter mandatory on every request in every phase:** `sleep = base + U(0, 0.6·base)`, strictly sequential. List base **1.5 s**; review base **2.5 s**.

> Revised from 1.0 s after a live run on 2026-07-21: the six list passes (14 requests at 1.5 s) completed cleanly, then `-412` landed on the 21st consecutive `pgc/review/user` call at 1.0 s. The review endpoint is the sensitive one, and the original figure was too aggressive for sustained sequential access. Review pass is therefore ≈ 13 min for ~266 items rather than 6–8.

**Failure handling inside a chunk.** Every response is checked for `code === 0`. On `code:-412` or a non-JSON (HTML) body the snippet **stops the loop immediately** and returns `{blocked:true, results:[…captured so far…], detail}` — partial work is never discarded. The agent then persists, stops the whole run, and tells the user to wait ≥10 minutes before resuming. **Never auto-retry a `-412`**: it is a soft limit whose designed response is backing off, and hammering it is how accounts get hard-banned.

**Two caches, because a chunk can be lost in two different places.**
*In the page:* each fetch snippet writes every result to `localStorage` as it
lands, overwriting the buffer at the start of each chunk. If the tool call
itself dies — timeout, tab reload, truncated response — the requests already
happened and bilibili already counted them; `snippets/recover-chunk.js` reads
the buffer back in the same tab and returns a payload of the same shape, so the
chunk is merged rather than re-fetched into the rate limiter.
*On disk:* the agent writes each chunk's raw return value to `cache/phase1/`
before merging, and merges from that file rather than piping JSON through a
shell command. Payloads carry Chinese titles and nested quotes that shell
quoting mangles, and a raw chunk on disk can be re-merged without asking
bilibili for it twice.

**State.** `scripts/phase1-merge.js` is the only writer. After every chunk the agent pipes the raw payload into it (`merge lists` / `merge reviews`), and it maps, dedups, and rewrites `data/bili-export.partial.json`. So an interruption at any chunk boundary — crash, Ctrl-C, `-412`, the user closing Chrome — costs at most one chunk. `merge status` prints what is still missing (incomplete buckets/pages, media_ids lacking reviews), which is how a resumed run knows exactly what to fetch without re-deriving it. `merge finalize` validates and promotes the partial to `data/bili-export.json`.

### Endpoints
- `GET api.bilibili.com/x/space/bangumi/follow/list?type={1|2}&follow_status={1|2|3}&pn=&ps=30&vmid={uid}` — six passes.
- `GET api.bilibili.com/pgc/review/user?media_id={media_id}` — per item: `result.review.score`, `result.review.short_review.{content, ctime, mtime}`.

**Per-item record:** `id ("s_"+season_id)`, `title`, `season_title`, `season_id`, `media_id`, `bili_type`, `follow_status`, `season_type_name`, `formal_ep_count` (preferred over unreliable `total_count`), `progress_raw`, `progress_ep`, `air_date` (`publish.release_date`), `areas`, `series {title, season_count}`, `styles`, `url`, `my_score`, `my_review`, `my_review_time`, `review_fetched`, `raw`.

**Progress parsing (formats observed live):** `已看完第N话/集`→N; `看到第N话[ mm:ss]`→N; `看到 h:mm:ss` with `formal_ep_count==1`→1; unparseable (`看到丰川祥子 0:23`, `看到SP…`, `看到第10集预告`, `已看完元祖迷你22`, `尚未观看`, empty)→null (status still migrates). Expect ~20–30% null. Implemented once in `scripts/lib/progress.js`; the agent never eyeballs these strings itself.

## 3. Phase 1.5 — Matching, dedup, page generation

bgm read endpoints (UA per Bangumi policy, e.g. `zeyu/bili2bgm (one-shot migration)`; 1 req/s + jitter; backoff on 429/5xx):
- `POST /v0/search/subjects?limit=10` body `{keyword, filter:{type:[2]}}`
- `GET /v0/users/{username}/collections?subject_type=2` paginated → `bgm-existing.json`. Unauthenticated works for public collections. Username resolution order (§6a): `--bgm-user` argument → `BGM_USER` env → `GET /v0/me` if a `BGM_TOKEN` happens to be present → interactive stdin prompt. If none is available, **skip dedup**, emit an empty dup appendix, and print a warning; Phase 2's per-row safety re-check (§5.1) still prevents clobbering existing collections.

Normalization: NFKC; strip region/dub suffixes (`（僅限港澳台地區）`, `中配版`); unify 第N季 ↔ Season N ↔ N期.

**Tiers written into `plan.json`:**
- **perfect** — exact normalized title equality with `name_cn`/`name` AND (air-date year-month agrees OR sole candidate). Default-**included**.
- **attention** — imperfect; carries top-3 candidates with scores. Default-**excluded** until the user resolves (picks a candidate or types a subject_id) on the page.
- **dup** — subject already in `bgm-existing.json`. Not actionable; shown read-only with existing bgm status. Phase 2 never touches existing collections.

**Field mapping (consumed by Phase 2):**

| bgm field | Source | Rule |
|---|---|---|
| `type` | `follow_status` | 想看→1, 在看→3, 看过→2 |
| `rate` | `my_score` | curve `clamp(my_score − 2, 1, 10)` (10→8, 8→6, 6→4, 4→2, 2→1; clamp because `rate:0` means delete). Omit key if never rated. Per-row override allowed on page |
| `comment` | `my_review` | truncate 380 chars; per-row excludable on page (see §4) |
| `tags` | — | `["bilibili-import"]`, create-only (tags replace, never merge) |
| `private` | — | config, default false |
| ep progress | `progress_ep` | only for `type=3`, non-null, **and explicitly approved on the review page** (`include_ep`, §4.4) — default off |
| `ep_status`/`vol_status` | — | never (books-only) |
| timestamps | — | not writable on bgm |

## 4. Review page — exclusion-list picker (no writes, no token)

Self-contained HTML, vanilla JS, **data inlined** in a `<script type="application/json">` block (~300 KB; `file://` fetch of sibling files is CORS-blocked, so inlining is the only zero-server option; must work double-clicked from disk). The page never talks to any network.

Interaction model — **exclusion, not approval**:
1. **Main table** (perfect tier): every row **included by default**. One checkbox per row = *exclude*. Columns: bili title → matched bgm subject (link), status, curved rating (inline-editable), comment preview + per-row *exclude-comment* toggle, ep-progress note.
2. **Global switches**: exclude-all-comments, exclude-all-ratings, tag on/off, private on/off.
3. **Attention section** (collapsed): default-excluded rows; resolving one (radio candidate / manual subject_id) moves it to included.
4. **Episode-progress section** — every 在看 row with a non-null `progress_ep`, shown as `progress_raw` → parsed `progress_ep` so the user can audit the parse (§2) against the original string. **Default off for all rows**; one checkbox per row opts that row's ep-patches in, plus an approve-all switch. Rows that parsed to `null` are listed read-only as "not parsed — status only". Rationale: the parse is heuristic and a wrong ep count silently rewrites watch history, so it must be eyeballed rather than trusted.
5. **Dup appendix** (collapsed, read-only).
6. **Export**: shows live summary (`N subjects, M ratings, K comments, J ep-patches`) and renders **`decisions.json`** in a textarea for copy/paste — this act is the sign-off. Compact schema:

```jsonc
{
  "schema_version": 4,
  "exclude": ["s_123", "s_456"],              // excluded subject rows
  "resolve": { "s_789": 454684 },             // attention-tier manual matches
  "rate_override": { "s_111": 7 },            // post-curve edits
  "exclude_comment": ["s_222"],               // rows whose comment must not be posted
  "include_ep": ["s_333"],                    // opt-in: rows whose ep progress may be patched
  "global": { "comments": true, "ratings": true, "tags": true, "private": false }
}
```

`include_ep` is additive-but-inverted versus schema 3 (where ep-patching was implicit), hence the version bump: a v3 file loaded by Phase 2 must be treated as "no ep-patches", never as "all".

## 5. Phase 2 — Writer CLI

Node 20+ CLI in plain ESM JavaScript, zero dependencies (native `fetch`; hand-rolled validators for the four input contracts — §6a.8). Inputs: `bili-export.json`, `plan.json`, `decisions.json`, env `BGM_TOKEN` (from `next.bgm.tv/demo/access-token`), `BGM_UA`. Commands:

```
phase2-apply.js apply [--dry-run] [--yes]     # executes the decided plan
phase2-apply.js verify --sample 10            # post-run spot check via public GETs
```

**Write sequence per included row:**
1. Safety re-check `GET /v0/users/{username}/collections/{subject_id}` → if collected (race vs. snapshot), record `skipped_existing`, continue.
2. `POST /v0/users/-/collections/{subject_id}` with `type` (+`rate` unless excluded/never-rated, +`comment` unless excluded, +`tags` create-only, +`private`).
3. If Doing + `progress_ep` **and the row is listed in `decisions.include_ep`**: `GET /v0/episodes?subject_id&type=0` (paginate), take first `min(progress_ep, n)` by `sort`, `PATCH /v0/users/-/collections/{subject_id}/episodes {episode_id, type:2}`. Rows not opted in get status/rating/comment only, and the report notes them as `ep_skipped_not_approved`.

**Robustness requirements (the reason Phase 2 is code, not agent judgment):**
- Rate limit: global 1 req/s + jitter `U(0,600ms)`, single-flight.
- 429/5xx: exponential backoff 2/4/8/16 s, max 5, honor `Retry-After`. 401/403: abort whole run immediately (token/UA problem — do not spin into a ban). 400/404 on a row: record `failed` with response body, continue to next row.
- Circuit breaker: 3 consecutive row failures → pause run, print diagnosis, require manual continue.
- Idempotent resume: append-only `state.jsonl` (`{id, subject_id, action, http_status, ts}`); on start, terminalized ids are skipped, so crash/Ctrl-C/rerun is safe and duplicate-write-free. Partial rows (collection written, ep-patch failed) resume at the ep-patch step.
- `--dry-run` prints every intended request with payload, sends nothing.
- Output `report.md`: per-action totals, failures with reasons, dup list, unresolved-attention list with `https://bgm.tv/subject_search/...` links for manual cleanup. Token never appears in any log/artifact.

## 6. Repo layout, runbook & implementation notes

**Stack:** Node 20+, plain ESM JavaScript, **zero runtime dependencies** (§6a.6, §6a.8). No build step; the review page is a static template with a `/*__DATA__*/` injection marker.

```
bili2bgm/
  .claude/skills/bili2bgm/        # THE DELIVERABLE — self-contained, publishable as-is
    SKILL.md                      # orchestration: judgment, pacing, human gates
    snippets/
      preflight.js                # nav check → {isLogin, mid}
      fetch-list-page.js          # follow-list page range (placeholders substituted by the agent)
      fetch-reviews.js            # ~20 review calls, in-page jitter, early stop on -412
      recover-chunk.js            # read back the in-page running cache after a lost tool call
    scripts/
      phase1-merge.js             # merge lists|reviews, status, finalize  → data/bili-export.json
      phase15-plan.js             # matching + dedup → data/plan.json, out/review-page.html
      phase2-apply.js             # writer CLI: apply [--dry-run] [--yes] | verify --sample N
      lib/{contracts,progress,throttle,normalize,bgm}.js
    assets/template.html          # review page template
  data/  cache/  out/             # gitignored workspace, resolved from the INVOKING CWD
  README.md                       # the runbook, in Chinese (the only Chinese in the repo)
```

The skill directory is the unit of publication: it carries every script it needs and assumes nothing about the surrounding repo. Workspace directories are resolved from the invoking working directory, never from inside the skill, so a published copy never writes user data into itself.

**Runbook (goes in README):**
1. Chrome running with the Claude extension connected, logged into bilibili.
2. Ask Claude to run the migration. It preflights the session, extracts in chunks (~6–8 min), and writes `data/bili-export.json`. Interrupt any time; resume picks up from the last chunk. On `-412` it stops and you wait ≥10 min.
3. Matching runs next (`phase15-plan.js`, `--bgm-user <name>` for dedup) → tier counts + `out/review-page.html`.
4. Human: open the page, pick exclusions/resolutions, click Export, save as `data/decisions.json`.
5. `BGM_TOKEN=…` in the environment; dry-run first, then apply. Safe to Ctrl-C and rerun anytime.
6. `verify --sample 10`; read `out/report.md`.

**Notes for the implementer:**
- Everything in §0 is verified ground truth — do not re-validate endpoints; do run the Phase 1 preflight login check every time.
- Bilibili responses: treat `code !== 0` as error; `-412`/HTML body triggers the stop-and-persist path (§2). Keep the `raw` object per item — it is the escape hatch if a mapping field turns out wrong.
- bgm search is marked experimental upstream; if the response shape drifts from `plan` expectations, fail loudly with the raw body rather than guessing.
- The four JSON contracts (`bili-export`, `plan`, `decisions`, `state`) are the interfaces between phases; validate at every boundary and version them (`schema_version`).
- Do not add features not in this PRD (no GUI beyond the page, no incremental sync, no ID-mapping datasets — matching via search is sufficient here).

## 6a. Resolved decisions (binding; do not re-litigate)

1. **Comment semantics: opt-out**, as originally specced. Every bili short review is included unless its per-row toggle excludes it or the global switch is off. No inversion.
2. **`--fill-eps-on-done`: not implemented.** Batch-marking episodes for 看过 items is out of scope entirely.
3. **All episode writing is opt-in.** Nothing episode-related is sent unless the user ticks that row in the review page's episode section (§4.4). The page exists partly so the user can audit `progress_raw` → `progress_ep` before approving.
4. **No identity or secret may live in the repo or in the published skill** — both are intended to be public. Concretely:
   - The bilibili uid is **discovered** from the live browser session (`x/web-interface/nav` → `mid`, §2). Never hardcoded, never prompted for — the user's only obligation is to be logged in, in the Chrome the agent controls.
   - The bgm username is supplied at runtime (`--bgm-user` / `BGM_USER` / `/v0/me` if a token exists / stdin prompt), and dedup degrades to a warning if absent (§3).
   - `BGM_TOKEN` is env or stdin only; never a file in the repo, never echoed into the transcript, never written to `state.jsonl`, `report.md`, or any log.
   - `data/`, `cache/`, `out/` are gitignored because they contain the user's watch history, ratings, and reviews — personal data, not fixtures. Nothing derived from a real account is ever committed as a test fixture; script tests use fabricated chunks.
   - Anything in §0 that names a specific account is a capture note, not config.
5. **npm** for the (now empty) dependency story. No corepack, no `packageManager` field.
6. **Plain ESM JavaScript, not TypeScript.** Rationale: every input to this pipeline is untrusted bytes from a network or from disk, so the checking that matters happens at the boundaries — unchanged in JS. TS types over API responses are hand-written assertions about data we do not control, and their real payoff (safe refactors by many hands over months) does not apply to a tool that runs once. If a file wants editor help, use `// @ts-check` with JSDoc — never introduce a compile step.
7. **Phase 1 is agent-driven, not script-driven (2026-07-21).** Supersedes v3.2's Playwright-over-CDP mandate, which §0.4 proved unusable: the transport that reaches a logged-in profile no longer exists. The agent executes bundled snippets through claude-in-chrome and delegates all state to `phase1-merge.js`. Consequences that are part of the decision, not accidents of it: the fetch loops stay in versioned files rather than being composed per run (pacing and `-412` handling must not depend on model improvisation); the agent supervises at chunk boundaries; `playwright` leaves the dependency list.
8. **Zero runtime dependencies (2026-07-21).** Supersedes the `zod` allowance in §6a.6's stack note. The skill is meant to be published and run by strangers, and "clone, then `npm install` inside the skill" is friction that outlives us; hand-rolled validators (~150 lines for four contracts) cost less than that. The requirement zod was serving — validate every contract at every boundary with readable errors — is unchanged and non-negotiable.

## 7. Acceptance criteria

1. Phase 1 export counts equal API-reported bucket totals; jitter is evident in the snippet source and in chunk timings.
2. Phase 1.5 performs zero writes; reruns hit cache with zero new bgm requests.
3. Review page works from `file://` with no network; export JSON contains only ids/overrides (no titles needed, no secrets).
4. `apply --dry-run` provably sends nothing; `apply` after completion sends zero new writes on rerun.
5. Comments are posted only for rows not comment-excluded and with global comments=true.
5a. Zero episode PATCHes are sent for any row absent from `decisions.include_ep`; a decisions file with no `include_ep` key produces zero episode writes.
5b. `grep` of the repo *and of the packaged skill* finds no uid, username, token, or cookie; a fresh copy run by a different bilibili account works with no edits.
6. `verify --sample 10` matches expected status/rating/comment on bgm.tv.
7. A mid-run kill at any point, followed by rerun, produces no duplicates and completes the remainder. For Phase 1 specifically: interrupting at any chunk boundary and resuming re-fetches only what `merge status` reports missing, and a chunk lost *mid-flight* (tool call never returned) is recoverable from the in-page cache without re-issuing its requests.
7a. A bucket that has never been queried is never reported as empty. `status` distinguishes "not fetched yet" from a confirmed zero, and `finalize` refuses while any bucket is unstarted — every bucket maps to a bgm collection status, so silently dropping one drops a whole category of the user's collection.
8. The skill directory runs from a clean checkout with no install step, and writes nothing inside itself.
