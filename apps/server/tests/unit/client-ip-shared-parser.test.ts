// Shared `X-Forwarded-For` first-hop parser tests + drift-guard.
//
// 3 admin routes (admin-webhooks / admin-force-actions / admin-accounts)
// each hand-rolled the same XFF first-hop parser to populate the
// `actor_ip` column on their admin_audit_log rows. The shared lib at
// apps/server/src/lib/client-ip.ts is now the single source of truth;
// every consumer imports it.
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

describe('readClientIp — happy paths', () => {
  it('returns the first comma-separated XFF entry, trimmed', () => {
    expect(readClientIp(fakeRequest({ xff: '203.0.113.5, 198.51.100.7, 10.0.0.1' }))).toBe(
      '203.0.113.5',
    );
  });

  it('trims surrounding whitespace on the first entry', () => {
    expect(readClientIp(fakeRequest({ xff: '   203.0.113.5   , 198.51.100.7' }))).toBe(
      '203.0.113.5',
    );
  });

  it('handles a single-entry XFF with no commas', () => {
    expect(readClientIp(fakeRequest({ xff: '203.0.113.42' }))).toBe('203.0.113.42');
  });

  it('handles an IPv6 first hop', () => {
    expect(readClientIp(fakeRequest({ xff: '2001:db8::1, 198.51.100.7' }))).toBe('2001:db8::1');
  });
});

describe('readClientIp — fallback to request.ip', () => {
  it('falls back to request.ip when XFF is absent', () => {
    expect(readClientIp(fakeRequest({ ip: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it('falls back to request.ip when XFF is an empty string', () => {
    expect(readClientIp(fakeRequest({ xff: '', ip: '127.0.0.1' }))).toBe('127.0.0.1');
  });

  it("falls back to request.ip when XFF's first entry is whitespace-only", () => {
    expect(readClientIp(fakeRequest({ xff: '   , 198.51.100.7', ip: '127.0.0.1' }))).toBe(
      '127.0.0.1',
    );
  });

  it('returns null when XFF is absent AND request.ip is undefined', () => {
    expect(readClientIp(fakeRequest({}))).toBeNull();
  });

  it('returns null when XFF is an array (Fastify multi-value form — XFF should be string-only on a normalised proxy)', () => {
    // The legacy hand-rolled parsers all guarded `typeof xff === 'string'`
    // and ignored the array shape, falling through to request.ip.
    expect(readClientIp(fakeRequest({ xff: ['203.0.113.5'], ip: undefined }))).toBeNull();
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
