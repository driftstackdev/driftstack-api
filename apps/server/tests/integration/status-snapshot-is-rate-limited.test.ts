// GET /v1/status is rate limited, like every other public status endpoint.
//
// It was the only member of its family without a gate, and the most expensive
// one in it. `/v1/status/incidents`, `/v1/status/incidents/{id}` and
// `/v1/status/sla` each carry a dedicated IP gate, added for a reason their own
// comment states: the CDN absorbs normal reads, so the gates exist to catch
// direct-API abuse that bypasses it. `/v1/status` had none — while every
// request to it fans out to ALL readiness checks
// (`Promise.all(readinessChecks.map(runComponentCheck))`, each with its own
// timeout), so an unauthenticated caller could drive one DB/Redis probe per
// component per request, unbounded.
//
// Found by measurement rather than by reading code: sweeping every operation
// for `x-ratelimit-*` headers showed 32 of the 34 that reach a handler carry
// them, and the two that do not are public. A source scan had said 86 routes
// were ungated and was simply wrong — its window truncated on a `(req` inside a
// COMMENT — which is why this is asserted against runtime headers and a real
// exhausted bucket instead.
//
// The budget deliberately equals the siblings' (60/min/IP): the team already
// judged that right for public status traffic behind a 30s cache, and a tighter
// limit on the status page would bite hardest during an incident, which is
// exactly when it must not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_IP_LIMITS } from '../../src/middleware/ip-rate-limit.js';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let documented: string[];

beforeAll(async () => {
  fx = await buildTestApp({ scopes: ['read'] });
  const spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
    paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  }>();
  documented = Object.keys(spec.paths?.['/v1/status']?.['get']?.responses ?? {}).sort();
});

afterAll(async () => {
  await fx.app.close();
});

describe('the public status snapshot is rate limited', () => {
  it('CRITICAL the gate really fires, and its capacity is read from the shared budget rather than copied. A copied number keeps passing after the real limit changes.', async () => {
    const capacity = AUTH_IP_LIMITS.statusSnapshot.capacity;
    const addr = '10.7.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < capacity + 1; i += 1) {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/status', remoteAddress: addr });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, capacity), 'every request within capacity is served').not.toContain(
      429,
    );
    expect(statuses[capacity], 'the request past capacity is refused').toBe(429);
  }, 60_000);

  it('CRITICAL the limit is PER-IP. Without this a globally-broken limiter would satisfy the case above while throttling the whole status page for everyone at once — during an incident, when it matters most.', async () => {
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/status',
      remoteAddress: '10.7.0.2',
    });
    expect(res.statusCode, 'a different address is unaffected').toBe(200);
  });

  it('CRITICAL a served response carries the rate-limit headers, which is what the sweep that found this measures. Without them the endpoint would still look ungated to the instrument.', async () => {
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/status',
      remoteAddress: '10.7.0.3',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit'], 'x-ratelimit-limit is emitted').toBeDefined();
  });

  it('CRITICAL the 429 is in the published contract. Adding a limit without documenting it would introduce the exact defect this spec work has been closing — a reachable status the contract denies.', () => {
    expect(documented, 'GET /v1/status documents its 429').toContain('429');
    expect(documented, 'and still documents its 200').toContain('200');
  });

  it('CRITICAL the budget matches the sibling public status endpoints. Diverging here would be a silent policy change on the page customers read during an outage.', () => {
    expect(AUTH_IP_LIMITS.statusSnapshot, 'same budget as the incident list').toEqual(
      AUTH_IP_LIMITS.statusIncidentsList,
    );
    expect(AUTH_IP_LIMITS.statusSnapshot, 'same budget as the SLA read').toEqual(
      AUTH_IP_LIMITS.statusSla,
    );
  });
});
