// W277.C — drift guard for customer-dashboard error surfacing.
// Pages that fetch the API should propagate problem+json `detail`
// strings into the visible banner, not generic "request failed"
// fallbacks. Per W151 / W152 we made detail-surfacing a baseline
// requirement — this guard catches regressions where a new page
// skips that pattern.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

/**
 * Call helpers that actually reach the API.
 *
 * Naming only `authedFetch` and `fetch` left SIX pages unchecked. The dashboard
 * also calls `getJson` and `boundedFetch`, and `\bfetch` does not match inside
 * `boundedFetch` — there is no word boundary between `d` and `F`. So the guard
 * verified 16 of the 22 pages that fetch, and the six it skipped include the
 * busiest ones: index, team, usage, webhooks, audit-log.
 */
const FETCH_HELPERS = /\b(authedFetch|boundedFetch|getJson|fetch)\s*\([^)]*\/v1\//;

/** Does this page read the server's problem+json detail on an error path? */
const SURFACES_DETAIL = (body: string): boolean =>
  // Either: parses problem+json body for detail, surfaces err.message
  // from an auth wrapper, or passes the parsed body to the shared
  // response helper that explicitly marks server detail customer-safe.
  /\b(body|json|payload|data|err)\.(detail|message)\b/.test(body) ||
  /window\.driftstackResponseError\s*\(/.test(body);

// Pages that make a real /v1/* call. Filtered on the call site rather than a
// mention of the URL, so a comment naming an endpoint is not treated as a fetch.
const fetchingPages = pages.filter((f) => FETCH_HELPERS.test(read(f)));

/**
 * Pages that deliberately show fixed copy instead of the server's detail.
 *
 * Exactly one, and it is not an oversight. The OAuth consent screen is reached
 * by following a link a THIRD-PARTY application supplied, and its error paths
 * read the response body but deliberately render fixed, actionable text —
 * "Return to the app and start again" — rather than echoing whatever the
 * server said. Surfacing backend detail on a surface an unrelated app can
 * drive the user to is an information-leak, and the generic copy is the
 * security decision, not a missed case.
 *
 * Pinned exactly, and asserted to STILL need the exemption below, so it cannot
 * outlive its reason: if this page ever starts surfacing detail, the entry has
 * to be removed rather than sitting there granting an exemption to nothing.
 */
const DELIBERATE_FIXED_COPY = ['apps/customer-dashboard/src/pages/oauth/authorize.astro'];

describe('W277.C customer-dashboard problem+json detail surfacing sweep', () => {
  it('CRITICAL the sweep found pages AND recognised their fetches, and the detector still fires. The assertion below reports an absence of offenders, so an empty page list — or a helper list that stopped matching how the dashboard calls the API — satisfies it having checked nothing. That second failure was live: naming only authedFetch/fetch skipped six of the twenty-two fetching pages.', () => {
    expect(pages.length, '.astro pages under dashboard pages/').toBeGreaterThan(15);
    expect(fetchingPages.length, 'pages detected as calling /v1/*').toBeGreaterThan(18);

    expect(
      FETCH_HELPERS.test('const r = await boundedFetch(`${base}/v1/oauth/authorize`, {});'),
      'boundedFetch is recognised — \\bfetch does not match inside it',
    ).toBe(true);
    expect(
      FETCH_HELPERS.test('const r = await getJson(`${base}/v1/usage`);'),
      'and so is getJson',
    ).toBe(true);
    expect(
      FETCH_HELPERS.test('// see /v1/usage for the shape'),
      'while a comment naming an endpoint is not treated as a call',
    ).toBe(false);

    expect(SURFACES_DETAIL('showError(body.detail)'), 'the detail detector fires').toBe(true);
    expect(SURFACES_DETAIL("showError('something went wrong')"), 'and not on fixed copy').toBe(
      false,
    );
  });

  it('CRITICAL every exemption is still needed. An entry here that has started surfacing detail exempts nothing and reads as reviewed — the state that lets a real one be added beside it unnoticed.', () => {
    const stale = DELIBERATE_FIXED_COPY.filter((rel) =>
      SURFACES_DETAIL(read(resolve(REPO_ROOT, rel))),
    );
    expect(stale, 'exempted page(s) that now surface detail — delete the entry').toEqual([]);
  });

  it('every page that fetches /v1/* reads body.detail somewhere in its error path', () => {
    const offenders = fetchingPages
      .map((f) => f.slice(REPO_ROOT.length + 1))
      .filter((rel) => !DELIBERATE_FIXED_COPY.includes(rel))
      .filter((rel) => !SURFACES_DETAIL(read(resolve(REPO_ROOT, rel))));
    expect(offenders).toEqual([]);
  });
});
