#!/usr/bin/env node
// Phase 2 — apply the signed-off plan to bgm.tv (spec.md §5).
//
// This is the only script in the skill that writes to anything but the local
// disk, so it is built to be inspectable before it is trusted:
//
//   phase2-apply.js plan            → out/planned-calls.html, zero network
//   phase2-apply.js apply           → executes, appends out/state.jsonl
//   phase2-apply.js apply --limit N → executes only the first N rows
//   phase2-apply.js verify          → reads back what was written
//
// `plan` reconstructs every request that `apply` would send — method, path and
// exact JSON body — into a plain table. Reviewing that table is cheaper than
// reviewing this file, and it is the last chance to catch a systematic mistake
// (a wrong status mapping, a rating curve that misfired) while it still costs
// nothing. `apply` sends precisely what `plan` showed; there is no second code
// path deciding what to send.
//
// API contract (bangumi/api open-api/v0.yaml, read 2026-07-21):
//   POST  /v0/users/-/collections/{subject_id}
//         body: {type, rate, comment, private, tags}   — all optional
//         type: 1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃
//         rate: 0..10, where 0 means "delete the rating"
//         tags: strings without spaces; [] clears, null/absent is ignored
//   PATCH /v0/users/-/collections/{subject_id}/episodes
//         body: {episode_id: [int], type}  type 2 = 看过
//
// The spec is explicit that `ep_status` on the collection endpoint is books
// only ("只能用于修改书籍条目进度"), so episode progress goes through the
// episodes endpoint, which needs real episode ids — hence the extra GET.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bgmRequest } from './lib/bgm.js';
import { Plan, Decisions, parseOrThrow } from './lib/contracts.js';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.cwd(), 'data');
const OUT_DIR = path.resolve(process.cwd(), 'out');

const args = process.argv.slice(2);
const cmd = args[0] || 'plan';
const has = (n) => args.includes(n);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };

const TAG = 'bilibili-import';
const STATUS_CN = { 1: '想看', 2: '看过', 3: '在看' };

/**
 * Turn the plan plus the user's decisions into the exact list of calls.
 *
 * Everything the user chose is resolved here and nowhere else, so `plan` and
 * `apply` cannot drift: both call this function and neither reinterprets it.
 */
function buildCalls(plan, decisions) {
  const excluded = new Set(decisions.exclude || []);
  const noComment = new Set(decisions.exclude_comment || []);
  const includeEp = new Set(decisions.include_ep || []);
  const rateOverride = decisions.rate_override || {};
  const epOverride = decisions.ep_override || {};
  const resolve = decisions.resolve || {};
  const g = decisions.global || {};

  const calls = [];
  for (const row of plan.rows) {
    // A row is in scope if the matcher settled it and the user kept it, or if
    // the user resolved it by hand. `reported` rows are never touched — the
    // whole point of dedup is that an existing collection is left alone.
    const resolved = resolve[row.id];
    const inScope =
      (row.state === 'matched' || row.state === 'ai_matched') && !excluded.has(row.id);
    if (!inScope && resolved == null) continue;

    const subjectId = resolved != null ? resolved : row.subject_id;
    if (!subjectId) continue;

    const body = { type: row.bgm_type };

    if (g.ratings !== false) {
      const rate = rateOverride[row.id] != null ? rateOverride[row.id] : row.curved_rate;
      // 0 deletes a rating on bgm, so an unrated row must omit the field
      // entirely rather than send a falsy value.
      if (rate != null && rate > 0) body.rate = rate;
    }
    if (g.comments !== false && row.my_review && !noComment.has(row.id)) {
      body.comment = row.my_review;
    }
    if (g.tags !== false) body.tags = [TAG];
    if (g.private === true) body.private = true;

    calls.push({
      kind: 'collection',
      row_id: row.id,
      title: row.title,
      subject_id: subjectId,
      state: row.state,
      manual: resolved != null,
      method: 'POST',
      path: `/v0/users/-/collections/${subjectId}`,
      body,
    });

    // Episode progress is opt-in per row and only meaningful while 在看.
    if (includeEp.has(row.id) && row.bgm_type === 3) {
      const upTo = epOverride[row.id] != null ? epOverride[row.id] : row.progress_ep;
      if (upTo != null && upTo > 0) {
        calls.push({
          kind: 'episodes',
          row_id: row.id,
          title: row.title,
          subject_id: subjectId,
          method: 'PATCH',
          path: `/v0/users/-/collections/${subjectId}/episodes`,
          // episode_id is filled in at apply time: the ids are not knowable
          // offline, so `plan` shows the intent and the count it will mark.
          body: { episode_id: `<first ${upTo} main episodes>`, type: 2 },
          up_to: upTo,
          progress_raw: row.progress_raw,
        });
      }
    }
  }
  return calls;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain HTML. One row per request, with the literal body that will be sent. */
function renderTable(calls, plan) {
  const rows = calls
    .map((c, i) => {
      const b = esc(JSON.stringify(c.body));
      const notes = [
        c.manual ? '手动匹配' : '',
        c.state === 'ai_matched' ? 'AI 匹配' : '',
        c.kind === 'episodes' ? `看到第 ${c.up_to} 集（原文：${c.progress_raw || '无'}）` : '',
      ].filter(Boolean).join('；');
      return `<tr>
  <td>${i + 1}</td>
  <td>${esc(c.method)}</td>
  <td>${esc(c.path)}</td>
  <td>${esc(c.title)}</td>
  <td>${c.kind === 'collection' ? esc(STATUS_CN[c.body.type] || c.body.type) : '—'}</td>
  <td>${c.kind === 'collection' ? (c.body.rate != null ? c.body.rate : '') : ''}</td>
  <td>${c.kind === 'collection' ? (c.body.comment ? esc(c.body.comment.slice(0, 60)) : '') : ''}</td>
  <td><code>${b}</code></td>
  <td>${esc(notes)}</td>
</tr>`;
    })
    .join('\n');

  const collections = calls.filter((c) => c.kind === 'collection');
  const rated = collections.filter((c) => c.body.rate != null).length;
  const commented = collections.filter((c) => c.body.comment).length;
  const eps = calls.filter((c) => c.kind === 'episodes').length;

  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>bili2bgm — 将要发送的请求</title></head>
<body>
<h1>将要发送的请求</h1>
<p>共 <b>${calls.length}</b> 个请求：${collections.length} 个收藏写入（其中 ${rated} 个带评分、${commented} 个带短评），${eps} 个分集进度。</p>
<p>这一步<b>没有联网</b>。下面就是 <code>apply</code> 会原样发出的内容。</p>
<p>计划来源：${esc(plan.generated_at)}${plan.bgm_user ? '，账号 ' + esc(plan.bgm_user) : ''}。</p>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr>
<th>#</th><th>方法</th><th>路径</th><th>B 站标题</th><th>状态</th><th>评分</th><th>短评</th><th>请求体</th><th>备注</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

async function loadInputs() {
  const plan = parseOrThrow(
    Plan,
    JSON.parse(await readFile(path.join(DATA_DIR, 'plan.json'), 'utf8')),
    'data/plan.json',
  );
  let decisions;
  try {
    decisions = parseOrThrow(
      Decisions,
      JSON.parse(await readFile(path.join(DATA_DIR, 'decisions.json'), 'utf8')),
      'data/decisions.json',
    );
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        'data/decisions.json not found.\n' +
          'Open out/review-page.html, make your choices, download decisions.json\n' +
          'and move it to data/decisions.json. That file is the sign-off.',
      );
    }
    throw e;
  }
  if (plan.provisional) {
    throw new Error('plan.json is marked provisional — finish Phase 1 and rebuild the plan before applying.');
  }
  // A plan built without a bgm username or token has no `reported` rows,
  // because dedup never ran — and every collection the user already has then
  // looks like something to write. The planner only warns about this, and the
  // resulting plan is indistinguishable from a real one apart from this flag,
  // so refuse it here rather than quietly overwrite an existing collection.
  if (!plan.dedup_performed && !has('--no-dedup-ok')) {
    throw new Error(
      'plan.json was built without dedup, so it cannot tell which subjects you already collect.\n' +
        'Applying it would overwrite existing collections. Rebuild with BGM_TOKEN (or --bgm-user) set:\n' +
        '  BGM_TOKEN=… node <skill>/scripts/phase15-plan.js\n' +
        'If you genuinely want to write over existing collections, pass --no-dedup-ok.',
    );
  }
  return { plan, decisions };
}

async function main() {
  if (cmd === 'plan') {
    const { plan, decisions } = await loadInputs();
    const calls = buildCalls(plan, decisions);
    await mkdir(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, 'planned-calls.html');
    await writeFile(file, renderTable(calls, plan));

    const collections = calls.filter((c) => c.kind === 'collection');
    const byStatus = {};
    for (const c of collections) byStatus[STATUS_CN[c.body.type] || c.body.type] = (byStatus[STATUS_CN[c.body.type] || c.body.type] || 0) + 1;
    console.log(
      `Planned ${calls.length} request(s), zero sent.\n` +
        `  ${collections.length} collection writes: ` +
        Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') + '\n' +
        `  ${collections.filter((c) => c.body.rate != null).length} with a rating, ` +
        `${collections.filter((c) => c.body.comment).length} with a comment\n` +
        `  ${calls.filter((c) => c.kind === 'episodes').length} episode-progress patches\n` +
        `\nWrote out/planned-calls.html — read it before running \`apply\`.`,
    );
    return;
  }

  if (cmd === 'apply') {
    if (!process.env.BGM_TOKEN) throw new Error('BGM_TOKEN is not set. Phase 2 refuses to run without it.');
    const { plan, decisions } = await loadInputs();
    let calls = buildCalls(plan, decisions);
    const limit = Number(flag('--limit'));
    if (Number.isFinite(limit) && limit > 0) calls = calls.slice(0, limit);

    await mkdir(OUT_DIR, { recursive: true });
    const statePath = path.join(OUT_DIR, 'state.jsonl');

    // Resume: every completed call is already on disk, so a re-run skips it.
    // Append-only, one JSON object per line, so a crash mid-write costs at
    // most the line being written.
    const done = new Set();
    try {
      const prior = await readFile(statePath, 'utf8');
      for (const line of prior.split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        if (rec.ok) done.add(`${rec.kind}:${rec.row_id}`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    let sent = 0, skipped = 0, failed = 0;
    for (const c of calls) {
      const key = `${c.kind}:${c.row_id}`;
      if (done.has(key)) { skipped += 1; continue; }

      let body = c.body;
      if (c.kind === 'episodes') {
        // Resolve real episode ids now. Main story only (type 0); anything
        // else would mark specials and OPs as watched.
        const eps = await bgmRequest(`/v0/episodes?subject_id=${c.subject_id}&type=0&limit=100`, {
          token: process.env.BGM_TOKEN,
        });
        const ids = (eps.data || []).slice(0, c.up_to).map((e) => e.id);
        if (!ids.length) {
          await appendFile(statePath, JSON.stringify({ ...meta(c), ok: false, error: 'no episodes returned' }) + '\n');
          failed += 1;
          continue;
        }
        body = { episode_id: ids, type: 2 };
      }

      try {
        await bgmRequest(c.path, { method: c.method, body, token: process.env.BGM_TOKEN });
        await appendFile(statePath, JSON.stringify({ ...meta(c), ok: true, body }) + '\n');
        sent += 1;
      } catch (e) {
        if (e.fatal) {
          await appendFile(statePath, JSON.stringify({ ...meta(c), ok: false, error: e.message }) + '\n');
          console.error(`\nAborted on a fatal error: ${e.message}`);
          console.error(`Sent ${sent}, skipped ${skipped}, failed ${failed + 1}. Rerun to resume.`);
          process.exit(1);
        }
        await appendFile(statePath, JSON.stringify({ ...meta(c), ok: false, error: e.message }) + '\n');
        failed += 1;
        console.error(`  ${c.title}: ${e.message}`);
      }
      if ((sent + failed) % 25 === 0) console.log(`  ${sent + failed}/${calls.length} …`);
    }
    console.log(`\nSent ${sent}, skipped ${skipped} (already done), failed ${failed}.`);
    console.log('out/state.jsonl holds one line per call. Rerun to retry failures.');

    // Fold the result back into the plan straight away. Leaving this to a
    // separate command people have to remember is how a plan drifts out of
    // step with the account it describes.
    const rotated = await rotate();
    if (rotated) {
      console.log(
        `Rotated ${rotated} row(s) to reported and rebuilt out/review-page.html.\n` +
          'Reopen that page to work on what is still left; the written rows are now read-only.',
      );
    }
    return;
  }

  if (cmd === 'verify') {
    // A 204 says the server accepted the request, not that the collection now
    // looks the way we meant. Read a sample back and compare field by field —
    // this is what catches a mapping that was wrong in a way the API was happy
    // to store (a status off by one, a rating that silently didn't apply).
    if (!process.env.BGM_TOKEN) throw new Error('BGM_TOKEN is not set.');
    const token = process.env.BGM_TOKEN;
    const username = await (await import('./lib/bgm.js')).whoami(token);
    if (!username) throw new Error('could not resolve the username from BGM_TOKEN.');

    const lines = await readFile(path.join(OUT_DIR, 'state.jsonl'), 'utf8');
    const written = [];
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.ok && rec.kind === 'collection') written.push(rec);
    }
    const n = Number(flag('--sample')) || 10;
    // Spread the sample across the run rather than taking the first n: a
    // failure mode that only appears late is exactly what this should catch.
    const step = Math.max(1, Math.floor(written.length / n));
    const sample = written.filter((_, i) => i % step === 0).slice(0, n);

    let bad = 0;
    for (const rec of sample) {
      // `-` is only valid for writes; reads need the real username.
      const got = await bgmRequest(`/v0/users/${encodeURIComponent(username)}/collections/${rec.subject_id}`, { token });
      const want = rec.body;
      const problems = [];
      if (got.type !== want.type) problems.push(`type ${got.type} ≠ ${want.type}`);
      if (want.rate != null && got.rate !== want.rate) problems.push(`rate ${got.rate} ≠ ${want.rate}`);
      if (want.comment && got.comment !== want.comment) problems.push('comment differs');
      if (want.tags && !want.tags.every((t) => (got.tags || []).includes(t))) problems.push('tag missing');
      if (problems.length) { bad += 1; console.log(`  MISMATCH ${rec.title} (${rec.subject_id}): ${problems.join(', ')}`); }
      else console.log(`  ok  ${rec.title} (${rec.subject_id}) type=${got.type} rate=${got.rate}`);
    }
    console.log(`\nChecked ${sample.length} of ${written.length} written rows — ${bad} mismatch(es).`);
    if (bad) process.exit(1);
    return;
  }

  if (cmd === 'rotate') {
    const n = await rotate();
    console.log(n ? `Rotated ${n} row(s) to reported.` : 'Nothing to rotate.');
    return;
  }

  throw new Error(`unknown command: ${cmd}\nUsage: phase2-apply.js plan | apply [--limit N] | verify [--sample N] | rotate`);
}

/**
 * Fold what was actually written back into the plan.
 *
 * Without this the plan keeps describing a world that no longer exists: a row
 * Phase 2 already wrote still reads `matched`, so the next review page offers
 * it again, ticked, and a second run rewrites it. Rotating written rows to
 * `reported` makes the pipeline re-entrant — the page can be reopened at any
 * time and it shows only what is genuinely left to do, while the rows already
 * on bgm move into the read-only section that is never touched again.
 *
 * `out/state.jsonl` is the source of truth here, not the plan and not the
 * decisions: it records what the server accepted, which is the only thing that
 * justifies calling a row done.
 */
async function rotate() {
  const planPath = path.join(DATA_DIR, 'plan.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));

  let lines = '';
  try {
    lines = await readFile(path.join(OUT_DIR, 'state.jsonl'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }

  const written = new Map();
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.ok && rec.kind === 'collection') written.set(rec.row_id, rec);
  }

  let rotated = 0;
  for (const row of plan.rows) {
    const rec = written.get(row.id);
    if (!rec || row.state === 'reported') continue;
    row.state = 'reported';
    row.subject_id = rec.subject_id;
    row.existing = {
      type: rec.body && rec.body.type != null ? rec.body.type : null,
      rate: rec.body && rec.body.rate != null ? rec.body.rate : null,
    };
    row.reason = `已由 Phase 2 写入（${rec.at}）`;
    rotated += 1;
  }
  if (!rotated) return 0;

  const nIn = (s) => plan.rows.filter((r) => r.state === s).length;
  plan.counts = {
    matched: nIn('matched'),
    ai_matched: nIn('ai_matched'),
    unmatched: nIn('unmatched'),
    reported: nIn('reported'),
    total: plan.rows.length,
  };
  plan.generated_at = new Date().toISOString();
  parseOrThrow(Plan, plan, 'rotated plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2));

  // Rebuild the page from the rotated plan so the user can act on what is left
  // without having to re-run Phase 1.5.
  const template = await readFile(path.join(SKILL_DIR, 'assets', 'template.html'), 'utf8');
  await writeFile(
    path.join(OUT_DIR, 'review-page.html'),
    template.replace('/*__DATA__*/', () => JSON.stringify(plan)),
  );
  return rotated;
}

const meta = (c) => ({
  at: new Date().toISOString(),
  kind: c.kind,
  row_id: c.row_id,
  subject_id: c.subject_id,
  title: c.title,
  method: c.method,
  path: c.path,
});

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
