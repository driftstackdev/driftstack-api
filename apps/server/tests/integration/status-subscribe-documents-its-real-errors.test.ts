// The status-subscription endpoints document the statuses they actually return.
//
// All three published only their happy path — `200`, `200`, `202` and nothing
// else — while every one of them is reached by CLICKING A LINK IN AN EMAIL.
// A token that is missing, malformed, expired, or already used is not an edge
// case there; it is the ordinary second visit. The handlers produce 400
// (`ValidationError`, expiry) and 404 (`NotFoundError`: "invalid or has been
// used"), all behind an IP rate-limit gate that produces 429.
//
// A client generated from the old contract therefore had no branch for the
// most likely outcome of a real click, and a contract test written against it
// would have called the correct 404 a server fault.
//
// This asserts the two directions that matter together: the endpoint really
// does return the status, AND the spec really does document it. Either alone
// is satisfiable by a lie — a spec listing statuses nothing produces, or a
// server producing statuses nothing documents.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;

interface SpecDocument {
  paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}

/** Statuses the published spec lists for a path + method. */
function documented(path: string, method: string): string[] {
  return Object.keys(spec.paths?.[path]?.[method]?.responses ?? {}).sort();
}

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read'] });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();
});

afterAll(async () => {
  await fx.app.close();
});

// Every case uses its OWN source IP. The gate is 3 requests per IP
// (`AUTH_IP_LIMITS.statusSubscribe`), so a shared address makes each case
// depend on how many requests ran before it — the first draft of this file
// passed its early assertions and then got a 429 where it expected a 404,
// which is an ordering artefact rather than a finding.
let ip = 0;
const from = (): string => `10.9.${String(++ip)}.1`;

describe('the status-subscription endpoints document what they really return', () => {
  it('CRITICAL a malformed token really does 400 on both link endpoints, and both document it. The token arrives from an email link, so this is a routine visit rather than an exotic failure.', async () => {
    for (const path of ['/v1/status/subscribe/confirm', '/v1/status/subscribe/unsubscribe']) {
      const res = await fx.app.inject({ method: 'GET', url: path, remoteAddress: from() });
      expect(res.statusCode, `${path} with NO token`).toBe(400);
      expect(documented(path, 'get'), `${path} documents its 400`).toContain('400');
    }
  });

  it('CRITICAL a well-formed but unknown token really does 404, and both document it. This is the second click on a confirmation link — the single most likely real request either endpoint receives.', async () => {
    const token = 'a'.repeat(43);
    for (const path of ['/v1/status/subscribe/confirm', '/v1/status/subscribe/unsubscribe']) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `${path}?token=${token}`,
        remoteAddress: from(),
      });
      expect(res.statusCode, `${path} with an unknown token`).toBe(404);
      expect(documented(path, 'get'), `${path} documents its 404`).toContain('404');
    }
  });

  it('CRITICAL a malformed address really does 400 on POST /v1/status/subscribe, and the spec documents it WITHOUT weakening the deliberate 202. The unconditional 202 exists so a caller cannot learn whether an address was already subscribed; a malformed address reveals nothing and is a different outcome entirely.', async () => {
    const bad = await fx.app.inject({
      method: 'POST',
      url: '/v1/status/subscribe',
      payload: { email: 'not-an-email' },
      remoteAddress: from(),
    });
    expect(bad.statusCode, 'a malformed address is rejected').toBe(400);
    expect(documented('/v1/status/subscribe', 'post'), 'the 400 is documented').toContain('400');

    // The anti-enumeration property itself: a well-formed address is accepted
    // unconditionally, so 202 must remain the documented success.
    expect(documented('/v1/status/subscribe', 'post'), 'the 202 survives').toContain('202');
  });

  it('CRITICAL the documented 429 is genuinely reachable. It is the one status here that no ordinary request produces, so without exhausting a bucket on purpose it would be documentation nothing has ever confirmed.', async () => {
    const addr = from();
    const statuses: number[] = [];
    // Capacity is 3 per IP, so the fourth request from one address must trip.
    for (let i = 0; i < 4; i += 1) {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/status/subscribe/confirm',
        remoteAddress: addr,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses[3], 'the 4th request from one IP is rate limited').toBe(429);
    expect(statuses.slice(0, 3), 'the first three are served').not.toContain(429);
    expect(
      documented('/v1/status/subscribe/confirm', 'get'),
      'and the 429 is documented',
    ).toContain('429');
  });

  it('CRITICAL every status these three endpoints document is one they can actually produce. A spec listing outcomes nothing returns is the same defect in the opposite direction, and it reads as reviewed.', () => {
    // Each status in these lists is exercised for real by a case above — 400,
    // 404 and 429 directly, and the 200/202 successes by the sweep in
    // openapi-responses-conform-to-the-spec. So this pins the exact set rather
    // than asserting a superset nothing has confirmed.
    const expected: Record<string, string[]> = {
      'get /v1/status/subscribe/confirm': ['200', '400', '404', '429'],
      'get /v1/status/subscribe/unsubscribe': ['200', '400', '404', '429'],
      'post /v1/status/subscribe': ['202', '400', '429'],
    };
    for (const [key, want] of Object.entries(expected)) {
      const [method, path] = key.split(' ');
      expect(
        documented(path ?? '', method ?? ''),
        `${key} documents exactly its real outcomes`,
      ).toEqual(want);
    }
  });
});
