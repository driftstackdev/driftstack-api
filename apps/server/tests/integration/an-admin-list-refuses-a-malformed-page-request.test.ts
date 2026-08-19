// V-981 — the admin list routes refuse a malformed page request.
//
// Each parses its own `List…QuerySchema` and answers `BadRequestError` on failure.
// Coverage at HEAD: **every one of these refusals has 0 hits**, while the handlers around
// them are exercised by their own suites — the shape this arc has found six times,
// where a file reads as covered because the surrounding code runs.
//
// Table-driven rather than an arm per file, because the schemas agree on the part
// being tested — every one floors `limit` at 1 and coerces it from a string.
//
// They do NOT agree on the rest, and the derivation arm below is what surfaced that:
// the table started with four routes and the scan found six. Four share
// `min(1).max(100)` with a 512-char `cursor`; `/v1/admin/incidents` matches those
// bounds; `/v1/admin/status-subscribers` caps at **200** and declares no `cursor` at
// all. So the shared probes are only the two every schema refuses — a zero and a
// non-number — rather than a cap violation that is valid on one of the six.
//
// The consequence is not uniform across the routes and is not asserted as such: on
// the customer-facing equivalents (V-975, V-979) deleting the parse degraded to a
// 500, because the handler dereferences `parsed.data` immediately. What is asserted
// here is the contract an operator sees — a bad page request is refused, and a good
// one is served — which holds whatever the handler does next.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

/** Every admin list route whose page request goes through a `List…QuerySchema`. */
const ADMIN_LISTS = [
  '/v1/admin/accounts',
  '/v1/admin/api-keys',
  '/v1/admin/incidents',
  '/v1/admin/rate-limit-overrides',
  '/v1/admin/sessions',
  '/v1/admin/status-subscribers',
] as const;

/**
 * Only the values EVERY schema in the table refuses.
 *
 * A cap violation is deliberately absent: the caps differ (100 on five routes, 200
 * on status-subscribers), so `limit=101` is a legitimate request to one of them and
 * asserting a 400 would pin a bound that route does not have.
 */
const MALFORMED = [
  ['a limit below the floor', 'limit=0'],
  ['a non-numeric limit', 'limit=abc'],
] as const;

const STAFF_SCOPES = ['read', 'write', 'admin', 'driftstack_internal_admin'] as const;

describe('V-981 an admin list refuses a malformed page request', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL every admin list refuses each malformed page parameter. All six refusals were executed by no test, so a change to any one of these schemas — a widened cap, a dropped bound, a parse removed — would have landed with nothing to notice it.', async () => {
    fx = await buildTestApp({ scopes: [...STAFF_SCOPES] });
    const headers = { authorization: `Bearer ${fx.plaintext}` };

    const admitted: string[] = [];
    for (const path of ADMIN_LISTS) {
      for (const [label, qs] of MALFORMED) {
        const res = await fx.app.inject({ method: 'GET', url: `${path}?${qs}`, headers });
        if (res.statusCode !== 400) admitted.push(`${path} accepted ${label} (${res.statusCode})`);
      }
    }
    expect(
      admitted,
      'these admin lists did not refuse a malformed page request — the value was coerced, defaulted ' +
        'or passed through to the query instead of being rejected:',
    ).toEqual([]);
  });

  it('CRITICAL every admin list still serves a WELL-FORMED page request. Without this the arm above is satisfied by a route that refuses everything — including one broken by an unrelated change, which would then read as a passing validation test.', async () => {
    fx = await buildTestApp({ scopes: [...STAFF_SCOPES] });
    const headers = { authorization: `Bearer ${fx.plaintext}` };

    const refused: string[] = [];
    for (const path of ADMIN_LISTS) {
      const res = await fx.app.inject({ method: 'GET', url: `${path}?limit=5`, headers });
      if (res.statusCode !== 200) refused.push(`${path} answered ${res.statusCode}`);
    }
    expect(refused, 'these admin lists refused a valid page request:').toEqual([]);
  });

  it('CRITICAL the table still names every admin list that parses a page query, so a new one cannot be added without joining it. Derived from the route sources rather than restated, because a hand-written table is exactly the kind that stops matching reality quietly — this arm caught its own table short by two, and their differing bounds, before it was ever committed.', () => {
    const dir = new URL('../../src/routes', import.meta.url).pathname;

    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.startsWith('admin') && f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      if (!/List\w*QuerySchema\.safeParse/.test(src)) continue;
      for (const m of src.matchAll(/['"`](\/v1\/admin\/[a-z-]+)['"`]/g)) {
        found.add(m[1] ?? '');
        break; // the list route is the module's first admin path
      }
    }
    const missing = [...found].filter((p) => !ADMIN_LISTS.includes(p as never)).sort();
    expect(
      missing,
      'these admin modules parse a page query but are not in the table above — add them so their ' +
        'refusal is exercised too:',
    ).toEqual([]);
    expect(found.size, 'admin modules parsing a page query').toBeGreaterThanOrEqual(6);
  });
});
