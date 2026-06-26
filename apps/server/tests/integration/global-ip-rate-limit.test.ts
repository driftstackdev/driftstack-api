// DoS hardening — GLOBAL IP-keyed rate limit applied app-wide via an
// onRequest hook that runs BEFORE the per-route auth preHandler.
//
// The account-keyed limiter (app.rateLimit) only fires AFTER auth
// succeeds, so a flood of bogus bearer tokens that 401 was never gated —
// each one reached findApiKeyByPrefix + scrypt + AES-GCM ungated. This
// gate caps each source IP regardless of route or auth outcome.
//
// The fixture disables the gate by default (so the other inject() suites
// aren't throttled); these tests opt IN with a tiny capacity.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('global IP rate limit (pre-auth, app-wide)', () => {
  it('throttles an UNAUTHENTICATED bogus-bearer flood from one IP before the auth gate', async () => {
    fx = await buildTestApp({ globalIpRateLimit: { capacity: 3, refillPerSecond: 0 } });
    const ip = '198.51.100.10';
    // Bogus bearer → would 401 at auth. With cap=3, the first 3 are
    // allowed through (and 401), the 4th is throttled at the IP gate (429)
    // BEFORE auth ever runs.
    for (let i = 0; i < 3; i++) {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me',
        headers: { authorization: 'Bearer ds_live_bogusbogusbogusbogusbogusbogus' },
        remoteAddress: ip,
      });
      expect(res.statusCode).not.toBe(429);
      expect(res.statusCode).toBe(401); // auth ran and rejected
    }
    const throttled = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_live_bogusbogusbogusbogusbogusbogus' },
      remoteAddress: ip,
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
  });

  it('per-IP isolation: one flooding IP does not throttle another', async () => {
    fx = await buildTestApp({ globalIpRateLimit: { capacity: 2, refillPerSecond: 0 } });
    const attacker = '198.51.100.20';
    const bystander = '198.51.100.21';
    // Attacker exhausts its bucket.
    for (let i = 0; i < 2; i++) {
      await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me',
        headers: { authorization: 'Bearer ds_live_bogusbogusbogusbogusbogusbogus' },
        remoteAddress: attacker,
      });
    }
    const attackerThrottled = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_live_bogusbogusbogusbogusbogusbogus' },
      remoteAddress: attacker,
    });
    expect(attackerThrottled.statusCode).toBe(429);
    // A different IP is unaffected by the attacker's spend.
    const bystanderRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_live_bogusbogusbogusbogusbogusbogus' },
      remoteAddress: bystander,
    });
    expect(bystanderRes.statusCode).not.toBe(429);
  });

  it('also fronts the gui-control-key control routes (bogus control-key flood)', async () => {
    fx = await buildTestApp({ globalIpRateLimit: { capacity: 2, refillPerSecond: 0 } });
    const ip = '198.51.100.30';
    // A control-route hit with a bogus x-driftstack-gui-control-key would
    // run validateControlKey (sessions.get + AES-GCM) before app.rateLimit.
    // The global IP gate caps it regardless. The route 404/401s before the
    // cap, then 429s once the bucket is empty.
    const url = '/v1/agent-sessions/00000000-0000-4000-8000-0000000000ff/mode';
    for (let i = 0; i < 2; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-driftstack-gui-control-key': 'bogus-control-key',
        },
        remoteAddress: ip,
        payload: { mode: 'agent' },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const throttled = await fx.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-driftstack-gui-control-key': 'bogus-control-key',
      },
      remoteAddress: ip,
      payload: { mode: 'agent' },
    });
    expect(throttled.statusCode).toBe(429);
  });

  it('default-disabled in the test fixture: a normal authed call is not gated', async () => {
    fx = await buildTestApp();
    // Many calls from the shared 127.0.0.1 inject IP must NOT trip a gate.
    for (let i = 0; i < 20; i++) {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
