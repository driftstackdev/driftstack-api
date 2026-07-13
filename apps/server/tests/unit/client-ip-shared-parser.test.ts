// Shared trusted-proxy-aware client-IP reader tests + drift-guard.
//
// 3 admin routes (admin-webhooks / admin-force-actions / admin-accounts)
// originally hand-rolled raw XFF parsing to populate `actor_ip`. The shared
// lib is now the single source of truth and delegates the trust boundary to
// Fastify's `request.ip`; every consumer imports it.
//
// Drift-guard: all 3 consumer routes import from the shared lib and
// the legacy hand-rolled `function clientIp(...)` MUST NOT come back.
// One of the original copies returned bare `request.ip` instead of
// `request.ip ?? null`, so a future revert to the legacy shape would
// also re-introduce that type-level inconsistency.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { readClientIp } from '../../src/lib/client-ip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const CONSUMER_ROUTES = [
  'apps/server/src/routes/admin-webhooks.ts',
  'apps/server/src/routes/admin-force-actions.ts',
  'apps/server/src/routes/admin-accounts.ts',
  // Added in slice 129 — admin-status-subscribers was the only admin
  // route with audit-log writes that didn't honor XFF (its hand-rolled
  // `clientIp` returned bare `request.ip`). Behind the prod LB, that
  // recorded the proxy IP on every force-unsubscribe instead of the
  // operator's. Now uses readClientIp so the actor_ip is meaningful.
  'apps/server/src/routes/admin-status-subscribers.ts',
  // Added in slice 130 — admin-incidents and mac-nodes-register had
  // the same bare-`request.ip` bug as slice 129's status-subscribers
  // fix. admin-incidents writes audit rows on incident create /
  // update / resolve; mac-nodes-register writes a row on every
  // successful LiveKit credential registration. Both now use the
  // shared XFF-aware parser so actor_ip is consistent across all 6
  // admin-side audit-writing routes.
  'apps/server/src/routes/admin-incidents.ts',
  'apps/server/src/routes/mac-nodes-register.ts',
];

function fakeRequest(opts: {
  xff?: string | string[] | undefined;
  ip?: string | undefined;
}): FastifyRequest {
  return {
    headers: { 'x-forwarded-for': opts.xff },
    ip: opts.ip,
  } as unknown as FastifyRequest;
}

describe('readClientIp — request.ip is the only authority', () => {
  it('returns request.ip when forwarding headers are absent', () => {
    expect(readClientIp(fakeRequest({ ip: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('ignores a caller-spoofed leftmost XFF value', () => {
    expect(readClientIp(fakeRequest({ xff: '66.66.66.66, 203.0.113.7', ip: '203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('preserves a Fastify-resolved IPv6 address', () => {
    expect(readClientIp(fakeRequest({ xff: '66.66.66.66', ip: '2001:db8::1' }))).toBe(
      '2001:db8::1',
    );
  });

  it('returns null instead of trusting XFF when request.ip is unavailable', () => {
    expect(readClientIp(fakeRequest({ xff: '203.0.113.5' }))).toBeNull();
  });
});

describe('readClientIp — Fastify trustProxy integration', () => {
  async function resolvedIp(
    trustProxy: boolean | number | string,
    xff: string,
  ): Promise<string | null> {
    const app = Fastify({ trustProxy });
    app.get('/ip', (request) => ({ ip: readClientIp(request) }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        headers: { 'x-forwarded-for': xff },
      });
      return response.json<{ ip: string | null }>().ip;
    } finally {
      await app.close();
    }
  }

  it('trustProxy=1 selects nginx-appended rightmost peer, not spoofed leftmost input', async () => {
    await expect(resolvedIp(1, '66.66.66.66, 203.0.113.7')).resolves.toBe('203.0.113.7');
  });

  it('trustProxy=false ignores the forwarding header', async () => {
    await expect(resolvedIp(false, '66.66.66.66')).resolves.not.toBe('66.66.66.66');
  });
});

describe('drift-guard: legacy hand-rolled clientIp helper must NOT be reintroduced', () => {
  it.each(CONSUMER_ROUTES)('%s imports readClientIp from the shared lib', (relPath) => {
    const body = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    expect(body).toMatch(/from ['"]\.\.\/lib\/client-ip\.js['"]/);
    expect(body).toMatch(/readClientIp/);
  });

  it.each(CONSUMER_ROUTES)(
    '%s no longer defines a local `function clientIp(...)` helper',
    (relPath) => {
      const body = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      // The legacy form was `function clientIp(request: FastifyRequest): string | null {`
      // Any local definition of clientIp() would re-introduce the
      // drift surface this slice closes.
      expect(body).not.toMatch(/function\s+clientIp\s*\(/);
    },
  );

  it.each(CONSUMER_ROUTES)('%s no longer hand-rolls the XFF split inline', (relPath) => {
    const body = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    // Sentinel: the legacy form used `request.headers['x-forwarded-for']`
    // followed by `.split(',')[0]`. Either token surviving is the
    // shape of a partial revert.
    expect(body).not.toMatch(/request\.headers\['x-forwarded-for'\]/);
  });
});
