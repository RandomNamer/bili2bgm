// Parsing bilibili's free-text watch progress (spec.md §2, "Progress parsing").
// The strings are authored for humans, not for us: only the three shapes
// observed live are accepted, everything else deliberately yields null. A wrong
// episode number silently rewrites watch history, so guessing is worse than
// giving up — the review page shows raw vs. parsed and the user opts in per row.

const FULL_WIDTH_DIGITS = /[０-９]/g;

function normalizeDigits(s) {
  return s.replace(FULL_WIDTH_DIGITS, (d) => String(d.charCodeAt(0) - 0xff10));
}

/**
 * @param {string|null|undefined} raw   e.g. "已看完第12话", "看到第7话 05:12"
 * @param {number|null} formalEpCount   formal episode count, used for the movie case
 * @returns {number|null} 1-based episode index, or null when unparseable
 */
export function parseProgress(raw, formalEpCount) {
  if (typeof raw !== 'string') return null;
  const s = normalizeDigits(raw.trim());
  if (!s || s === '尚未观看') return null;

  // "已看完第N话/集/期" and "看到第N话/集/期[ mm:ss]"
  const ep = s.match(/^(?:已看完|看到)第\s*(\d+)\s*[话話集期]/);
  if (ep) {
    // "看到第10集预告" is a trailer, not the episode itself — not progress.
    if (/预告/.test(s)) return null;
    const n = Number(ep[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Movies: a bare timestamp with a single formal episode means "watched it".
  if (formalEpCount === 1 && /^看到\s*\d{1,2}:\d{2}(?::\d{2})?$/.test(s)) {
    return 1;
  }

  // Everything else: "看到丰川祥子 0:23", "看到SP…", "已看完元祖迷你22", ""
  return null;
}
