#!/usr/bin/env node
// Phase 1 state-keeper (spec.md §2, "State").
//
// The agent fetches; this file owns everything that must be exactly right:
// mapping bilibili's payloads onto the contract, parsing progress strings,
// deduping, counting against each bucket's own reported total, and persisting
// after every chunk. Keeping it here rather than in the agent's head is what
// makes an interrupted run resumable — `status` reconstructs precisely what is
// missing from the file on disk, so nothing depends on the conversation still
// being around.
//
// Usage (all state lives in <cwd>/data/):
//   phase1-merge.js merge lists    < chunk.json    # {bucket:{...}, pn, total, list:[...]}
//   phase1-merge.js merge reviews  < chunk.json    # {results:[{media_id, review}, ...]}
//   phase1-merge.js status [--json]                # what still needs fetching
//   phase1-merge.js finalize                       # validate + promote to bili-export.json
//   phase1-merge.js reset                          # discard the partial and start over

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { parseProgress } from './lib/progress.js';
import { BiliExport, BILI_EXPORT_SCHEMA_VERSION, parseOrThrow } from './lib/contracts.js';

// Workspace is resolved from the invoking directory, never from inside the
// skill: a published copy must not accumulate someone's watch history (§6a.4).
const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_FILE = path.join(DATA_DIR, 'bili-export.json');
const PARTIAL_FILE = path.join(DATA_DIR, 'bili-export.partial.json');

const PAGE_SIZE = 30;

// All six are mandatory. Each maps onto a bgm collection status, so a bucket
// left unfetched is a whole category missing from the user's migrated
// collection — not a minor gap.
export const BUCKETS = [
  { bili_type: 1, follow_status: 1, label: 'anime / wish 想看' },
  { bili_type: 1, follow_status: 2, label: 'anime / doing 在看' },
  { bili_type: 1, follow_status: 3, label: 'anime / done 看过' },
  { bili_type: 2, follow_status: 1, label: 'cinema / wish 想看' },
  { bili_type: 2, follow_status: 2, label: 'cinema / doing 在看' },
  { bili_type: 2, follow_status: 3, label: 'cinema / done 看过' },
];

const bucketKey = (t, s) => `${t}/${s}`;

// ---------------------------------------------------------------- mapping

/** bilibili follow-list entry → contract item. */
export function toItem(raw, bucket) {
  const progressRaw = typeof raw.progress === 'string' ? raw.progress : null;
  const formalEpCount = Number.isFinite(raw.formal_ep_count) ? raw.formal_ep_count : null;

  return {
    id: `s_${raw.season_id}`,
    title: raw.title ?? '',
    season_title: raw.season_title ?? null,
    season_id: raw.season_id,
    media_id: Number.isFinite(raw.media_id) ? raw.media_id : null,
    bili_type: bucket.bili_type,
    follow_status: bucket.follow_status,
    season_type_name: raw.season_type_name ?? null,
    formal_ep_count: formalEpCount,
    progress_raw: progressRaw,
    progress_ep: parseProgress(progressRaw, formalEpCount),
    air_date: raw.publish?.release_date ?? null,
    areas: Array.isArray(raw.areas) ? raw.areas.map((a) => a?.name ?? String(a)) : [],
    series: raw.series
      ? {
          title: raw.series.series_title ?? raw.series.title ?? null,
          season_count: Number.isFinite(raw.series.season_count) ? raw.series.season_count : null,
        }
      : null,
    styles: Array.isArray(raw.styles)
      ? raw.styles.map((s) => (typeof s === 'string' ? s : (s?.name ?? String(s))))
      : [],
    url: raw.url ?? null,
    my_score: null,
    my_review: null,
    my_review_time: null,
    review_fetched: false,
    raw,
  };
}

// ---------------------------------------------------------------- state io

function emptyDoc() {
  return {
    schema_version: BILI_EXPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    partial: true,
    buckets: BUCKETS.map((b) => ({
      ...b,
      reported_total: 0,
      collected: 0,
      pages_fetched: [],
      complete: false,
    })),
    items: [],
  };
}

async function load() {
  for (const file of [PARTIAL_FILE, OUT_FILE]) {
    try {
      const doc = JSON.parse(await readFile(file, 'utf8'));
      return parseOrThrow(BiliExport, doc, path.basename(file));
    } catch (e) {
      // Missing file: fall through to the next candidate. Anything else
      // (corrupt JSON, contract drift) is surfaced — silently starting over
      // would mean re-fetching hundreds of requests against a rate limiter.
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return emptyDoc();
}

async function save(doc, file = PARTIAL_FILE) {
  doc.generated_at = new Date().toISOString();
  parseOrThrow(BiliExport, doc, path.basename(file));
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new Error('No input on stdin. Pipe the raw chunk JSON in.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`stdin is not valid JSON (${e.message}). Pass the snippet's return value verbatim.`);
  }
}

// ---------------------------------------------------------------- merge

/**
 * Merge one or more list pages. Accepts a single page object or an array.
 * Page shape: {bili_type, follow_status, pn, total, list:[...]}.
 * Re-merging a page already merged is a no-op beyond refreshing counters, so a
 * retried chunk can never duplicate rows.
 */
function mergeLists(doc, payload) {
  // Accepts the fetch-list-page snippet's return value verbatim ({pages:[…]}),
  // a bare array, or a single page — the agent should never have to reshape a
  // payload by hand, since that is exactly where a chunk gets silently dropped.
  const pages = Array.isArray(payload) ? payload : Array.isArray(payload.pages) ? payload.pages : [payload];
  const byId = new Map(doc.items.map((it) => [it.id, it]));
  let added = 0;

  for (const page of pages) {
    const spec = BUCKETS.find(
      (b) => b.bili_type === page.bili_type && b.follow_status === page.follow_status,
    );
    if (!spec) throw new Error(`Unknown bucket ${page.bili_type}/${page.follow_status} in input.`);
    const bucket = doc.buckets.find(
      (b) => b.bili_type === spec.bili_type && b.follow_status === spec.follow_status,
    );

    if (Number.isFinite(page.total)) bucket.reported_total = page.total;
    const list = Array.isArray(page.list) ? page.list : [];

    for (const raw of list) {
      const item = toItem(raw, spec);
      const prev = byId.get(item.id);
      if (prev) {
        // Seen before: keep whatever review data we already captured. A season
        // can only sit in one bucket, so a repeat means pagination drift or a
        // re-merged chunk, not a genuine second row.
        continue;
      }
      byId.set(item.id, item);
      doc.items.push(item);
      added += 1;
    }

    if (Number.isFinite(page.pn) && !bucket.pages_fetched.includes(page.pn)) {
      bucket.pages_fetched.push(page.pn);
      bucket.pages_fetched.sort((a, b) => a - b);
    }
    bucket.collected = doc.items.filter(
      (it) => it.bili_type === bucket.bili_type && it.follow_status === bucket.follow_status,
    ).length;
    // A bucket is done when we hold its reported total, or when the last page
    // came back short (the API's own signal that there is nothing after it).
    const shortPage = list.length < PAGE_SIZE;
    bucket.complete = bucket.collected >= bucket.reported_total || (shortPage && bucket.pages_fetched.length > 0);
  }
  return { added, pages: pages.length };
}

/**
 * Attach personal score / short review.
 * Input: {results:[{media_id, review:{score, short_review:{content, ctime, mtime}}}]}
 * or the bare array. Items whose media_id we do not hold are reported, not
 * silently dropped — that would mean the agent fetched against a stale manifest.
 */
function mergeReviews(doc, payload) {
  const results = Array.isArray(payload) ? payload : (payload.results ?? []);
  const byMediaId = new Map(doc.items.filter((i) => i.media_id != null).map((i) => [i.media_id, i]));
  let applied = 0;
  const unknown = [];

  for (const entry of results) {
    const item = byMediaId.get(entry.media_id);
    if (!item) {
      unknown.push(entry.media_id);
      continue;
    }
    // An entry with an explicit error is still terminal for this item: the
    // season may be delisted or region-locked, and retrying it every resume
    // would stall the run forever. Status still migrates without a rating.
    const review = entry.review ?? {};
    const short = review.short_review ?? null;
    item.my_score = Number.isFinite(review.score) && review.score > 0 ? review.score : null;
    item.my_review = short?.content ? String(short.content) : null;
    const time = short?.mtime ?? short?.ctime;
    item.my_review_time = Number.isFinite(time) ? time : null;
    item.review_fetched = true;
    applied += 1;
  }
  return { applied, unknown };
}

// ---------------------------------------------------------------- status

/**
 * The resume manifest. Everything the agent needs to decide what to fetch next,
 * derived from disk rather than from memory of the conversation.
 */
function buildStatus(doc) {
  const buckets = doc.buckets.map((b) => {
    const started = b.pages_fetched.length > 0;
    const nextPage = b.complete ? null : started ? Math.max(...b.pages_fetched) + 1 : 1;
    return {
      bili_type: b.bili_type,
      follow_status: b.follow_status,
      label: b.label,
      // `started` exists because a never-queried bucket and a genuinely empty
      // one both sit at 0, and confusing them silently drops a whole category
      // from the migration — the wish (想看) bucket is a real bgm collection
      // type, not a leftover. Until a page comes back, `reported_total` is a
      // placeholder, so it is reported as null rather than 0.
      started,
      reported_total: started ? b.reported_total : null,
      collected: b.collected,
      complete: b.complete,
      next_page: nextPage,
      count_matches: started && b.reported_total === b.collected,
    };
  });

  // Items still needing a review call. Ones without a media_id have no endpoint
  // to call, so they are terminal on arrival.
  const pendingReviews = doc.items.filter((i) => !i.review_fetched && i.media_id != null);
  const noMediaId = doc.items.filter((i) => !i.review_fetched && i.media_id == null);

  return {
    lists_complete: buckets.every((b) => b.complete),
    buckets,
    items_total: doc.items.length,
    reviews_done: doc.items.filter((i) => i.review_fetched).length,
    reviews_pending: pendingReviews.length,
    pending_media_ids: pendingReviews.map((i) => i.media_id),
    items_without_media_id: noMediaId.length,
    ready_to_finalize: buckets.every((b) => b.complete) && pendingReviews.length === 0 && noMediaId.length === 0,
  };
}

// CJK glyphs occupy two terminal columns but one code point, so String.padEnd
// leaves the labels ragged. Pad by display width instead.
function padLabel(label, width = 22) {
  const displayWidth = [...label].reduce((n, ch) => n + (/[⺀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1), 0);
  return label + ' '.repeat(Math.max(0, width - displayWidth));
}

function printStatus(s) {
  console.log('Buckets:');
  for (const b of s.buckets) {
    if (!b.started) {
      console.log(`  ${padLabel(b.label)}    ? / ?     NOT FETCHED YET — start at page 1`);
      continue;
    }
    const flag = b.complete
      ? b.count_matches
        ? 'complete'
        : 'complete (count differs from reported)'
      : `next page ${b.next_page}`;
    console.log(`  ${padLabel(b.label)} ${String(b.collected).padStart(4)} / ${b.reported_total}  ${flag}`);
  }
  const notStarted = s.buckets.filter((b) => !b.started);
  if (notStarted.length) {
    console.log(
      `\n  ${notStarted.length} bucket(s) have never been queried. Their size is unknown — ` +
        `"? / ?" is not "empty".\n  Every bucket maps to a bgm collection status, so skipping one drops that\n` +
        `  whole category from the migration.`,
    );
  }
  console.log(
    `\nItems: ${s.items_total}` +
      `\nReviews: ${s.reviews_done} done, ${s.reviews_pending} pending` +
      (s.items_without_media_id ? ` (+${s.items_without_media_id} have no media_id — nothing to fetch)` : '') +
      `\nReady to finalize: ${s.ready_to_finalize ? 'yes' : 'no'}`,
  );
  if (s.reviews_pending) {
    const preview = s.pending_media_ids.slice(0, 20);
    console.log(`\nNext review batch (${preview.length} of ${s.reviews_pending}):\n${JSON.stringify(preview)}`);
  }
}

// ---------------------------------------------------------------- finalize

async function finalize(doc, { force = false } = {}) {
  const status = buildStatus(doc);
  // Two kinds of imperfection, treated differently on purpose.
  // Blocking: work demonstrably not done — finalizing would hand phase 1.5 a
  // silently truncated collection, and a missing row looks identical to a row
  // the user never followed. Requires --force to say "yes, I know".
  // Warn-only: counts disagree with the API's own total, which happens when the
  // list shifts under pagination mid-run. Nothing is missing that we can name,
  // so it is the agent's and user's call, not the script's.
  const blocking = [];
  const warnings = [];
  for (const b of status.buckets) {
    if (!b.started) blocking.push(`${b.label}: never fetched — this whole category is missing`);
    else if (!b.complete) blocking.push(`${b.label}: incomplete, next page ${b.next_page}`);
    else if (!b.count_matches)
      warnings.push(`${b.label}: collected ${b.collected} but the API reported ${b.reported_total}`);
  }
  if (status.reviews_pending) blocking.push(`${status.reviews_pending} items still need review calls`);

  if (blocking.length && !force) {
    throw new Error(
      'Refusing to finalize — Phase 1 is not finished:\n' +
        blocking.map((p) => `  ! ${p}`).join('\n') +
        '\nRun `status` to see what is left, or pass --force if this partial export is what you want.',
    );
  }
  const problems = [...blocking, ...warnings];
  if (problems.length) {
    console.log(force && blocking.length ? 'Finalizing anyway (--force):' : 'Warnings before finalize:');
    for (const p of problems) console.log(`  ! ${p}`);
    console.log('');
  }

  doc.partial = false;
  await save(doc, OUT_FILE);
  await rm(PARTIAL_FILE, { force: true });

  const rated = doc.items.filter((i) => i.my_score != null).length;
  const reviewed = doc.items.filter((i) => i.my_review).length;
  const doing = doc.items.filter((i) => i.follow_status === 2);
  const withEp = doing.filter((i) => i.progress_ep != null).length;

  console.log(
    `Wrote data/bili-export.json\n` +
      `  ${doc.items.length} items, ${rated} rated, ${reviewed} with a short review\n` +
      `  progress parsed for ${withEp}/${doing.length} doing rows ` +
      `(the rest migrate as status only — spec.md §2)`,
  );
  return problems.length;
}

// ---------------------------------------------------------------- main

async function main(argv) {
  const [command, sub] = argv;

  switch (command) {
    case 'merge': {
      const doc = await load();
      const payload = await readStdin();
      if (sub === 'lists') {
        const { added, pages } = mergeLists(doc, payload);
        await save(doc);
        console.log(`Merged ${pages} list page(s): ${added} new item(s), ${doc.items.length} total.`);
      } else if (sub === 'reviews') {
        const { applied, unknown } = mergeReviews(doc, payload);
        await save(doc);
        const s = buildStatus(doc);
        console.log(`Merged ${applied} review(s). ${s.reviews_done} done, ${s.reviews_pending} pending.`);
        if (unknown.length) {
          console.log(`  ! ${unknown.length} media_id(s) not present in the export: ${JSON.stringify(unknown.slice(0, 10))}`);
          console.log('    That usually means the list passes are not finished yet.');
        }
      } else {
        throw new Error("merge needs a subcommand: 'lists' or 'reviews'");
      }
      break;
    }

    case 'status': {
      const doc = await load();
      const s = buildStatus(doc);
      if (argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
      else printStatus(s);
      break;
    }

    case 'finalize': {
      const doc = await load();
      await finalize(doc, { force: argv.includes('--force') });
      break;
    }

    case 'reset': {
      await rm(PARTIAL_FILE, { force: true });
      console.log('Discarded data/bili-export.partial.json. The next merge starts from scratch.');
      break;
    }

    default:
      console.log(
        'Usage:\n' +
          '  phase1-merge.js merge lists   < chunk.json\n' +
          '  phase1-merge.js merge reviews < chunk.json\n' +
          '  phase1-merge.js status [--json]\n' +
          '  phase1-merge.js finalize [--force]\n' +
          '  phase1-merge.js reset',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
