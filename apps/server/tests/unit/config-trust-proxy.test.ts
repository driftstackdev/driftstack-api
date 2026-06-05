// trustProxy wiring + semantic. The HIGH-severity gap: prod is
// Cloudflare→nginx(127.0.0.1)→Fastify, and without Fastify trustProxy `req.ip`
// is the loopback peer (per-IP rate-limiting collapses to one bucket + audit
// IPs record 127.0.0.1). This pins: (1) loadConfig coerces TRUST_PROXY env
// correctly, and (2) the chosen prod value (1) makes req.ip resolve from the
// nginx-appended X-Forwarded-For rightmost entry.

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

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
  async function ipFor(trustProxy: boolean | number | string, xff: string): Promise<string> {
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

  it('trustProxy=1 → req.ip is the real client (rightmost XFF entry nginx appended), NOT the loopback peer', async () => {
    // nginx $proxy_add_x_forwarded_for appends the real client; even if a client
    // spoofs a leftmost entry, the rightmost (nginx-observed) is authoritative.
    expect(await ipFor(1, '203.0.113.7')).toBe('203.0.113.7');
    expect(await ipFor(1, '66.66.66.66, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('trustProxy=false (dev/test default) → XFF is NOT trusted (req.ip stays the socket peer)', async () => {
    const ip = await ipFor(false, '203.0.113.7');
    expect(ip).not.toBe('203.0.113.7'); // socket peer (127.0.0.1 in inject), XFF ignored
  });
});
