// `/ready` is what stops an orchestrator promoting a broken deploy, and its
// failure path had no coverage.
//
// Two test files reached `/ready` before this one and neither asserted a 503.
// The route's own comment says why: "tests typically pass none and /ready
// returns 200 with an empty checks array" — every fixture exercised the
// trivially-green path, so `allReady` could have been inverted, a rejecting
// probe could have been swallowed as ok, or the timeout could have stopped
// firing, and the suite would have stayed green while a deploy with a dead
// Postgres promoted itself.
//
// The non-disclosure property is asserted here too. The route deliberately does
// NOT echo the probe's error into the public, unauthenticated response, because
// a connection error carries internal host:port and topology (CWE-200). That is
// a security decision recorded only in a comment, and a comment cannot fail.

import { describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

interface ReadyBody {
  ready: boolean;
  checks: Array<{ name: string; ok: boolean; latency_ms: number }>;
}

describe('/ready degradation', () => {
  it('all probes healthy → 200 and ready:true, with each probe reported', async () => {
    const fx = await buildTestApp({
      readinessChecks: [
        { name: 'postgres', fn: () => Promise.resolve(1) },
        { name: 'redis', fn: () => Promise.resolve('PONG') },
      ],
    });
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReadyBody>();
    expect(body.ready).toBe(true);
    expect(body.checks.map((c) => [c.name, c.ok])).toEqual([
      ['postgres', true],
      ['redis', true],
    ]);
  });

  it('CRITICAL one failing probe → 503, so a deploy with a dead dependency cannot promote itself', async () => {
    const fx = await buildTestApp({
      readinessChecks: [
        {
          name: 'postgres',
          fn: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:5432')),
        },
        { name: 'redis', fn: () => Promise.resolve('PONG') },
      ],
    });
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json<ReadyBody>();
    expect(body.ready).toBe(false);
    // The healthy probe still reports healthy — an operator needs to know WHICH
    // dependency is down, not merely that something is.
    expect(body.checks.find((c) => c.name === 'postgres')?.ok).toBe(false);
    expect(body.checks.find((c) => c.name === 'redis')?.ok).toBe(true);
  });

  it('CRITICAL the public response carries no probe error detail (CWE-200)', async () => {
    // The rejection below embeds an internal host, port and topology hint. None
    // of it may reach an unauthenticated caller; the check name plus ok:false
    // is the whole public contract, and the detail belongs in the server log.
    const fx = await buildTestApp({
      readinessChecks: [
        {
          name: 'postgres',
          fn: () =>
            Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:5432 db-primary.internal')),
        },
      ],
    });
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const raw = res.body;
    for (const secret of ['ECONNREFUSED', '10.0.0.7', '5432', 'db-primary.internal']) {
      expect(raw, `/ready leaked ${secret} to an unauthenticated caller`).not.toContain(secret);
    }
  });

  it('CRITICAL a hanging probe times out into a 503 rather than hanging the probe itself', async () => {
    // A dependency that accepts the connection and never answers is the case a
    // naive readiness check hangs on forever — the orchestrator then sees a
    // timeout it cannot distinguish from a slow deploy.
    const fx = await buildTestApp({
      readinessChecks: [{ name: 'redis', fn: () => new Promise(() => undefined), timeoutMs: 50 }],
    });
    const started = Date.now();
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json<ReadyBody>().checks[0]?.ok).toBe(false);
    // Bounded by the per-check timeout, not by the caller giving up. Generous
    // headroom so this asserts "bounded", not a wall-clock budget of its own.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('no probes configured → 200, which is the fixture default every other suite relies on', async () => {
    const fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json<ReadyBody>()).toEqual({ ready: true, checks: [] });
  });
});
