// bgm.tv API client (spec.md §3, §5).
//
// Bangumi is a small volunteer-run site. The politeness rules here are not
// ceremony: a descriptive User-Agent is site policy, ~1 req/s keeps us within
// what they ask of API consumers, and every search response is cached to disk
// so a rerun of Phase 1.5 costs them nothing. That last part is also why reruns
// are safe to do freely during development.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createThrottle, sleep } from './throttle.js';

const API = 'https://api.bgm.tv';
const CACHE_DIR = path.resolve(process.cwd(), 'cache', 'search');

// Identify the tool, not the person running it. Bangumi asks that a UA say
// what the software is; whose account it is acting for is already established
// by the token, and putting a real name here just leaks an identity into every
// request log for no benefit.
const DEFAULT_UA = 'bili2bgm/0.2 (one-shot bilibili to bangumi migration)';

/** Bangumi asks that the UA identify the app. Overridable, but keep it about the app. */
export function userAgent() {
  return process.env.BGM_UA || DEFAULT_UA;
}

// Bangumi's guidance is 1 request/second. The throttle sleeps
// base + U(0, 0.6·base), so the *mean* gap is 1.3× the base — a 1000 ms base
// is really 0.77 req/s, comfortably under the allowance but slower than it
// needs to be. 750 ms puts the mean gap at 975 ms ≈ 1.03 req/s, which uses the
// allowance without exceeding it. Raise BGM_THROTTLE_MS if the site is
// struggling; lowering it past ~750 goes over what they ask for.
const THROTTLE_MS = Number(process.env.BGM_THROTTLE_MS) || 750;

const throttle = createThrottle(THROTTLE_MS);

/**
 * One HTTP call with the shared throttle, retries on 429/5xx, and a hard stop
 * on 401/403 — an auth problem repeated 5 times is how a token gets flagged,
 * and no amount of waiting fixes a bad one.
 */
async function request(pathname, { method = 'GET', body, token, accept404 = false } = {}) {
  const url = pathname.startsWith('http') ? pathname : API + pathname;
  const headers = { 'User-Agent': userAgent(), Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastErr = null;
  for (let attempt = 0; attempt <= 5; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(2 ** attempt, 16) * 1000;
      await sleep(wait);
    }
    const res = await throttle(() =>
      fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    );

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bgm ${res.status} on ${method} ${pathname} — token or User-Agent problem. ${text.slice(0, 200)}`);
      err.fatal = true;
      throw err;
    }
    if (res.status === 404 && accept404) return null;
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
      lastErr = new Error(`bgm ${res.status} on ${method} ${pathname}`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bgm ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    // The write endpoints answer 204 with no body at all. Calling res.json()
    // on that throws, which would report every successful write as a failure —
    // so an empty body is success, not a parse error.
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }
  throw lastErr ?? new Error(`bgm request failed: ${method} ${pathname}`);
}

const cacheKey = (keyword, types) =>
  createHash('sha1').update(`${keyword}::${types.join(',')}`).digest('hex').slice(0, 16);

/**
 * Search subjects by keyword, cached on disk by normalized keyword + type
 * filter. `types` is bgm's subject_type: 2 = anime, 6 = real (live action).
 */
export async function searchSubjects(keyword, types = [2], { limit = 10 } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${cacheKey(keyword, types)}.json`);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    return { ...hit, cached: true };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const body = { keyword, filter: { type: types } };
  const json = await request(`/v0/search/subjects?limit=${limit}`, { method: 'POST', body });
  // Upstream marks search experimental; if the shape drifts, fail loudly with
  // the body rather than quietly returning nothing and mislabelling every row.
  if (!json || !Array.isArray(json.data)) {
    throw new Error(`bgm search returned an unexpected shape for "${keyword}": ${JSON.stringify(json).slice(0, 400)}`);
  }
  const record = { keyword, types, fetched_at: new Date().toISOString(), data: json.data };
  await writeFile(file, JSON.stringify(record));
  return { ...record, cached: false };
}

/** All of a user's collections for the given subject types, paginated. */
export async function fetchCollections(username, types = [2, 6], { token } = {}) {
  const out = [];
  for (const type of types) {
    let offset = 0;
    for (;;) {
      const json = await request(
        `/v0/users/${encodeURIComponent(username)}/collections?subject_type=${type}&limit=50&offset=${offset}`,
        { token, accept404: true },
      );
      if (!json) break; // 404: no public collection of this type
      const data = Array.isArray(json.data) ? json.data : [];
      out.push(...data);
      offset += data.length;
      if (data.length === 0 || offset >= (json.total ?? 0)) break;
    }
  }
  return out;
}

/** Resolve the username from a token, when one happens to be present. */
export async function whoami(token) {
  const me = await request('/v0/me', { token });
  return me?.username ?? null;
}

export { request as bgmRequest };
