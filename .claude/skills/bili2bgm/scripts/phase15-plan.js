#!/usr/bin/env node
// Phase 1.5 — match bilibili items to bgm subjects, dedup, generate the review
// page (spec.md §3, §4).
//
// This phase performs zero writes to bgm.tv. It reads, it assigns each row a
// state, and it produces something a human can sign off on. State is the point:
// a title that matches exactly and agrees on air date can be trusted by
// default, and everything else has to be looked at, because the cost of a wrong
// match is silently overwriting the wrong show in someone's collection.
//
//   phase15-plan.js [--bgm-user <name>] [--limit N] [--no-dedup]
//
// Outputs: data/plan.json, data/bgm-existing.json, out/review-page.html

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { searchSubjects, fetchCollections, whoami } from './lib/bgm.js';
import { normalizeTitle, searchTitle, seasonNumber, yearMonth, similarity } from './lib/normalize.js';
import {
  BiliExport,
  Plan,
  PLAN_SCHEMA_VERSION,
  parseOrThrow,
} from './lib/contracts.js';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_DIR = path.resolve(process.cwd(), 'out');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);

// bilibili follow_status → bgm collection type (spec.md §3 field mapping)
const BGM_TYPE = { 1: 1, 2: 3, 3: 2 }; // wish→1, doing→3(doing), done→2(collect)

/** spec.md §3: clamp(my_score - 2, 1, 10). rate 0 means "delete" on bgm, so never emit it. */
function curveRate(myScore) {
  if (!Number.isFinite(myScore) || myScore <= 0) return null;
  return Math.min(10, Math.max(1, myScore - 2));
}

/** Which bgm subject types to search for a given bilibili list.
 *  追番 is anime. 追剧 carries live-action film and TV, which live under bgm's
 *  "real" type — searching anime only would strand every drama as
 *  unmatched. This widens spec.md §3's type:[2] deliberately. */
const searchTypes = (biliType) => (biliType === 2 ? [2, 6] : [2]);

/**
 * Every name a bgm subject is known by.
 *
 * `name_cn` is frequently empty even for shows with a well-known Chinese title —
 * subject 454684 is "BanG Dream! Ave Mujica" with no name_cn, while the title
 * bilibili uses (颂乐人偶) sits in the infobox under 别名 as the 大陆版权译.
 * Matching on name/name_cn alone therefore misses a whole class of Chinese
 * titles, which is exactly the population being migrated here.
 */
export function subjectTitles(subject) {
  const out = [subject.name, subject.name_cn];
  const box = Array.isArray(subject.infobox) ? subject.infobox : [];
  for (const field of box) {
    if (!field || (field.key !== '别名' && field.key !== '中文名')) continue;
    if (typeof field.value === 'string') out.push(field.value);
    else if (Array.isArray(field.value)) for (const v of field.value) if (v && typeof v.v === 'string') out.push(v.v);
  }
  return out.filter((t) => typeof t === 'string' && t.trim() !== '');
}

function scoreCandidate(item, subject) {
  return Math.max(...subjectTitles(subject).map((t) => similarity(item.title, t)), 0);
}

/**
 * Decide the state. "matched" demands exact normalized equality on one of the
 * subject's titles AND either agreeing air months or being the only candidate —
 * two independent signals, because Chinese anime titles repeat across seasons
 * and franchises far too often for a title alone to be conclusive.
 */
function classify(item, candidates) {
  if (candidates.length === 0) {
    return { state: 'unmatched', subject: null, reason: 'no bgm search results' };
  }

  const itemNorm = normalizeTitle(item.title);
  const itemSeason = seasonNumber(item.title);
  const itemYM = yearMonth(item.air_date);

  // An exact hit on any known name — official, Chinese, or licensed alias.
  const exact = [];
  for (const c of candidates) {
    const hit = (c.titles || []).find((t) => normalizeTitle(t) === itemNorm);
    if (hit) exact.push({ c, hit });
  }

  for (const { c, hit } of exact) {
    const cSeason = Math.max(...(c.titles || []).map((t) => seasonNumber(t) ?? -1));
    // A season mismatch is disqualifying even with identical text: migrating
    // season 1's status onto season 3 is worse than asking the user.
    if (itemSeason !== null && cSeason > 0 && itemSeason !== cSeason) continue;
    const cYM = yearMonth(c.date);
    const datesAgree = itemYM && cYM && itemYM.slice(0, 7) === cYM.slice(0, 7);
    const via = hit === c.name || hit === c.name_cn ? '' : ` (matched via alias “${hit}”)`;
    if (!c.name_cn && hit !== c.name) c.name_cn = hit;
    if (datesAgree) return { state: 'matched', subject: c, reason: `exact title and air month agree${via}` };
    if (exact.length === 1 && candidates.length === 1) {
      return { state: 'matched', subject: c, reason: `exact title, sole candidate${via}` };
    }
  }

  if (exact.length === 1) {
    return {
      state: 'unmatched',
      subject: exact[0].c,
      reason: 'exact title but air date does not corroborate — confirm this is the right season',
    };
  }

  // No string match — but string equality is the wrong instrument for this
  // catalogue. Bilibili's Taiwan/HK licences carry traditional Chinese
  // (無神世界的神明活動) while bgm holds simplified (无神世界的神明活动), and
  // separate licensees translate the same show entirely differently
  // (不當哥哥了！ vs 别当欧尼酱了！). Those pairs share no characters, so no
  // amount of normalization reaches them.
  //
  // bgm's own search already resolves them: it returned the correct subject at
  // rank 1 in every one of those cases. So use two independent signals that do
  // not depend on spelling — bgm ranked it first, and the premiere months
  // agree. A same-month premiere plus a top-ranked hit is a strong pair, and
  // anything relying on it is labelled so the user can scan these rows first.
  const top = candidates[0];
  const topYM = yearMonth(top.date);
  if (itemYM && topYM && itemYM.slice(0, 7) === topYM.slice(0, 7)) {
    const topSeason = Math.max(...(top.titles || []).map((t) => seasonNumber(t) ?? -1));
    if (itemSeason === null || topSeason <= 0 || itemSeason === topSeason) {
      return {
        state: 'matched',
        subject: top,
        reason: `bgm's top search hit and the premiere month agrees (titles differ — likely a 繁/简 or translation difference)`,
      };
    }
  }
  return { state: 'unmatched', subject: null, reason: 'no exact title match' };
}

async function resolveUsername() {
  const fromArg = flag('--bgm-user');
  if (fromArg) return fromArg;
  if (process.env.BGM_USER) return process.env.BGM_USER;
  if (process.env.BGM_TOKEN) {
    try {
      const name = await whoami(process.env.BGM_TOKEN);
      if (name) return name;
    } catch {
      // A token that cannot identify itself is not worth stopping the run over;
      // dedup simply degrades.
    }
  }
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('bgm.tv username (blank to skip dedup): ')).trim();
      if (answer) return answer;
    } finally {
      rl.close();
    }
  }
  return null;
}

async function main() {
  // Matching depends only on title and air date, which the list passes already
  // captured — ratings and comments play no part in it. So a partial export can
  // legitimately be matched, and doing it early is useful: every search response
  // is cached, so the real run afterwards costs bgm.tv nothing.
  //
  // What a partial export must NOT do is produce a sign-off surface. Rows whose
  // review call has not run yet look identical to rows the user never rated, and
  // approving that would migrate a collection with the ratings silently missing.
  // Hence --allow-partial gates it, the plan is flagged, and the page is written
  // under a different name with a banner on it.
  const allowPartial = has('--allow-partial');
  const finalPath = path.join(DATA_DIR, 'bili-export.json');
  const partialPath = path.join(DATA_DIR, 'bili-export.partial.json');

  let doc = null;
  let usedPartial = false;
  try {
    doc = parseOrThrow(BiliExport, JSON.parse(await readFile(finalPath, 'utf8')), 'bili-export.json');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!doc && allowPartial) {
    try {
      doc = parseOrThrow(BiliExport, JSON.parse(await readFile(partialPath, 'utf8')), 'bili-export.partial.json');
      usedPartial = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!doc) {
    throw new Error(
      'data/bili-export.json not found. Finish Phase 1 first (phase1-merge.js finalize),\n' +
        'or pass --allow-partial to match against the partial export (priming the search\n' +
        'cache; produces a provisional page that must not be signed off).',
    );
  }
  if (doc.partial && !allowPartial) {
    throw new Error('data/bili-export.json is marked partial. Finish Phase 1 before matching.');
  }
  const pendingReviews = doc.items.filter((i) => !i.review_fetched).length;
  if (usedPartial || doc.partial) {
    console.log(
      `! PROVISIONAL RUN — the export is incomplete (${pendingReviews} of ${doc.items.length} items\n` +
        `  have no rating/short-review data yet). Matching is unaffected, and the search\n` +
        `  cache this fills makes the final run free. But the page produced here is NOT a\n` +
        `  sign-off surface: rows missing a review look exactly like rows never rated.\n` +
        `  Finish Phase 1, then rerun without --allow-partial.\n`,
    );
  }

  const limit = Number(flag('--limit')) || Infinity;
  const items = doc.items.slice(0, limit === Infinity ? undefined : limit);
  console.log(`Matching ${items.length} items against bgm.tv …`);

  // --- dedup snapshot ----------------------------------------------------
  let username = has('--no-dedup') ? null : await resolveUsername();
  let existing = [];
  let dedupPerformed = false;
  if (username) {
    try {
      existing = await fetchCollections(username, [2, 6], { token: process.env.BGM_TOKEN });
      dedupPerformed = true;
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(path.join(DATA_DIR, 'bgm-existing.json'), JSON.stringify(existing, null, 2));
      console.log(`Existing bgm collection: ${existing.length} subjects (data/bgm-existing.json)`);
    } catch (e) {
      console.log(`! Could not read ${username}'s collection (${e.message}). Continuing without dedup.`);
    }
  } else {
    console.log(
      '! No bgm username available — skipping dedup. Phase 2 still re-checks every row\n' +
        '  before writing, so existing collections cannot be clobbered; you will just see\n' +
        '  an empty dup appendix on the review page.',
    );
  }
  const existingById = new Map(existing.map((c) => [c.subject_id, c]));

  // --- match -------------------------------------------------------------
  // Optional second-pass verdicts on unmatched rows (see --verdicts). Only
  // 'match' and 'unsure' are carried; a 'no_match' verdict is the same as
  // having no opinion, and saying so on the page would just be noise.
  const verdicts = new Map();
  const verdictsPath = flag('--verdicts');
  if (verdictsPath) {
    const raw = JSON.parse(await readFile(path.resolve(process.cwd(), verdictsPath), 'utf8'));
    for (const v of raw) {
      if (v.verdict !== 'match' && v.verdict !== 'unsure') continue;
      if (!Number.isFinite(v.subject_id)) continue;
      verdicts.set(v.id, {
        subject_id: v.subject_id,
        verdict: v.verdict,
        confidence: v.confidence ?? 'low',
        reason: v.reason ?? '',
      });
    }
    console.log(`Second-pass verdicts: ${verdicts.size} suggestion(s) from ${verdictsPath}`);
  }

  // The review page only renders the top 3 candidates, so a suggestion pointing
  // anywhere else would pre-select a radio that does not exist — the row would
  // look answered and export nothing. Drop those loudly rather than silently:
  // a verdict file is authored by a model or a human and is not trusted input.
  let droppedSuggestions = 0;
  const suggestionFor = (id, candidates) => {
    const s = verdicts.get(id);
    if (!s) return null;
    if (!candidates.slice(0, 3).some((c) => c.id === s.subject_id)) {
      droppedSuggestions += 1;
      console.warn(`  dropped suggestion for ${id}: subject ${s.subject_id} is not among its candidates`);
      return null;
    }
    return s;
  };

  const rows = [];
  let searched = 0;
  let cachedHits = 0;

  for (const item of items) {
    // Search on the cleaned title, compare on the raw one. bilibili's licensing
    // suffixes are noise bgm has never indexed, and leaving them in the query
    // costs candidates outright.
    const keyword = searchTitle(item.title) || item.title;
    let candidates = [];
    let searchError = null;
    try {
      const res = await searchSubjects(keyword, searchTypes(item.bili_type));
      if (res.cached) cachedHits += 1;
      searched += 1;
      candidates = (res.data || []).map((s) => ({
        id: s.id,
        name: s.name ?? '',
        name_cn: s.name_cn ?? '',
        date: s.date ?? null,
        image: s.images?.common ?? s.image ?? null,
        // Carried so the review page can justify itself offline: the episode
        // count is what makes a progress number checkable, and the summary is
        // what settles "is this the same show" for a human in one glance. All
        // of it is already in the cached search payload, so it costs nothing.
        eps: s.eps ?? null,
        total_episodes: s.total_episodes ?? null,
        platform: s.platform ?? null,
        summary: typeof s.summary === 'string' ? s.summary.slice(0, 300) : null,
        titles: subjectTitles(s),
      }));
    } catch (e) {
      if (e.fatal) throw e;
      searchError = e.message;
    }

    for (const c of candidates) c.score = Number(scoreCandidate(item, c).toFixed(3));
    candidates.sort((a, b) => b.score - a.score);

    let { state, subject, reason } = searchError
      ? { state: 'unmatched', subject: null, reason: `search failed: ${searchError}` }
      : classify(item, candidates);

    // Second-pass promotion. Only a *high* confidence verdict becomes
    // ai_matched; medium and unsure stay unmatched and merely pre-fill a
    // suggestion, because the deterministic matcher already declined this row
    // and a shaky second opinion is not reason to overrule it silently.
    // ai_matched stays a state of its own rather than collapsing into matched,
    // so "a model decided this" remains visible all the way into Phase 2.
    const suggestion = state === 'unmatched' ? suggestionFor(item.id, candidates) : null;
    if (suggestion && suggestion.verdict === 'match' && suggestion.confidence === 'high') {
      const promoted = candidates.find((c) => c.id === suggestion.subject_id);
      if (promoted) {
        state = 'ai_matched';
        subject = promoted;
        reason = suggestion.reason || 'second-pass match';
      }
    }

    // Dedup wins over everything: an existing collection is never touched.
    const hit = subject && existingById.get(subject.id);
    let existingInfo = null;
    if (hit) {
      state = 'reported';
      existingInfo = { type: hit.type ?? null, rate: hit.rate ?? null };
      reason = 'already in your bgm collection — Phase 2 will not touch it';
    }

    rows.push({
      id: item.id,
      title: item.title,
      season_title: item.season_title,
      url: item.url,
      bili_type: item.bili_type,
      follow_status: item.follow_status,
      bgm_type: BGM_TYPE[item.follow_status] ?? 1,
      air_date: item.air_date,
      formal_ep_count: item.formal_ep_count,
      progress_raw: item.progress_raw,
      // Episode progress is only meaningful while a series is in progress. A bgm
      // "看过" collection already implies every episode; carrying bilibili's last
      // watched position onto it would *understate* a finished show (a row marked
      // done whose progress reads 看到第1话 would land as 1/12). progress_raw is
      // kept either way so the original string stays auditable.
      progress_ep: BGM_TYPE[item.follow_status] === 3 ? item.progress_ep : null,
      my_score: item.my_score,
      curved_rate: curveRate(item.my_score),
      my_review: item.my_review,
      // One of: reported (already collected on bgm — never touched),
      // matched (deterministic), ai_matched (second-pass, high confidence),
      // unmatched (the human decides).
      state,
      subject_id: subject ? subject.id : null,
      subject: subject ? (({ titles, ...c }) => c)(subject) : null,
      candidates: candidates.slice(0, 3).map(({ titles, ...c }) => c),
      existing: existingInfo,
      reason,
      // Kept on unmatched rows too, where it pre-fills a candidate without
      // deciding anything; on ai_matched rows it is the provenance of the call.
      suggestion,
    });

    if (rows.length % 25 === 0) console.log(`  ${rows.length}/${items.length} …`);
  }

  const nIn = (s) => rows.filter((r) => r.state === s).length;
  const counts = {
    matched: nIn('matched'),
    ai_matched: nIn('ai_matched'),
    unmatched: nIn('unmatched'),
    reported: nIn('reported'),
    total: rows.length,
  };

  const provisional = usedPartial || doc.partial;
  const plan = parseOrThrow(
    Plan,
    {
      schema_version: PLAN_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      bgm_user: username,
      dedup_performed: dedupPerformed,
      provisional,
      pending_reviews: pendingReviews,
      counts,
      rows,
    },
    'plan',
  );

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'plan.json'), JSON.stringify(plan, null, 2));

  // --- review page -------------------------------------------------------
  const template = await readFile(path.join(SKILL_DIR, 'assets', 'template.html'), 'utf8');
  const html = template.replace('/*__DATA__*/', () => JSON.stringify(plan));
  await mkdir(OUT_DIR, { recursive: true });
  // A provisional page gets a different filename so it cannot be mistaken for
  // the real sign-off surface, and so it never overwrites a good one.
  const pageName = provisional ? 'review-page.PROVISIONAL.html' : 'review-page.html';
  await writeFile(path.join(OUT_DIR, pageName), html);

  // Rows Phase 2 would write without further input from the user.
  const willWrite = rows.filter((r) => r.state === 'matched' || r.state === 'ai_matched');
  const epRows = rows.filter((r) => r.bgm_type === 3 && r.progress_ep != null && r.state !== 'reported');
  console.log(
    `\nStates: ${counts.matched} matched / ${counts.ai_matched} ai_matched / ` +
      `${counts.unmatched} unmatched / ${counts.reported} reported  (${counts.total} rows)\n` +
      `Search: ${searched} keywords, ${cachedHits} served from cache\n` +
      (droppedSuggestions ? `Dropped suggestions (subject not among candidates): ${droppedSuggestions}\n` : '') +
      `Ratings to migrate: ${willWrite.filter((r) => r.curved_rate != null).length}\n` +
      `Comments to migrate: ${willWrite.filter((r) => r.my_review).length}\n` +
      `Episode-progress rows available to opt into: ${epRows.length}\n` +
      `\nWrote data/plan.json and out/${pageName}\n` +
      (provisional
        ? `PROVISIONAL — ${pendingReviews} items still lack rating/short-review data.\n` +
          `Do not sign off on this page. Finish Phase 1, then rerun without --allow-partial\n` +
          `(the search cache is now warm, so that run makes zero new bgm requests).`
        : `Next: open out/review-page.html, make your choices, save data/decisions.json`),
  );
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
});
