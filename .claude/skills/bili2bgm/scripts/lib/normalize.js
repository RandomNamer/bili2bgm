// Title normalization for matching bilibili titles against bgm subjects
// (spec.md §3, "Normalization").
//
// The two catalogues name the same show differently in predictable ways:
// bilibili carries licensing suffixes bgm has no reason to know about
// (（僅限港澳台地區）, 中配版), and season numbering appears as 第N季, Season N,
// or N期 depending on who typed it. Normalizing both sides before comparison is
// what lets an exact-equality check mean something; without it almost nothing
// matches exactly and every row lands unmatched for a human to
// resolve by hand.
//
// This is deliberately conservative. Stripping too much creates false
// confidence — "第2季" collapsing into the base title would happily match
// season 1 and silently migrate the wrong subject.

/** Suffixes bilibili adds for licensing/dub variants; bgm titles never have them. */
const NOISE_PATTERNS = [
  /（僅限[^）]*）/g,
  /\(僅限[^)]*\)/g,
  /（仅限[^）]*）/g,
  /\(仅限[^)]*\)/g,
  /（[^）]*地區\）?/g,
  /（[^）]*地区\）?/g,
  /中配版/g,
  /国配版/g,
  /國配版/g,
  /粤语版/g,
  /粵語版/g,
  /日配版/g,
  /【[^】]*】/g,
  /（[^）]*独家[^）]*）/g,
];

/** Convert a season marker to a canonical `#N` token so all spellings agree. */
function canonicalizeSeason(s) {
  return s
    .replace(/第\s*([0-9]+)\s*[季期]/g, ' #$1 ')
    .replace(/\bseason\s*([0-9]+)\b/gi, ' #$1 ')
    .replace(/\bs([0-9]{1,2})\b/gi, ' #$1 ')
    .replace(/([0-9]+)(?:nd|rd|th|st)\s+season/gi, ' #$1 ');
}

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 第二季 → 第2季, so the numeric rule above catches it. */
function arabicizeSeason(s) {
  return s.replace(/第\s*([一二三四五六七八九十]+)\s*[季期]/g, (m, cn) => {
    if (cn.length === 1) return `第${CN_NUMERALS[cn] ?? cn}季`;
    // 十一 … 十九 and 二十 — enough range for any real season count.
    if (cn[0] === '十') return `第${10 + (CN_NUMERALS[cn[1]] ?? 0)}季`;
    if (cn[1] === '十') return `第${CN_NUMERALS[cn[0]] * 10 + (CN_NUMERALS[cn[2]] ?? 0)}季`;
    return m;
  });
}

/**
 * Normalize a title for comparison. Not for display — the result is lowercased
 * and stripped of punctuation, so keep the original around for the review page.
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  let s = title.normalize('NFKC');
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  s = arabicizeSeason(s);
  s = canonicalizeSeason(s);
  s = s.toLowerCase();
  // Drop punctuation and separators; keep CJK, latin, digits and the season marker.
  s = s.replace(/[·・:：\-–—_,，。.!！?？'"“”‘’()（）\[\]【】<>《》/\\|~〜*&+]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * The title to send to bgm's search, as opposed to the one used for comparison.
 *
 * These are different jobs and must not share a function. `normalizeTitle`
 * lowercases, strips punctuation and rewrites 第二季 into `#2` — fine for an
 * equality test, useless as a query. What a search needs is the human title
 * with only bilibili's licensing noise removed, because that noise is the part
 * bgm has never heard of: asking it for
 * "機動戰士鋼彈 水星的魔女（僅限港澳台地區）" spends most of the query on a
 * distributor's regional footnote and pushes the real subject out of the
 * results entirely. Season markers stay — they are real signal for the search.
 */
export function searchTitle(title) {
  if (typeof title !== 'string') return '';
  let s = title.normalize('NFKC');
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** The season number implied by a title, or null. Used to block cross-season matches. */
export function seasonNumber(title) {
  const n = normalizeTitle(title).match(/#(\d+)/);
  return n ? Number(n[1]) : null;
}

/** Title with its season marker removed — the "series" part. */
export function baseTitle(title) {
  return normalizeTitle(title).replace(/#\d+/g, '').replace(/\s+/g, ' ').trim();
}

/** "2024-04-05" / "2024-04" / "2024" → "2024-04", or null. Month precision is
 *  the most agreement we can expect between a broadcast date and a bgm air date. */
export function yearMonth(date) {
  if (typeof date !== 'string') return null;
  const m = date.match(/^(\d{4})[-/年]?(\d{1,2})?/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${String(Number(m[2])).padStart(2, '0')}` : m[1];
}

/** Cheap similarity in [0,1] for ranking candidates on unmatched rows. */
export function similarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  if (bx.size === 0 || by.size === 0) return x === y ? 1 : 0;
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) || 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}
