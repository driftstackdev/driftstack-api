// Drift guard for apps/server/src/routes/admin-owner.ts — the master-owner
// platform-status endpoint (first consumer of app.requireOwner). Drift here
// would either drop the OWNER gate (exposing the surface to staff-admins,
// against the master-owner model), move the wire path, or leak secrets into
// what must stay a boolean-only activation snapshot.
//
//   • Wire path: GET /v1/admin/owner/platform-status.
//   • Gate: app.requireOwner (identity check, NOT a scope) + rateLimit('global').
//   • Response: { features: { billing, livekit, crypto, oauth_client, sentry,
//     permissive_cors } } — booleans only, no secrets.
//   • app.ts derives each flag from the same `deps.X !== undefined` check it
//     uses to register that feature (truthful "is it wired" reporting).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-owner.ts');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('apps/server/src/routes/admin-owner.ts content parity', () => {
  const body = read(ROUTE);
  const app = read(APP);

  it('exports registerAdminOwnerRoutes + OwnerPlatformStatus { 6 boolean flags }', () => {
    expect(body).toContain('export function registerAdminOwnerRoutes(');
    expect(body).toContain('export interface OwnerPlatformStatus {');
    for (const f of ['billing', 'livekit', 'crypto', 'oauth_client', 'sentry', 'permissive_cors']) {
      expect(body).toContain(`${f}: boolean;`);
    }
  });

  it('wire path is GET /v1/admin/owner/platform-status', () => {
    expect(body).toContain('app.get(');
    expect(body).toContain("'/v1/admin/owner/platform-status'");
  });

  it('OWNER-gated via app.requireOwner (identity, not a scope) + rateLimit', () => {
    expect(body).toContain('app.requireOwner');
    expect(body).toContain("app.rateLimit('global')");
    // Must NOT fall back to a mere scope check — owner-only is the contract.
    expect(body).not.toContain('requireScope');
  });

  it('returns { features } only — booleans, no per-request state', () => {
    // The handler returns exactly { features: opts.platformStatus } (the
    // boot-time boolean flags) — no DB reads, no secret values.
    expect(body).toContain('features: opts.platformStatus');
    expect(body).toContain('OwnerPlatformStatus');
  });

  it('app.ts derives each flag from the feature-registration guard (deps.X !== undefined)', () => {
    expect(app).toContain('registerAdminOwnerRoutes(app, {');
    expect(app).toContain('billing: deps.billingService !== undefined');
    expect(app).toContain('livekit: deps.livekit !== undefined');
    expect(app).toContain('crypto: deps.cryptoOrdersService !== undefined');
    expect(app).toContain('oauth_client: deps.oauthClientService !== undefined');
    expect(app).toContain('sentry: deps.sentry !== undefined');
    expect(app).toContain('permissive_cors: deps.permissiveCors === true');
  });

  it('owner pricing view: GET /v1/admin/owner/pricing, OWNER-gated, read-only from TIER_MONTHLY_PRICE_CENTS', () => {
    expect(body).toContain("'/v1/admin/owner/pricing'");
    // Same owner-gate as platform-status (identity, not scope).
    expect(body).toContain('TIER_MONTHLY_PRICE_CENTS');
    expect(body).toContain('monthly_cents');
    // Read-only — no mutation of pricing here (the editable/Stripe-sync arc is gated).
    expect(body).not.toMatch(/insert|update|\.set\(|delete/i);
  });
});
