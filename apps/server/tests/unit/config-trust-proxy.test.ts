// trustProxy wiring + semantic. The HIGH-severity gap: prod is
// Cloudflare→nginx(127.0.0.1)→Fastify, and without Fastify trustProxy `req.ip`
// is the loopback peer (per-IP rate-limiting collapses to one bucket + audit
// IPs record 127.0.0.1). This pins: (1) loadConfig coerces TRUST_PROXY env
// correctly, and (2) the chosen prod value (1) makes req.ip resolve from the
// nginx-appended X-Forwarded-For rightmost entry.

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';
import { fastifyTrustProxy } from '../../src/lib/app.js';

describe('loadConfig — TRUST_PROXY coercion', () => {
  const base = {
    DATABASE_URL: 'postgres://x@localhost:5432/x',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('unset / empty → false (dev/test: no proxy)', () => {
    expect(loadConfig({ ...base }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });

  it("a bare integer → number of hops (prod '1' → 1)", () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it("'true'/'false' → boolean; any other string → the raw trust-list value", () => {
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(loadConfig({ ...base, TRUST_PROXY: '127.0.0.1,::1' }).trustProxy).toBe('127.0.0.1,::1');
  });
});

describe('Fastify trustProxy semantic — the chosen prod value (1) resolves req.ip from X-Forwarded-For', () => {
  async function ipFor(trustProxy: boolean | string, xff: string): Promise<string> {
    const app = Fastify({ trustProxy });
    app.get('/ip', (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': xff },
    });
    await app.close();
    return res.json<{ ip: string }>().ip;
  }

  it('the value prod actually carries in its environment (1) still resolves req.ip to the real client once translated — fastify 5.12 dropped the hop count, and this arm is about the DEPLOYED value continuing to work, not just the new literal', async () => {
    // nginx $proxy_add_x_forwarded_for appends the real client; even if a client
    // spoofs a leftmost entry, the rightmost (nginx-observed) is authoritative.
    expect(await ipFor(fastifyTrustProxy(1), '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor(fastifyTrustProxy(1), '66.66.66.66, 203.0.113.7')).toBe('203.0.113.7');
  });

  // fastify 5.12 REMOVES the hop-count form (number) as the fix for
  // GHSA-3m5p-2c4r-xxw2 (X-Forwarded-* spoofing under trustProxy hop-count), so
  // prod's `TRUST_PROXY=1` has to become a value that survives the upgrade. For
  // this topology that value is 'loopback': fastify's peer IS nginx on 127.0.0.1,
  // and nginx appends the real client (post-CF-Connecting-IP real_ip) to XFF, so
  // walking right while addresses are loopback lands on exactly the same address
  // the hop count did. These arms pin that equivalence BEFORE the bump, so the
  // upgrade is a type change and not a silent change of who req.ip names.
  it("trustProxy='loopback' resolves req.ip identically to the hop count it replaces", async () => {
    expect(await ipFor('loopback', '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor('loopback', '66.66.66.66, 203.0.113.7')).toBe('203.0.113.7');
    // the equivalence itself, stated as one assertion
    expect(await ipFor('loopback', '66.66.66.66, 203.0.113.7')).toBe(
      await ipFor(fastifyTrustProxy(1), '66.66.66.66, 203.0.113.7'),
    );
  });

  it("trustProxy='loopback' ignores a spoofed leftmost entry — the client cannot choose its own req.ip", async () => {
    // What a hostile client controls is the LEFT of the list; nginx appends the
    // address it observed on the right. Anything that returned the left-hand value
    // would hand an attacker the per-IP rate-limit bucket and the audit trail.
    expect(await ipFor('loopback', '1.2.3.4, 5.6.7.8, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('trustProxy=false (dev/test default) → XFF is NOT trusted (req.ip stays the socket peer)', async () => {
    const ip = await ipFor(false, '203.0.113.7');
    expect(ip).not.toBe('203.0.113.7'); // socket peer (127.0.0.1 in inject), XFF ignored
  });
});

describe('fastifyTrustProxy — the 5.12 hop-count translation', () => {
  function spy(): { warn: (o: Record<string, unknown>, m: string) => void; calls: string[] } {
    const calls: string[] = [];
    return { warn: (_o, m) => calls.push(m), calls };
  }

  it('CRITICAL a hop count becomes loopback and SAYS SO. On 5.12 a numeric trustProxy is not rejected, it is IGNORED: req.ip silently becomes the loopback peer, which would record 127.0.0.1 as every audit IP and collapse per-IP rate limiting into a single bucket. Measured on 5.12.3 before this translation existed.', () => {
    const log = spy();
    expect(fastifyTrustProxy(1, log)).toBe('loopback');
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatch(/TRUST_PROXY is a hop count/);
    expect(log.calls[0]).toMatch(/Set TRUST_PROXY=loopback/);
  });

  it('every value fastify still accepts passes through untouched and warns about nothing', () => {
    const log = spy();
    expect(fastifyTrustProxy('loopback', log)).toBe('loopback');
    expect(fastifyTrustProxy('127.0.0.1,::1', log)).toBe('127.0.0.1,::1');
    expect(fastifyTrustProxy(true, log)).toBe(true);
    expect(fastifyTrustProxy(false, log)).toBe(false);
    expect(log.calls, 'a pass-through must not warn').toHaveLength(0);
  });

  it('translates without a logger — the boot path must not depend on one being passed', () => {
    expect(fastifyTrustProxy(1)).toBe('loopback');
  });
});
