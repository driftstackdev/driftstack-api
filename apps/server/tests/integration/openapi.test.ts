// Verifies the OpenAPI 3.1 spec is valid, served, and contains every
// expected route.

import { afterEach, describe, expect, it } from 'vitest';
import { generateOpenApiSpec, _clearSpecCache } from '../../src/lib/openapi.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
  _clearSpecCache();
});

describe('OpenAPI spec generation', () => {
  it('produces a valid 3.1 document with required fields', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Driftstack API');
    expect(spec.info.version).toBe('0.0.1');
    expect(spec.servers).toBeDefined();
  });

  it('registers every expected path', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = Object.keys(spec.paths ?? {}).sort();
    expect(paths).toEqual(
      [
        '/health',
        '/version',
        '/v1/admin/accounts/{id}/quota-override',
        '/v1/admin/accounts/{id}/suspend',
        '/v1/admin/accounts/{id}/tier',
        '/v1/admin/accounts/{id}/unsuspend',
        '/v1/admin/accounts/{id}/usage',
        '/v1/admin/api-keys',
        '/v1/admin/audit-log',
        '/v1/admin/overview',
        '/v1/admin/rate-limit-overrides',
        '/v1/admin/sessions',
        '/v1/admin/validation-schedules',
        '/v1/admin/validation-schedules/{archetype}',
        '/v1/admin/validation-schedules/{archetype}/trigger',
        '/v1/admin/webhook-deliveries/{id}',
        '/v1/admin/webhook-deliveries/{id}/replay',
        '/v1/admin/webhook-dlq',
        '/v1/admin/webhook-dlq/{id}/requeue',
        // V-465 — admin OpenAPI gap closure
        '/v1/admin/accounts',
        '/v1/admin/accounts/{id}',
        '/v1/admin/accounts/{id}/audit-note',
        '/v1/admin/accounts/{id}/refund-record',
        '/v1/admin/api-keys/{id}/revoke',
        '/v1/admin/incidents',
        '/v1/admin/incidents/{id}',
        '/v1/admin/incidents/{id}/resolve',
        '/v1/admin/incidents/{id}/updates',
        '/v1/admin/sessions/{id}/destroy',
        '/v1/admin/status-subscribers',
        '/v1/admin/status-subscribers/{id}/force-unsubscribe',
        '/v1/account/audit-log',
        '/v1/account/audit-log/export',
        '/v1/account/email-preferences',
        // V-386 / V-387 — account self-edit surface + avatar
        '/v1/account/me',
        '/v1/account/me/avatar',
        '/v1/account/me/oauth-links',
        // V-353 MFA endpoints
        '/v1/account/mfa',
        '/v1/account/mfa/disable',
        '/v1/account/mfa/enroll',
        '/v1/account/mfa/recovery-codes/regenerate',
        '/v1/account/mfa/verify',
        '/v1/account/rate-limits',
        // V-355 web-session list / revoke
        '/v1/account/web-sessions',
        '/v1/account/web-sessions/{id}',
        '/v1/api-keys',
        '/v1/api-keys/{id}',
        '/v1/api-keys/{id}/rotate',
        // V-353d/e auth MFA flows (public — no BearerAuth required)
        '/v1/auth/mfa/challenge',
        '/v1/auth/mfa/step-up',
        // V-420 — billing surface
        '/v1/billing',
        '/v1/billing/checkout-session',
        '/v1/billing/portal-session',
        '/v1/billing/trial-pack',
        // V-666 — crypto-orders surface (V-666.AX)
        '/v1/billing/crypto-checkout',
        '/v1/billing/crypto-checkout/quote',
        '/v1/billing/crypto-orders',
        '/v1/billing/crypto-orders/{order_id}',
        '/v1/billing/crypto-orders/{order_id}/cancel',
        // V-666.AZ — receipts
        '/v1/billing/crypto-orders/{order_id}/receipt',
        '/v1/billing/crypto-orders/{order_id}/receipt.pdf',
        '/v1/billing/crypto-orders/{order_id}/receipt.txt',
        // V-666.AY — admin crypto-orders surface
        '/v1/admin/crypto-orders',
        '/v1/admin/crypto-orders.csv',
        '/v1/admin/crypto-orders/daily',
        '/v1/admin/crypto-orders/idempotency-metrics',
        '/v1/admin/crypto-orders/pending-age',
        '/v1/admin/crypto-orders/sweep-expired',
        '/v1/admin/crypto-orders/stats',
        '/v1/admin/crypto-orders/{order_id}',
        '/v1/admin/crypto-orders/{order_id}/apply-ipn',
        '/v1/admin/crypto-orders/{order_id}/events',
        '/v1/admin/crypto-orders/{order_id}/internal-note',
        // V-401 — core auth surface
        '/v1/auth/login',
        '/v1/auth/logout',
        '/v1/auth/refresh',
        '/v1/auth/signup',
        '/v1/auth/verify-email',
        // V-402 — magic-link + password-reset
        '/v1/auth/magic-link/consume',
        '/v1/auth/magic-link/request',
        '/v1/auth/password-reset/confirm',
        '/v1/auth/password-reset/request',
        // V-460 — V-266 CLI/GUI activation flow
        '/v1/auth/cli-authorize/bind',
        '/v1/auth/cli-authorize/exchange',
        '/v1/auth/cli-authorize/initiate',
        // V-456 profile base CRUD
        '/v1/profiles',
        '/v1/profiles/{id}',
        // V-313 profile clone
        '/v1/profiles/{id}/clone',
        // V-312 profile snapshots
        '/v1/profiles/{id}/snapshots',
        '/v1/profile-snapshots',
        '/v1/profile-snapshots/{id}',
        '/v1/profile-snapshots/{id}/restore',
        '/v1/sessions',
        '/v1/sessions/{id}',
        '/v1/sessions/{id}/capture',
        '/v1/sessions/{id}/interact',
        '/v1/sessions/{id}/navigate',
        '/v1/sessions/{id}/proxy',
        '/v1/sessions/{id}/state',
        '/v1/sessions/{id}/wait',
        // EG-API-1.2 + 1.3 — customer-configurable egress (planning 133)
        '/v1/proxies',
        '/v1/proxies/{id}',
        // AI-D — agent chat sessions
        '/v1/agent-sessions',
        '/v1/agent-sessions/{id}',
        '/v1/agent-sessions/{id}/message',
        // AI-B4 — write-only recipe library (Q.5.d)
        '/v1/recipes',
        // V-820 — operator-only fleet event stream
        '/v1/fleet/events',
        // V-459 public status surface
        '/v1/status',
        '/v1/status/incidents',
        '/v1/status/incidents/{id}',
        '/v1/status/sla',
        '/v1/status/subscribe',
        '/v1/status/subscribe/confirm',
        '/v1/status/subscribe/unsubscribe',
        '/v1/team/invites',
        '/v1/team/invites/accept',
        '/v1/team/members',
        '/v1/team/members/{id}',
        '/v1/team/owners',
        '/v1/usage',
        '/v1/usage/series',
        // V-458 legal acceptance machinery
        '/v1/legal/accept',
        '/v1/legal/documents',
        '/v1/legal/required',
        '/v1/webhook-deliveries/{deliveryId}/replay',
        // V-457 webhook base CRUD + deliveries
        '/v1/webhooks',
        '/v1/webhooks/{id}',
        '/v1/webhooks/{id}/deliveries',
        // V-356 + V-359 webhook test + rotate
        '/v1/webhooks/{id}/rotate-secret',
        '/v1/webhooks/{id}/test',
      ].sort(),
    );
  });

  it('all admin endpoints carry the "admin" tag (for docs filtering)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!path.startsWith('/v1/admin/')) continue;
      const ops = methods as Record<string, { tags?: string[] }>;
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'delete', 'put', 'patch'].includes(method)) continue;
        expect(op.tags).toContain('admin');
      }
    }
  });

  it('declares BearerAuth security scheme', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const schemes = spec.components?.securitySchemes;
    expect(schemes?.BearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('all v1 routes require BearerAuth (except /v1/auth/* public flows)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      if (!path.startsWith('/v1/')) continue;
      // V-353d/e — auth-flow endpoints are public by design (the
      // bearer is what they MINT or REFRESH). They live under
      // /v1/auth/* and intentionally don't carry a BearerAuth
      // security requirement.
      if (path.startsWith('/v1/auth/')) continue;
      // V-459 — /v1/status/* is also public-by-design (status pages
      // and uptime monitors must work without an API key).
      if (path.startsWith('/v1/status')) continue;
      // V-820 — /v1/fleet/* uses signed Ed25519 JWT in a custom
      // header at WebSocket handshake (gated by mTLS at the edge),
      // not customer-API Bearer. Operator-only surface; not
      // customer-facing.
      if (path.startsWith('/v1/fleet/')) continue;
      const ops = methods as Record<string, { security?: unknown[] }>;
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'delete', 'put', 'patch'].includes(method)) continue;
        expect(
          op.security,
          `${method.toUpperCase()} ${path} should declare BearerAuth security`,
        ).toBeDefined();
      }
    }
  });

  it('component schemas include the major resources', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const names = Object.keys(spec.components?.schemas ?? {});
    expect(names).toContain('Session');
    expect(names).toContain('ApiKey');
    expect(names).toContain('Account');
    expect(names).toContain('Problem');
    expect(names).toContain('UsagePeriodSummary');
  });
});

describe('OpenAPI HTTP routes', () => {
  it('GET /openapi.json is public and returns JSON', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<Record<string, unknown>>();
    expect(body.openapi).toBe('3.1.0');
  });

  it('V-666.AX crypto endpoints carry the crypto + billing tags', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const cryptoPaths = [
      '/v1/billing/crypto-checkout',
      '/v1/billing/crypto-orders',
      '/v1/billing/crypto-orders/{order_id}',
      '/v1/billing/crypto-orders/{order_id}/cancel',
    ];
    for (const p of cryptoPaths) {
      const methods = spec.paths?.[p] as Record<string, { tags?: string[] }> | undefined;
      expect(methods).toBeDefined();
      for (const op of Object.values(methods ?? {})) {
        expect(op.tags).toContain('crypto');
        expect(op.tags).toContain('billing');
      }
    }
  });

  it('V-666.AX crypto-checkout response carries the documented field shape', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const op = spec.paths?.['/v1/billing/crypto-checkout'] as
      | Record<string, { responses?: Record<string, unknown> }>
      | undefined;
    expect(op?.post?.responses?.['201']).toBeDefined();
  });

  it('GET /docs serves the Scalar UI HTML (after trailing-slash redirect)', async () => {
    fx = await buildTestApp();
    // Scalar mounts at /docs/ — bare /docs returns a 301 to the trailing form.
    const redirect = await fx.app.inject({ method: 'GET', url: '/docs' });
    expect([200, 301]).toContain(redirect.statusCode);

    const final = await fx.app.inject({ method: 'GET', url: '/docs/' });
    expect(final.statusCode).toBe(200);
    expect(final.headers['content-type']).toMatch(/text\/html/);
    expect(final.body).toContain('<html');
  });
});
