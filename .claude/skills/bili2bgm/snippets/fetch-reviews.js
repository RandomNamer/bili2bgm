// Fetch personal score + short review for a batch of media_ids.
//
// Placeholders to substitute before running:
//   __MEDIA_IDS__   JSON array of numbers, e.g. [8001, 8002, 8003]
//                   Take it from `phase1-merge.js status` — it prints the next
//                   batch ready to paste.
//   __LABEL__       quoted filename stem, e.g. "b01"
//
// Pacing: BASE_MS is 2500, not the 1000 the spec originally specified. A live
// run on 2026-07-21 took a -412 after 20 consecutive review calls at 1.0 s,
// while list calls at 1.5 s were fine — this endpoint is the sensitive one.
//
// Batch size: keep it at ~12. The javascript_tool's CDP evaluate call gives up
// at 45 s, and 12 requests at ~3.2 s average lands near 38 s. Bigger batches
// are not faster overall; they just risk a timeout that throws away work
// bilibili has already counted against the rate limit.
//
// Per-item API errors (delisted season, region lock) are collected and reported
// but do NOT stop the batch — they are terminal facts about that item, and the
// status still migrates without a rating. A -412 is different in kind: it is
// about us, not the item, so it stops everything immediately and keeps what was
// captured (spec.md §2).
//
// The batch is delivered to ~/Downloads as a file; only a short receipt comes
// back. See deliver.md. Move the file into cache/phase1/ and merge it with
// `phase1-merge.js merge reviews < <file>`.
//
// NOTE: the `await` in front of the IIFE is load bearing — without it the tool
// returns an unresolved Promise that serializes as `{}` and looks like silence.
await (async () => {
  const MEDIA_IDS = __MEDIA_IDS__;
  const LABEL = __LABEL__;
  const BASE_MS = 2500;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => Math.round(BASE_MS + Math.random() * 0.6 * BASE_MS);

  const STORE_KEY = 'bili2bgm:chunk';
  const store = { kind: 'reviews', started_at: new Date().toISOString(), expected: MEDIA_IDS.length, results: [] };
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      // A full or disabled localStorage must not abort an otherwise fine run.
    }
  };
  persist();

  const deliver = (payload) => {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bili2bgm-reviews-${LABEL}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return a.download;
    } catch (e) {
      return null;
    }
  };

  const results = store.results;
  const receipt = (blocked, detail) => {
    const file = deliver({ blocked, results, detail });
    return {
      blocked,
      detail,
      delivered_as: file,
      got: results.length,
      rated: results.filter((r) => r.review && r.review.score > 0).length,
      commented: results.filter((r) => r.review && r.review.short_review).length,
      errors: results.filter((r) => r.error).length,
    };
  };

  for (let i = 0; i < MEDIA_IDS.length; i++) {
    if (i > 0) await sleep(jitter());
    const mediaId = MEDIA_IDS[i];
    const url = `https://api.bilibili.com/pgc/review/user?media_id=${mediaId}`;

    let text;
    let status = 0;
    try {
      const r = await fetch(url, { credentials: 'include' });
      status = r.status;
      text = await r.text();
    } catch (e) {
      return receipt(true, `network error on media_id=${mediaId}: ${e && e.message}`);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return receipt(true, `non-JSON body on media_id=${mediaId} (HTTP ${status}): ${text.slice(0, 200)}`);
    }
    if (body.code === -412) return receipt(true, `code -412 on media_id=${mediaId}`);

    if (body.code !== 0) {
      results.push({ media_id: mediaId, error: { code: body.code, message: body.message } });
      persist();
      continue;
    }

    const review = (body.result && body.result.review) || {};
    const short = review.short_review || null;
    results.push({
      media_id: mediaId,
      review: {
        score: review.score ?? null,
        short_review: short
          ? { content: short.content ?? null, ctime: short.ctime ?? null, mtime: short.mtime ?? null }
          : null,
      },
    });
    persist();
  }

  store.complete = true;
  persist();
  return receipt(false, null);
})();
