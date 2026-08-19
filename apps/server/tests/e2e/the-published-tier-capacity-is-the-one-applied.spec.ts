// V-1045 — the per-tier rate limit a customer is told about is the one the limiter applies.
//
// `reference/rate-limits.md` publishes a capacity per tier, and
// `published-rate-limit-table-matches-the-code` proves that table equals
// `TIER_RATE_LIMIT_DEFAULTS`, derived over every tier. That is a TEXT property.
// Whether an `api_scale` account actually receives 6,000 is a behavioural one, and
// between them sits every way a tier could be resolved wrongly: a default applied
// before the account loads, a mapping keyed on the wrong field, a fallback that
// silently downgrades.
//
// Every rate-limited response carries `x-ratelimit-limit`, so one request per tier
// reads the applied capacity — eight requests rather than draining a 60,000-token
// bucket.
//
// ── Why this file exists twice ──────────────────────────────────────────────
//
// V-1044 wrote it, failed to break it with three mutations, concluded it detected
// nothing, and DELETED it. That conclusion was wrong. `middleware/rate-limit.ts`
// builds a `consumeInput` in three places, and the two V-1044 mutated are not the
// path a plain authenticated route takes:
//
//   • the `tier` fallback inside the effective-owner helper is a TEST SEAM, reached
//     only when `resolvedTier === undefined`, which the real plugin never leaves
//     unset;
//   • the effective-owner `consumeInput` serves the acting-as-owner path;
//   • the `app.rateLimit` DECORATOR builds its own `consumeInput`, and that is what
//     a normal request uses.
//
// Forcing the tier on the decorator's input moves this file's observed capacity
// from 6,000 to 60. The test was always sound; the mutations missed.
//
// The lesson is recorded here rather than only in the log: "the mutation did not
// fire" has two readings — the assertion is weak, or the mutation missed — and
// V-1044 took the first without ruling out the second. What ruled it out was
// replacing the header emission itself with a sentinel value and watching it
// arrive, which proves the file is live before concluding anything about what it
// reads.
//
// WHAT THIS CANNOT DETECT, measured rather than guessed. Editing a tier's capacity
// in `TIER_RATE_LIMIT_DEFAULTS` moves BOTH sides — the limiter reads the same
// constant this file compares against — so every arm stays green. That is not a
// hole, it is the division of labour: `published-rate-limit-table-matches-the-code`
// owns docs-versus-constant, and this file owns constant-versus-applied. Neither
// alone covers the path from a published number to a customer's bucket.
//
// `free` is excluded deliberately: it is a DESKTOP tier, and an ordinary API key on
// a free account is refused at AUTH with 403 before any limiter runs, so there is
// no rate-limited response to read a header from. The last arm asserts that
// exclusion still describes reality rather than trusting this comment.

import { TIER_RATE_LIMIT_DEFAULTS, type AccountTier } from '@driftstack/api-types';
import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

/** Every tier whose keys reach the limiter — all of them except the desktop tier. */
const API_TIERS = (Object.keys(TIER_RATE_LIMIT_DEFAULTS) as AccountTier[]).filter(
  (t) => t !== 'free',
);

test('the roster covers the published tiers', () => {
  expect(Object.keys(TIER_RATE_LIMIT_DEFAULTS).length, 'tiers in the published table').toBe(8);
  expect(API_TIERS.length, 'tiers whose keys reach the limiter').toBe(7);
});

for (const tier of API_TIERS) {
  test(`${tier}: x-ratelimit-limit is the published capacity`, async ({ request }) => {
    const acct = await seedAccount(server.client, {
      email: `cap-${tier}-${Date.now()}@driftstack.test`,
      tier,
    });

    const res = await request.get(`${server.baseUrl}/v1/account/me`, {
      headers: authHeader(acct.plaintext),
    });
    expect(res.status(), `${tier} is a working API tier`).toBe(200);

    // The response names the bucket it charged, so the comparison is against the
    // published capacity for THAT bucket rather than one this file assumes.
    const bucket = res.headers()['x-ratelimit-bucket'];
    const applied = res.headers()['x-ratelimit-limit'];
    expect(bucket, `${tier} sent no x-ratelimit-bucket header`).toBeDefined();
    expect(applied, `${tier} sent no x-ratelimit-limit header`).toBeDefined();

    const published = TIER_RATE_LIMIT_DEFAULTS[tier] as Record<string, { capacity: number }>;
    const expected = published[bucket as string]?.capacity;
    expect(
      expected,
      `${tier} charged bucket '${String(bucket)}', which the published table does not define`,
    ).toBeDefined();
    expect(
      Number(applied),
      `${tier}/${String(bucket)} is published at ${String(expected)} but the limiter applied ${String(applied)}`,
    ).toBe(expected);
  });
}

test('free is excluded because its keys never reach the limiter, not because it was skipped', async ({
  request,
}) => {
  const acct = await seedAccount(server.client, {
    email: `cap-free-${Date.now()}@driftstack.test`,
    tier: 'free',
  });

  const res = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(acct.plaintext),
    failOnStatusCode: false,
  });
  expect(
    res.status(),
    'free is meant to be a desktop tier whose ordinary API keys are refused at AUTH — if this ' +
      'starts succeeding, free belongs in the loop above',
  ).toBe(403);
});
