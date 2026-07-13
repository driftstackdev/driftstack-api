// Verifies the OpenAPI 3.1 spec is valid, served, and contains every
// expected route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

  it('publishes broad-read requirements for sensitive account reads and the complete four-bucket rate-limit enum', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const accountReadPaths = [
      '/v1/account/me',
      '/v1/account/me/organization',
      '/v1/account/mfa',
      '/v1/account/me/oauth-links',
      '/v1/account/web-sessions',
      '/v1/account/me/bundled-llm-settings',
      '/v1/account/me/bundled-llm-status',
      '/v1/account/me/byok-anthropic-key',
      '/v1/account/rate-limits',
    ] as const;

    for (const path of accountReadPaths) {
      expect(JSON.stringify(spec.paths?.[path]?.get), path).toContain(
        'Requires broad `read` or `account_owner`',
      );
    }

    const rateLimitOperation = JSON.stringify(spec.paths?.['/v1/account/rate-limits']?.get);
    for (const bucket of [
      'global',
      'sessions:create',
      'agent_sessions:message',
      'agent_sessions:input_event',
    ]) {
      expect(rateLimitOperation).toContain(bucket);
    }
  });

  // Drift guard: the committed packages/sdk-python/openapi.json is the codegen
  // input for the Python + Go SDKs. It must stay in sync with the live
  // generator. Compares PARSED content (not text) so the committed file's
  // prettier formatting is tolerated, but any CONTENT drift — a route/schema/
  // enum added without regenerating — fails CI instead of silently
  // accumulating (it had drifted ~3.5k lines of un-regenerated enrichment
  // before this guard). Regenerate with: npm run sdk:python:dump-spec
  it('committed packages/sdk-python/openapi.json matches the generator (no codegen-output drift)', () => {
    _clearSpecCache();
    const HERE = dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
    const committed = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
    );
    const fresh = JSON.parse(JSON.stringify(generateOpenApiSpec()));
    expect(
      fresh,
      'committed openapi.json is stale — run `npm run sdk:python:dump-spec` and commit the result',
    ).toEqual(committed);
  });

  it('registers every expected path', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = Object.keys(spec.paths ?? {}).sort();
    expect(paths).toEqual(
      [
        '/health',
        '/version',
        '/v1/admin/accounts/{id}/delete',
        '/v1/admin/accounts/{id}/quota-override',
        '/v1/admin/accounts/{id}/suspend',
        '/v1/admin/accounts/{id}/tier',
        '/v1/admin/accounts/{id}/unsuspend',
        '/v1/admin/accounts/{id}/usage',
        '/v1/admin/api-keys',
        '/v1/admin/audit-log',
        '/v1/admin/overview',
        // admin billing analytics — active-subscription mix by tier
        '/v1/admin/billing/subscriptions/stats',
        // owner-only platform activation status (master-owner cockpit)
        '/v1/admin/owner/platform-status',
        // owner-only current per-tier pricing (read)
        '/v1/admin/owner/pricing',
        // owner-only edit a tier's monthly price (audited)
        '/v1/admin/owner/pricing/{tier}',
        '/v1/admin/rate-limit-overrides',
        '/v1/admin/sessions',
        '/v1/admin/sessions/stats',
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
        // V-541.D — customer cost surface + GUI notification SSE stream
        '/v1/account/cost',
        '/v1/account/me/notifications',
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
        // Arc 7 docs.openapi — BYOK Anthropic + Bundled LLM (v2-#6/8)
        '/v1/account/me/billing-portal',
        '/v1/account/me/bundled-llm-settings',
        '/v1/account/me/bundled-llm-status',
        '/v1/account/me/organization',
        // ARC A — per-account customer proxies (slice 2 + 4b test)
        '/v1/account/me/proxies',
        '/v1/account/me/proxies/{id}',
        '/v1/account/me/proxies/{id}/test',
        '/v1/account/me/byok-anthropic-key',
        '/v1/account/me/byok-anthropic-key/test',
        // Arc 7 docs.openapi — OAuth-client IDP signin (V-667.C)
        '/v1/auth/oauth-client/start',
        '/v1/auth/oauth-client/confirm-merge',
        // Arc 7 docs.openapi — OAuth 2.0 public dance (V-667)
        '/v1/oauth/authorize',
        '/v1/oauth/introspect',
        '/v1/oauth/revoke',
        '/v1/oauth/token',
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
        // S33 2026-07-07 (fable-truth-audit) — #187 verification re-send
        '/v1/auth/resend-verification',
        // V-402 — magic-link + password-reset
        '/v1/auth/magic-link/consume',
        '/v1/auth/magic-link/request',
        '/v1/auth/password-reset/confirm',
        '/v1/auth/password-reset/request',
        // V-460 — V-266 CLI/GUI activation flow
        '/v1/auth/cli-authorize/bind-device-code',
        '/v1/auth/cli-authorize/exchange',
        '/v1/auth/cli-authorize/initiate',
        // V-456 profile base CRUD
        '/v1/profiles',
        '/v1/profiles/{id}',
        // one-shot launch-from-profile verb (handler in routes/sessions.ts)
        '/v1/profiles/{id}/launch',
        // V-313 profile clone
        '/v1/profiles/{id}/clone',
        // V-480 profile export / import (data portability)
        '/v1/profiles/{id}/export',
        '/v1/profiles/import',
        // V-666 profile ownership transfer
        '/v1/profiles/{id}/transfer',
        // S33 2026-07-07 (fable-truth-audit) — doc-150 §8 storage trim
        '/v1/profiles/{id}/trim',
        // L4b recycle bin (soft delete → trash → restore / purge)
        '/v1/profiles/trash',
        '/v1/profiles/{id}/restore',
        '/v1/profiles/{id}/purge',
        // V-312 profile snapshots
        '/v1/profiles/{id}/snapshots',
        '/v1/profile-snapshots',
        '/v1/profile-snapshots/{id}',
        '/v1/profile-snapshots/{id}/restore',
        '/v1/sessions',
        '/v1/sessions/{id}',
        '/v1/sessions/{id}/capture',
        '/v1/sessions/{id}/extract',
        '/v1/sessions/{id}/interact',
        '/v1/sessions/{id}/login',
        '/v1/sessions/{id}/navigate',
        '/v1/sessions/{id}/proxy',
        '/v1/sessions/{id}/search',
        '/v1/sessions/{id}/state',
        '/v1/sessions/{id}/wait',
        // AI-D — agent chat sessions
        '/v1/agent-sessions',
        '/v1/agent-sessions/{id}',
        '/v1/agent-sessions/{id}/transcript',
        '/v1/agent-sessions/{id}/handback',
        '/v1/agent-sessions/{id}/input-event',
        '/v1/agent-sessions/{id}/livekit-token',
        '/v1/agent-sessions/{id}/message',
        '/v1/agent-sessions/{id}/mode',
        '/v1/agent-sessions/{id}/recipe-suggestion',
        '/v1/agent-sessions/{id}/resume',
        '/v1/agent-sessions/{id}/takeover',
        // S33 2026-07-07 (fable-truth-audit) — live-session control surface
        // (page-state poll / cookies read+import / history step / file
        // upload / downloads list+fetch), live routes previously absent
        // from the spec.
        '/v1/agent-sessions/{id}/page-state',
        '/v1/agent-sessions/{id}/cookies',
        '/v1/agent-sessions/{id}/cookies/set',
        '/v1/agent-sessions/{id}/history',
        '/v1/agent-sessions/{id}/files',
        '/v1/agent-sessions/{id}/downloads',
        '/v1/agent-sessions/{id}/downloads/content',
        // LK arc — per-Mac LiveKit credentials registration
        '/v1/mac-nodes/register',
        // AI-B4 + V-530.I/.J — recipe library: create + list + get/delete
        // (read-path pulled fwd from v1.1 D2/D3; execution stays gated).
        '/v1/recipes',
        '/v1/recipes/{id}',
        // V-820 — operator-only fleet event stream
        '/v1/fleet/events',
        // Proxy-probe exit-IP echo (unauthenticated by design - F1)
        '/v1/egress/echo',
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

  it('status double-opt-in spec mirrors the routes: subscribe POST→202, confirm/unsubscribe GET with ?token= (these drifted to POST+body once)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = (spec.paths ?? {}) as Record<
      string,
      Record<
        string,
        { parameters?: Array<{ name?: string; in?: string }>; responses?: Record<string, unknown> }
      >
    >;
    // subscribe: POST, 202 (the route does reply.code(202) + the status site
    // checks `res.status === 202`; the spec said 200 once).
    expect(paths['/v1/status/subscribe']?.post?.responses?.['202']).toBeDefined();
    expect(paths['/v1/status/subscribe']?.post?.responses?.['200']).toBeUndefined();
    // confirm + unsubscribe are GET with a `token` query param — they're email
    // link clicks. A POST+body spec (the prior drift) would 404 against the
    // real GET routes and mislead any SDK generated from the spec.
    for (const p of ['/v1/status/subscribe/confirm', '/v1/status/subscribe/unsubscribe']) {
      expect(paths[p]?.get).toBeDefined();
      expect(paths[p]?.post).toBeUndefined();
      const params = paths[p]?.get?.parameters ?? [];
      expect(params.some((pr) => pr.name === 'token' && pr.in === 'query')).toBe(true);
    }
  });

  it('GET /v1/agent-sessions (list) is documented alongside POST (the GET method was missing once)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const p = (spec.paths ?? {})['/v1/agent-sessions'] as Record<string, unknown> | undefined;
    expect(p?.get).toBeDefined();
    expect(p?.post).toBeDefined();
  });

  it('GET /v1/admin/incidents (list) is documented alongside POST (the GET method was missing once)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const p = (spec.paths ?? {})['/v1/admin/incidents'] as Record<string, unknown> | undefined;
    expect(p?.get).toBeDefined();
    expect(p?.post).toBeDefined();
  });

  it('admin create/append endpoints document 201 (the routes reply.code(201); the spec said 200 once)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = (spec.paths ?? {}) as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    for (const p of [
      '/v1/admin/accounts/{id}/audit-note',
      '/v1/admin/accounts/{id}/refund-record',
      '/v1/admin/incidents',
      '/v1/admin/incidents/{id}/updates',
    ]) {
      expect(paths[p]?.post?.responses?.['201']).toBeDefined();
      expect(paths[p]?.post?.responses?.['200']).toBeUndefined();
    }
  });

  it('S46 2026-07-07: POST /v1/profiles/{id}/snapshots documents 201 (capture is a create; route replies code(201))', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const paths = (spec.paths ?? {}) as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    const capture = paths['/v1/profiles/{id}/snapshots'];
    expect(capture?.post?.responses?.['201']).toBeDefined();
    expect(capture?.post?.responses?.['200']).toBeUndefined();
  });

  it('POST /v1/auth/logout documents 200 with a body (the route returns 200 { ok }, not 204 no-content)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const logout = (spec.paths ?? {})['/v1/auth/logout'] as
      | Record<string, { responses?: Record<string, unknown> }>
      | undefined;
    expect(logout?.post?.responses?.['200']).toBeDefined();
    expect(logout?.post?.responses?.['204']).toBeUndefined();
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
      // Proxy-probe echo - unauthenticated by design (F1: exit IPs
      // never tied to accounts; the GUI probe calls it THROUGH the
      // customer's proxy). IP-rate-limited instead.
      if (path === '/v1/egress/echo') continue;
      // V-820 — /v1/fleet/* uses signed Ed25519 JWT in a custom
      // header at WebSocket handshake (gated by mTLS at the edge),
      // not customer-API Bearer. Operator-only surface; not
      // customer-facing.
      if (path.startsWith('/v1/fleet/')) continue;
      // V-667 — /v1/oauth/* is the public OAuth 2.0 dance. PKCE +
      // client_secret IS the auth on /token; /authorize and
      // /introspect / /revoke also don't carry BearerAuth (they're
      // mint/validate/revoke endpoints).
      if (path.startsWith('/v1/oauth/')) continue;
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
    // V-082 billing — GET /v1/billing response. Pinned in components
    // so the Python regen produces a typed `GetBillingStateResponse`
    // class instead of an anonymous synthesised type.
    expect(names).toContain('GetBillingStateResponse');
    // V-462 / V-297 audit-log — AccountAuditEntry is the row shape
    // emitted on /v1/account/audit-log (list) + /v1/account/audit-log/
    // export. Pinning ensures the Python regen produces a typed
    // pydantic class instead of synthesised inline types per-route.
    expect(names).toContain('AccountAuditEntry');
    expect(names).toContain('ListAccountAuditResponse');
    expect(names).toContain('ExportAccountAuditResponse');
    // V-352b avatar upload — UploadAvatarResponse.
    expect(names).toContain('UploadAvatarResponse');
    // BYOK Anthropic customer-key surface — 3 named schemas.
    expect(names).toContain('ByokAnthropicMetadata');
    expect(names).toContain('PutByokAnthropicRequest');
    expect(names).toContain('PutByokAnthropicResponse');
  });

  // LK.3 — pin LiveKitInfo as a NAMED schema in components.schemas
  // (not inline). datamodel-codegen + every named-ref consumer
  // depends on this to generate a typed `LiveKitInfo` class.
  // Previously the schema was inline-anonymous on the response, so
  // the Python SDK had to fall back to dict[str, Any] while TS+Go
  // had typed structs — a cross-SDK asymmetry. Drift to dropping
  // .openapi('LiveKitInfo') would silently regress that.
  it('LK.3 — LiveKitInfo is a named component schema with the 5 required fields', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toBeDefined();
    expect(Object.keys(schemas ?? {})).toContain('LiveKitInfo');
    const lki = schemas?.LiveKitInfo as
      | { type?: string; properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(lki?.type).toBe('object');
    expect(Object.keys(lki?.properties ?? {}).sort()).toEqual(
      ['expires_at', 'participant_identity', 'room', 'token', 'ws_url'].sort(),
    );
    expect((lki?.required ?? []).sort()).toEqual(
      ['expires_at', 'participant_identity', 'room', 'token', 'ws_url'].sort(),
    );
  });

  // LK.2 — same named-schema pattern for the mac-nodes/register
  // request + response bodies. Without explicit .openapi() names,
  // datamodel-codegen produces synthesised types per-method (e.g.
  // `RegisterMacNodeRequestRequest`) which makes the operator-facing
  // Python regen harder to consume. Pin both as `RegisterMacNodeRequest`
  // and `RegisterMacNodeResponse`.
  // v2-#6 — Bundled-LLM settings + status schemas. These are
  // customer-facing dashboard read/write surfaces. Naming them lets
  // pydantic regen produce `BundledLlmSettings` + `BundledLlmStatus`
  // + `PatchBundledLlmRequest` classes instead of anonymous types,
  // matching the TS dashboard component prop shape.
  it('v2-#6 — Bundled-LLM settings + status + patch-request are named component schemas', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toBeDefined();
    const names = Object.keys(schemas ?? {});
    expect(names).toContain('BundledLlmSettings');
    expect(names).toContain('PatchBundledLlmRequest');
    expect(names).toContain('BundledLlmStatus');

    const settings = schemas?.BundledLlmSettings as
      | { type?: string; properties?: Record<string, unknown> }
      | undefined;
    expect(settings?.type).toBe('object');
    expect(Object.keys(settings?.properties ?? {}).sort()).toEqual(
      ['consent', 'monthly_cap_usd_cents'].sort(),
    );

    const status = schemas?.BundledLlmStatus as
      | { type?: string; properties?: Record<string, unknown> }
      | undefined;
    expect(status?.type).toBe('object');
    expect(Object.keys(status?.properties ?? {}).sort()).toEqual(
      [
        'cap_cents',
        'consent',
        'month_started_at',
        'refused_count_this_month',
        'remaining_cents',
        'used_this_month_cents',
      ].sort(),
    );
  });

  it('endpoint descriptions do NOT reference internal-docs paths (customers consume the OpenAPI spec via Scalar UI; internal paths confuse + leak repo structure)', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const json = JSON.stringify(spec);
    // The fleet-events 503 description previously listed two internal
    // design docs by path. Customers reading the Scalar-rendered spec
    // would see internal-only repo structure they have no access to.
    // Drift-guard pins the clean shape.
    expect(json).not.toMatch(/docs\/internal\/fleet-nodes-sql-migration-design/);
    expect(json).not.toMatch(/docs\/internal\/cross-agent-control-plane-contract/);
    // The fleet-events 503 description still carries the load-bearing
    // operator-only framing so customer API-key holders know it's not
    // for them.
    expect(json).toMatch(/operator-only \(fleet nodes auth via mTLS\)/);
    // The fleet-events summary line no longer cites the internal
    // `docs/network-architecture.md` repo path — that doc lives at
    // the repo root, not on docs.driftstack.dev, so customers reading
    // the Scalar UI couldn't follow the reference anyway.
    expect(json).not.toMatch(/docs\/network-architecture\.md/);
  });

  it('LK.2 — RegisterMacNodeRequest + RegisterMacNodeResponse are named component schemas', () => {
    _clearSpecCache();
    const spec = generateOpenApiSpec();
    const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toBeDefined();
    const names = Object.keys(schemas ?? {});
    expect(names).toContain('RegisterMacNodeRequest');
    expect(names).toContain('RegisterMacNodeResponse');

    const req = schemas?.RegisterMacNodeRequest as
      | { type?: string; properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(req?.type).toBe('object');
    expect(Object.keys(req?.properties ?? {}).sort()).toEqual(['livekit', 'mac_node_id'].sort());

    const res = schemas?.RegisterMacNodeResponse as
      | { type?: string; properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(res?.type).toBe('object');
    expect(Object.keys(res?.properties ?? {}).sort()).toEqual(
      ['livekit_registered_at', 'mac_node_id', 'ws_url'].sort(),
    );
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
