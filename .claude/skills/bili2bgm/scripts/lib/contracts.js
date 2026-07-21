// The JSON contracts between phases (spec.md §6, "four JSON contracts").
//
// Every artifact carries a schema_version and is validated on write and on read:
// these bytes come from a network response or from a file a human edited, so
// they are untrusted either way. The validators are hand-rolled rather than
// pulled from a library because this skill is published and run by strangers —
// an install step would outlive its usefulness (spec.md §6a.8). What matters is
// not the mechanism but the property: nothing crosses a phase boundary
// unchecked, and a failure names the exact path that is wrong.

export const BILI_EXPORT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- primitives
//
// A validator is (value, path) => string[] of problems. Composing them keeps
// the error messages positional ("items[3].season_id: expected number") which
// is what makes a contract failure diagnosable at 2am.

const problem = (path, msg) => [`${path || '(root)'}: ${msg}`];

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export const str = () => (v, p) => (typeof v === 'string' ? [] : problem(p, `expected string, got ${typeOf(v)}`));

export const num = () => (v, p) =>
  typeof v === 'number' && Number.isFinite(v) ? [] : problem(p, `expected finite number, got ${typeOf(v)}`);

export const bool = () => (v, p) => (typeof v === 'boolean' ? [] : problem(p, `expected boolean, got ${typeOf(v)}`));

export const any = () => () => [];

export const literal = (expected) => (v, p) =>
  v === expected ? [] : problem(p, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(v)}`);

/** Accepts null in addition to whatever the inner validator accepts. */
export const nullable = (inner) => (v, p) => (v === null ? [] : inner(v, p));

/** Accepts undefined/missing in addition to the inner validator. */
export const optional = (inner) => (v, p) => (v === undefined ? [] : inner(v, p));

export const arrayOf = (inner) => (v, p) => {
  if (!Array.isArray(v)) return problem(p, `expected array, got ${typeOf(v)}`);
  return v.flatMap((el, i) => inner(el, `${p}[${i}]`));
};

/**
 * Object with a fixed shape. Unknown keys are allowed on purpose: bilibili adds
 * fields to its responses without warning, and we keep `raw` verbatim anyway.
 */
export const object = (shape) => (v, p) => {
  if (typeOf(v) !== 'object') return problem(p, `expected object, got ${typeOf(v)}`);
  return Object.entries(shape).flatMap(([key, inner]) => {
    const childPath = p ? `${p}.${key}` : key;
    if (!(key in v)) {
      // optional() is the only validator that tolerates undefined; let it decide.
      return inner(undefined, childPath).length ? problem(childPath, 'required, but missing') : [];
    }
    return inner(v[key], childPath);
  });
};

/** Object used as a dictionary: every value must satisfy `inner`. */
export const recordOf = (inner) => (v, p) => {
  if (typeOf(v) !== 'object') return problem(p, `expected object, got ${typeOf(v)}`);
  return Object.entries(v).flatMap(([k, val]) => inner(val, p ? `${p}.${k}` : k));
};

/**
 * Validate or throw, with the first handful of problems in the message.
 * Returns the value so it can be used inline: `const doc = parseOrThrow(...)`.
 */
export function parseOrThrow(validator, value, what) {
  const problems = validator(value, '');
  if (problems.length === 0) return value;
  const shown = problems.slice(0, 10).map((s) => `  ${s}`).join('\n');
  const more = problems.length > 10 ? `\n  … and ${problems.length - 10} more` : '';
  throw new Error(`${what} failed contract validation:\n${shown}${more}`);
}

// ---------------------------------------------------------------- bili-export

/** One follow-list entry (spec.md §2, "Per-item record") */
export const BiliItem = object({
  id: str(), // "s_" + season_id
  title: str(),
  season_title: nullable(str()),
  season_id: num(),
  media_id: nullable(num()),
  bili_type: num(), // 1 = anime, 2 = cinema
  follow_status: num(), // 1 = wish, 2 = doing, 3 = done
  season_type_name: nullable(str()),
  formal_ep_count: nullable(num()),
  progress_raw: nullable(str()),
  progress_ep: nullable(num()),
  air_date: nullable(str()),
  areas: arrayOf(str()),
  series: nullable(object({ title: nullable(str()), season_count: nullable(num()) })),
  styles: arrayOf(str()),
  url: nullable(str()),
  my_score: nullable(num()),
  my_review: nullable(str()),
  my_review_time: nullable(num()),
  review_fetched: bool(), // false = the per-item review call has not run yet (resume marker)
  raw: any(),
});

/** Review-pass pacing. The spec's 1.0s base tripped bilibili's -412 after 20
 *  consecutive calls on a live run (2026-07-21), so the review endpoint is
 *  treated as more sensitive than the list endpoint. Kept here as a documented
 *  observation for whoever tunes it next. */
export const REVIEW_BASE_MS_OBSERVED_SAFE = 2500;

/** One bucket (anime|cinema × wish|doing|done) with its self-check counters */
export const BiliBucket = object({
  bili_type: num(),
  follow_status: num(),
  label: str(),
  reported_total: num(), // the bucket's own API-reported total, never a constant
  collected: num(),
  pages_fetched: arrayOf(num()), // which `pn` values have been merged — drives resume
  complete: bool(),
});

export const BiliExport = object({
  schema_version: literal(BILI_EXPORT_SCHEMA_VERSION),
  generated_at: str(),
  partial: bool(),
  buckets: arrayOf(BiliBucket),
  items: arrayOf(BiliItem),
});

// ---------------------------------------------------------------- plan

export const PLAN_SCHEMA_VERSION = 1;

/** A bgm subject as far as we care about it. */
export const PlanSubject = object({
  id: num(),
  name: str(),
  name_cn: str(),
  date: nullable(str()),
  image: nullable(str()),
  score: optional(num()), // match confidence, not bgm's rating
  // Context for the review page's per-row detail panel. Optional because the
  // fields come from bgm's search payload and are not guaranteed present.
  eps: optional(nullable(num())),
  total_episodes: optional(nullable(num())),
  platform: optional(nullable(str())),
  summary: optional(nullable(str())),
});

export const PlanRow = object({
  id: str(), // same id as the bili item
  title: str(),
  season_title: nullable(str()),
  url: nullable(str()),
  bili_type: num(),
  follow_status: num(),
  bgm_type: num(), // 1 wish / 2 done / 3 doing — already mapped for Phase 2
  air_date: nullable(str()),
  formal_ep_count: nullable(num()),
  progress_raw: nullable(str()),
  progress_ep: nullable(num()),
  my_score: nullable(num()),
  curved_rate: nullable(num()), // clamp(my_score - 2, 1, 10), null when never rated
  my_review: nullable(str()),
  // Exactly one of these per row, and it is the field Phase 2 dispatches on:
  //   reported   — already in the user's bgm collection; never written to
  //   matched    — deterministic title/date match
  //   ai_matched — second-pass judgement, high confidence only
  //   unmatched  — no confident match; the human decides on the review page
  state: str(),
  subject_id: nullable(num()),
  subject: nullable(PlanSubject),
  candidates: arrayOf(PlanSubject),
  existing: nullable(object({ type: nullable(num()), rate: nullable(num()) })),
  reason: str(), // why this row landed in its state — shown on the review page
  // Optional second-pass judgement on an unmatched row (--verdicts). Advisory
  // only below high confidence; a high-confidence verdict becomes state ai_matched.
  suggestion: optional(
    nullable(
      object({
        subject_id: num(),
        verdict: str(), // 'match' | 'unsure'
        confidence: str(), // 'high' | 'medium' | 'low'
        reason: str(),
      }),
    ),
  ),
});

export const Plan = object({
  schema_version: literal(PLAN_SCHEMA_VERSION),
  generated_at: str(),
  bgm_user: nullable(str()),
  dedup_performed: bool(),
  provisional: bool(), // true = built from an incomplete export; not a sign-off surface
  pending_reviews: num(),
  counts: object({
    matched: num(),
    ai_matched: num(),
    unmatched: num(),
    reported: num(),
    total: num(),
  }),
  rows: arrayOf(PlanRow),
});

// ---------------------------------------------------------------- decisions

export const DECISIONS_SCHEMA_VERSION = 5;

export const Decisions = object({
  schema_version: num(), // validated separately: v3 must be read as "no ep patches"
  exclude: arrayOf(str()),
  resolve: recordOf(num()),
  // The effective rating for every row whose value differs from the plan's
  // curved_rate — including rows changed only by moving the curve. Phase 2
  // reads `rate_override[id] ?? curved_rate` and needs no curve logic at all.
  rate_override: recordOf(num()),
  exclude_comment: arrayOf(str()),
  include_ep: optional(arrayOf(str())),
  // Hand-edited episode numbers, for when bilibili's progress string parsed to
  // the wrong value but the row is still worth sending.
  ep_override: optional(recordOf(num())),
  // The 5-star → bgm score mapping in force when the page was signed off.
  // Recorded for provenance only; the values it produced are already baked
  // into rate_override, so Phase 2 never has to reapply it.
  curve: optional(recordOf(num())),
  global: object({ comments: bool(), ratings: bool(), tags: bool(), private: bool() }),
});
