// The headers a 429 declares are the headers a 429 actually sends.
//
// The server has always set `Retry-After` and the rate-limit policy headers on
// a refusal. The published spec declared NO response headers at all beyond a
// single `Location` on one 302 — so a generated client could not see the one
// signal the response exists to give. The SDK reads `Retry-After` to schedule
// the next attempt; a typed client that cannot see it falls back to a
// hard-coded default and retries on its own guess.
//
// `rate-limit-headers.test.ts` already asserts the server emits these, checked
// against what the /docs/rate-limits PAGE promises. That is the human-facing
// half. This file is the machine-facing half: it joins the same live response
// to the SPEC, which is what generated clients are built from. The two
// documents were free to disagree, and did.
//
// BOTH DIRECTIONS, because they fail differently:
//
//   declared but not sent   a client waits on a header that never arrives, or
//                           types it as available and reads undefined.
//   sent but not declared   the original defect — a real signal no generated
//                           client can reach.
//
// Nothing is asserted as REQUIRED, and the spec marks nothing required either,
// because none of these is always present:
//
//   - `Retry-After` accompanies a rate-limit refusal. The same 429 also covers
//     concurrency-limit and tier-limit refusals, where no honest number exists:
//     a concurrency slot frees when some other session ends, and a tier quota
//     resets on a billing boundary. Publishing it as guaranteed would be a
//     promise the server does not keep.
//   - the policy headers are REMOVED on an effective-owner denial, deliberately,
//     so the actor's own remaining/limit cannot be read as the owner's.
//
// So this checks the SET the spec declares against the SET a real refusal
// carries, rather than demanding every header on every 429.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', '..', '..', 'packages', 'sdk-python', 'openapi.json');

/** Header names the spec declares on the 429 of a given path+method. */
function declaredOn429(path: string, method: string): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths?: Record<string, Record<string, { responses?: Record<string, { headers?: object }> }>>;
  };
  const headers = spec.paths?.[path]?.[method]?.responses?.['429']?.headers ?? {};
  return Object.keys(headers).map((h) => h.toLowerCase());
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/**
 * Drains the free `sessions:create` bucket and returns the refused response.
 *
 * Free has the smallest capacity, which is why this case uses it. It also needs
 * `keyProvenance: 'cli_device'`: Free is an interactive DESKTOP tier, so an
 * ordinary API key is refused at the customer-API boundary with a 403 before the
 * limiter ever runs, and the response never reaches the code that sets these
 * headers. POST /v1/sessions is on the Free desktop allowlist, so the desktop
 * credential is the caller that actually reaches the bucket in production —
 * the same setup `rate-limit-headers.test.ts` uses to get a real 429.
 */
async function refusedSessionCreate(): Promise<{
  headers: Record<string, unknown>;
  statusCode: number;
}> {
  fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
  const capacity = TIER_RATE_LIMIT_DEFAULTS.free['sessions:create'].capacity;
  // The bucket fires from the FIRST request, so `capacity` successful POSTs
  // leave it empty and the next one is refused.
  for (let i = 0; i < capacity; i += 1) {
    await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
  }
  const refused = await fx.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: {},
  });
  return {
    headers: refused.headers,
    statusCode: refused.statusCode,
  };
}

describe('a 429 sends the headers its schema declares', () => {
  it('CRITICAL the spec declares headers on a 429 at all. Both comparisons below are between SETS, and an empty declared set agrees with anything — a spec that stopped declaring these would report the contract satisfied having compared nothing, which is the exact state this file was written to end.', () => {
    const declared = declaredOn429('/v1/sessions', 'post');
    expect(declared.length, 'header names the spec declares on a 429').toBeGreaterThanOrEqual(5);
    expect(declared, 'including the one SDKs schedule retries from').toContain('retry-after');
  });

  it('CRITICAL a real refusal is reachable, so the live half is not vacuous. If the bucket never drained, every assertion about the response headers would be reading an empty object off a 200 and passing.', async () => {
    const res = await refusedSessionCreate();
    expect(res.statusCode, 'the bucket drained to a refusal').toBe(429);
    expect(Object.keys(res.headers).length, 'the refusal carries headers').toBeGreaterThan(0);
  });

  it('CRITICAL every header the spec declares on a 429 is one the server can actually send. A declared-but-absent header is a promise a generated client types as available and then reads as undefined — the same failure as a required body field the server omits.', async () => {
    const declared = declaredOn429('/v1/sessions', 'post');
    const res = await refusedSessionCreate();
    const sent = new Set(Object.keys(res.headers).map((h) => h.toLowerCase()));

    // The X-RateLimit-* aliases and the bucket name accompany the policy set.
    // A declared name is satisfied by its own presence, or by the alias pair the
    // server sends under the other spelling.
    const alias = (h: string): string =>
      h.startsWith('x-ratelimit-') ? h.slice('x-'.length) : `x-${h}`;
    const absent = declared.filter((h) => !sent.has(h) && !sent.has(alias(h))).sort();

    expect(absent, 'header(s) the 429 schema declares that the refusal did not send:').toEqual([]);
  });

  it('CRITICAL the customer-relevant headers the server DOES send are declared. This is the original defect in the other direction: the server set Retry-After and the policy headers on every refusal and the spec declared none of them, so no generated client could reach the one number that tells it when to try again.', async () => {
    const declared = new Set(declaredOn429('/v1/sessions', 'post'));
    const res = await refusedSessionCreate();

    const CUSTOMER_FACING = [
      'retry-after',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
    ];
    const sent = new Set(Object.keys(res.headers).map((h) => h.toLowerCase()));

    const undeclared = CUSTOMER_FACING.filter((h) => sent.has(h) && !declared.has(h)).sort();
    expect(undeclared, 'header(s) the refusal sends that its 429 schema does not declare:').toEqual(
      [],
    );
  });
});
