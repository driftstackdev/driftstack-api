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

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { readClientIp } from '../../src/lib/client-ip.js';

import { codeOnly } from './_helpers/code-only.js';

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

/**
 * Every route consuming the shared reader, discovered from source.
 *
 * CONSUMER_ROUTES above is the historical record of the slice-129/130 fixes and
 * names six admin audit-writing routes. Sixteen route files use `readClientIp`
 * now; the ten that arrived later were never covered by the drift-guard, so a
 * hand-rolled `clientIp` reappearing in any of them would not have failed
 * anything. The IP recorded here is the actor_ip on audit rows, which is what
 * makes an audit trail evidence rather than decoration.
 */
const DISCOVERED_CONSUMERS: readonly string[] = readdirSync(
  resolve(REPO_ROOT, 'apps/server/src/routes'),
)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) =>
    /readClientIp/.test(
      codeOnly(readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes', f), 'utf8')),
    ),
  )
  .map((f) => `apps/server/src/routes/${f}`)
  .sort();

describe('drift-guard: legacy hand-rolled clientIp helper must NOT be reintroduced', () => {
  it('CRITICAL discovery found the consumers, and the historical roster is a subset of them', () => {
    expect(
      DISCOVERED_CONSUMERS.length,
      'no readClientIp consumers discovered — the convention changed and the arms below cover ' +
        'nothing',
    ).toBeGreaterThanOrEqual(16);
    const discovered = new Set(DISCOVERED_CONSUMERS);
    expect(
      CONSUMER_ROUTES.filter((r) => !discovered.has(r)),
      'a route in the historical roster no longer uses readClientIp — the slice-129/130 fix was ' +
        'undone and its audit rows record the load balancer IP again',
    ).toEqual([]);
  });

  it('CRITICAL no route decides the IP trust boundary for itself', () => {
    // Repo-wide, not roster-wide: the legacy shape reappearing in a route nobody
    // listed is exactly the case a roster cannot see — which is how routes/auth.ts
    // kept its own `return req.ip ?? null` copy, unnoticed, while feeding
    // requestedFromIp / issuedFromIp / sourceIp across every auth flow.
    //
    // A local helper NAME is fine (auth.ts keeps `clientIp` because it reads
    // better at its call sites); what must not exist is a local helper that
    // re-implements the decision instead of delegating.
    const rogue = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const body = codeOnly(
          readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes', f), 'utf8'),
        );
        const m = /function\s+clientIp\s*\([^)]*\)[^{]*\{([\s\S]{0,600}?)\n\}/.exec(body);
        return m !== null && !m[1]?.includes('readClientIp(');
      });
    expect(
      rogue,
      'a route defines a clientIp helper that does not delegate to readClientIp, so it carries ' +
        'its own copy of the X-Forwarded-For trust decision — one route can then record the ' +
        'caller address and another the load balancer',
    ).toEqual([]);
  });

  it('CRITICAL no route reads X-Forwarded-For outside the shared reader', () => {
    const rogue = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const body = codeOnly(
          readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes', f), 'utf8'),
        );
        return body.includes('x-forwarded-for') && !body.includes('readClientIp');
      });
    expect(
      rogue,
      'a route parses X-Forwarded-For itself, so its trust model can differ from the shared ' +
        'reader — the header is caller-supplied, and request.ip is the only authority',
    ).toEqual([]);
  });

  it.each(DISCOVERED_CONSUMERS)('%s imports readClientIp from the shared lib', (relPath) => {
    const body = codeOnly(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
    expect(body).toMatch(/from ['"]\.\.\/lib\/client-ip\.js['"]/);
    expect(body).toMatch(/readClientIp/);
  });

  it.each(DISCOVERED_CONSUMERS)(
    '%s defines no local clientIp, or one that delegates',
    (relPath) => {
      const body = codeOnly(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
      // The legacy form was `function clientIp(request: FastifyRequest): string | null {`
      // returning its own `req.ip ?? null`. The DEFINITION is not the problem —
      // routes/auth.ts keeps the name because it reads better at its eleven call
      // sites — re-implementing the trust decision is. So a local helper is
      // allowed exactly when it delegates to the shared reader.
      const local = /function\s+clientIp\s*\([^)]*\)[^{]*\{([\s\S]{0,600}?)\n\}/.exec(body);
      if (local === null) return;
      expect(
        local[1] ?? '',
        `${relPath} defines its own clientIp that does not call readClientIp, so it carries a ` +
          'private copy of the X-Forwarded-For trust decision',
      ).toContain('readClientIp(');
    },
  );

  it.each(DISCOVERED_CONSUMERS)('%s no longer hand-rolls the XFF split inline', (relPath) => {
    const body = codeOnly(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
    // Sentinel: the legacy form used `request.headers['x-forwarded-for']`
    // followed by `.split(',')[0]`. Either token surviving is the
    // shape of a partial revert.
    expect(body).not.toMatch(/request\.headers\['x-forwarded-for'\]/);
  });
});
