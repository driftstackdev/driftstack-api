// GET /v1/egress/echo documents the 429 its own gate produces.
//
// It published `200` and nothing else while sitting behind `ipRateLimit` at 12
// requests per IP (`EGRESS_ECHO_IP_LIMIT`). This is the proxy-probe endpoint,
// so it is called in bursts by exactly the clients most likely to trip that
// gate — and the published contract told them it could not fail.
//
// Asserted in both directions, because either half alone is satisfiable by a
// lie: a spec can list a 429 nothing produces, and a server can produce a 429
// nothing documents. The limit is exhausted for real rather than inferred from
// the gate's presence.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EGRESS_ECHO_IP_LIMIT } from '../../src/routes/egress-echo.js';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let documented: string[];

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read'] });
  const spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
    paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  }>();
  documented = Object.keys(spec.paths?.['/v1/egress/echo']?.['get']?.responses ?? {}).sort();
});

afterAll(async () => {
  await fx.app.close();
});

describe('the egress echo endpoint documents its rate limit', () => {
  it('CRITICAL the gate really fires, and the capacity is read from the route rather than hardcoded here. A copy of the number would keep passing after the real limit changed.', async () => {
    const addr = '10.8.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < EGRESS_ECHO_IP_LIMIT.capacity + 1; i += 1) {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/egress/echo',
        remoteAddress: addr,
      });
      statuses.push(res.statusCode);
    }
    expect(
      statuses.slice(0, EGRESS_ECHO_IP_LIMIT.capacity),
      'every request within capacity is served',
    ).not.toContain(429);
    expect(statuses[EGRESS_ECHO_IP_LIMIT.capacity], 'the request past capacity is refused').toBe(
      429,
    );
  });

  it('CRITICAL the 429 the gate produces is in the published contract, and the 200 still is. A probe client generated from the old spec had no branch for the one failure this endpoint actually has.', () => {
    expect(documented, 'the contract lists exactly the outcomes this route has').toEqual([
      '200',
      '429',
    ]);
  });

  it('CRITICAL a separate address is unaffected. Without this, a global limiter would satisfy the case above while breaking every caller at once — the assertion would pass for the wrong reason.', async () => {
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/egress/echo',
      remoteAddress: '10.8.0.2',
    });
    expect(res.statusCode, 'the limit is per-IP, not global').toBe(200);
  });
});
