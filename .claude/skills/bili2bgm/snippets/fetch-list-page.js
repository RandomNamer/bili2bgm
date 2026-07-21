// Fetch a contiguous range of follow-list pages for one bucket.
//
// Placeholders to substitute before running:
//   __VMID__       uid from preflight (plain number)
//   __TYPE__       1 = anime (追番), 2 = cinema (追剧)
//   __STATUS__     1 = wish, 2 = doing, 3 = done
//   __PN_START__   first page (1-based)
//   __PN_END__     last page, inclusive. Use the same value as __PN_START__ for
//                  the first call of a bucket — you do not know the page count
//                  until the response tells you `total`.
//   __LABEL__      quoted filename stem, e.g. "anime-done-p2-4"
//
// The loop sleeps between pages rather than between tool calls, so the pacing
// holds no matter how fast or slow the agent turn-around is. Bilibili's soft
// limit is the thing standing between the user and a -412, and evenly spaced
// requests are themselves a bot signature — hence the jitter (spec.md §2).
//
// The chunk is delivered to ~/Downloads as a file and only a short receipt is
// returned; see deliver.md for why. Move the file into cache/phase1/ and merge
// it with `phase1-merge.js merge lists < <file>`.
//
// NOTE: the javascript_tool evaluates with REPL semantics — the value of the
// last expression is what comes back. The `await` in front of the IIFE is load
// bearing: without it the tool returns the unresolved Promise, which serializes
// as an empty object and looks like a silent failure. Keep it.
await (async () => {
  const VMID = __VMID__;
  const TYPE = __TYPE__;
  const STATUS = __STATUS__;
  const PN_START = __PN_START__;
  const PN_END = __PN_END__;
  const LABEL = __LABEL__;
  const PAGE_SIZE = 30;
  const BASE_MS = 1500;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => Math.round(BASE_MS + Math.random() * 0.6 * BASE_MS);

  // Running cache: if this tool call dies mid-flight the requests still
  // happened and bilibili still counted them, so recover-chunk.js can read the
  // buffer back instead of re-fetching into the rate limiter.
  const STORE_KEY = 'bili2bgm:chunk';
  const store = { kind: 'lists', started_at: new Date().toISOString(), bili_type: TYPE, follow_status: STATUS, pages: [] };
  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      // Never let a storage failure take down an otherwise healthy run.
    }
  };
  persist();

  // Save the chunk to disk. CSP forbids posting it anywhere, but a page may
  // always download a Blob it built itself.
  const deliver = (payload) => {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bili2bgm-lists-${LABEL}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return a.download;
    } catch (e) {
      return null;
    }
  };

  const pages = store.pages;
  const receipt = (blocked, detail) => {
    const file = deliver({ blocked, pages, detail });
    return {
      blocked,
      detail,
      delivered_as: file,
      pages: pages.map((p) => ({ pn: p.pn, total: p.total, got: p.list.length })),
    };
  };

  for (let pn = PN_START; pn <= PN_END; pn++) {
    if (pn > PN_START) await sleep(jitter());

    const url =
      'https://api.bilibili.com/x/space/bangumi/follow/list' +
      `?type=${TYPE}&follow_status=${STATUS}&pn=${pn}&ps=${PAGE_SIZE}&vmid=${VMID}`;

    let text;
    let status = 0;
    try {
      const r = await fetch(url, { credentials: 'include' });
      status = r.status;
      text = await r.text();
    } catch (e) {
      return receipt(true, `network error on pn=${pn}: ${e && e.message}`);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON means the wall, not a parsing accident. Keep what we have.
      return receipt(true, `non-JSON body on pn=${pn} (HTTP ${status}): ${text.slice(0, 200)}`);
    }
    if (body.code === -412) return receipt(true, `code -412 on pn=${pn}`);
    if (body.code !== 0) return receipt(false, `code ${body.code} on pn=${pn}: ${body.message}`);

    const data = body.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    pages.push({
      bili_type: TYPE,
      follow_status: STATUS,
      pn,
      total: Number(data.total) || 0,
      list,
    });
    persist();

    // A short page is the API saying there is nothing after it; asking for the
    // next one anyway is a wasted request against a rate limiter.
    if (list.length < PAGE_SIZE) break;
  }

  store.complete = true;
  persist();
  return receipt(false, null);
})();
