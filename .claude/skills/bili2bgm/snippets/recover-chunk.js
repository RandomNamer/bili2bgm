// Recover the last chunk from the in-page running cache.
// No placeholders — paste as-is.
//
// Use this when a fetch snippet's tool call did not come back cleanly: it timed
// out, the tab reloaded, the response was truncated. The requests themselves
// already happened and bilibili already counted them, so re-running the fetch
// would pay the rate-limit cost twice for data we may still have.
//
// The buffer holds only the most recent chunk — each fetch snippet overwrites
// it on start — so recover BEFORE launching the next chunk. It also lives in
// localStorage, which is per-origin: run this in the same bilibili tab the
// fetch ran in, or there will be nothing to find.
//
// Returns {found, kind, complete, payload}. When `found` is true, `payload` has
// the same shape the fetch snippet would have returned, so it can be piped
// straight into `phase1-merge.js merge lists` or `merge reviews`. `complete:
// false` means the loop was cut short — merge what is there, then ask `status`
// what is still missing rather than assuming the chunk finished.
(() => {
  const STORE_KEY = 'bili2bgm:chunk';
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { found: false, detail: 'No buffered chunk in this origin.' };
    const store = JSON.parse(raw);
    const payload =
      store.kind === 'lists'
        ? { blocked: false, pages: store.pages || [], detail: 'recovered from in-page cache' }
        : { blocked: false, results: store.results || [], detail: 'recovered from in-page cache' };
    const captured = store.kind === 'lists' ? (store.pages || []).length : (store.results || []).length;
    return {
      found: true,
      kind: store.kind,
      complete: store.complete === true,
      started_at: store.started_at,
      captured,
      expected: store.expected ?? null,
      payload,
    };
  } catch (e) {
    return { found: false, detail: String(e && e.message ? e.message : e) };
  }
})();
