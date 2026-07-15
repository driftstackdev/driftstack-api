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

  it('owner pricing view: GET /v1/admin/owner/pricing, OWNER-gated, reads from PricingService (DB+constant fallback)', () => {
    expect(body).toContain("'/v1/admin/owner/pricing'");
    // Now DB-backed via PricingService (migration 0067 + constant fallback), not the constant directly.
    expect(body).toContain('opts.pricing.listEffective()');
    expect(body).toContain('pricing: PricingService');
    expect(body).toContain('monthly_cents');
    // The GET handler reads only — its body must not mutate. (Scoped to the GET
    // arrow handler, not the whole file: the PATCH edit route below legitimately
    // mutates. We slice from the GET route string to the PATCH route string.)
    const getStart = body.indexOf("'/v1/admin/owner/pricing'");
    const patchStart = body.indexOf("'/v1/admin/owner/pricing/:tier'");
    const getHandler = body.slice(getStart, patchStart > getStart ? patchStart : undefined);
    expect(getHandler).not.toMatch(/setPrice|\.record\(|insert|\.set\(|delete/i);
  });

  it('owner price EDIT: PATCH /v1/admin/owner/pricing/:tier — OWNER-gated, validates tier in EDITABLE_TIERS + monthly_cents, calls PricingService.setPrice, and audits pricing.updated per D-025 (audit-before-response on success AND error)', () => {
    expect(body).toContain("'/v1/admin/owner/pricing/:tier'");
    // OWNER identity gate (not a scope) + rate limit.
    expect(body).toMatch(/preHandler: \[app\.requireOwner, app\.rateLimit\('global'\)\]/);
    expect(body).not.toContain('requireScope');
    // Editable-tier allowlist derived from the price map (free/unpriced rejected).
    expect(body).toContain('Object.keys(TIER_MONTHLY_PRICE_CENTS)');
    expect(body).toContain('EditPricingParamsSchema');
    expect(body).toContain('monthly_cents: z.number().int().positive().max(1_000_000)');
    // Mutation flows through the audited service write.
    expect(body).toContain('opts.pricing.setPrice(tier, monthlyCents, ctx.apiKey.id)');
    // D-025 audit: action pricing.updated, on BOTH success and error branches.
    expect(body).toContain("action: 'pricing.updated'");
    expect(body).toContain("result: 'success'");
    expect(body).toMatch(/result: `error: \$\{code\}`/);
    expect(body).toContain('audit: AdminAuditService');
    // app.ts wires the audit recorder into the owner routes.
    expect(app).toContain('audit: deps.adminAuditService');
  });
});

describe('owner platform-secrets routes (secrets Phase A slice 2) parity', () => {
  const body = readFileSync(ROUTE, 'utf8');

  it('all four secrets routes exist, OWNER-gated + rate-limited', () => {
    expect(body).toContain("app.get(\n    '/v1/admin/owner/secrets',");
    expect(body).toContain("'/v1/admin/owner/secrets/:name',");
    expect(body).toContain("'/v1/admin/owner/secrets/:name/reveal',");
    // Each registration uses the owner-identity gate (not a scope).
    const gateCount = (
      body.match(/preHandler: \[app\.requireOwner, app\.rateLimit\('global'\)\]/g) ?? []
    ).length;
    expect(gateCount).toBeGreaterThanOrEqual(7); // 3 pre-existing + 4 secrets routes
  });

  it('reveal is the audited decrypt: secret.revealed recorded BEFORE the plaintext returns', () => {
    expect(body).toMatch(
      /action: 'secret\.revealed',[\s\S]{0,400}return \{ name: params\.data\.name, value: value as string \};/,
    );
  });

  it('audit payloads carry name + description ONLY — never the secret value (taint rule)', () => {
    // No inputPayload in the secrets routes includes a `value` key.
    const secretsSection = body.slice(body.indexOf('Secrets Phase A slice 2'));
    const payloads = secretsSection.match(/inputPayload: \{[^}]*\}/g) ?? [];
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    for (const p of payloads) {
      expect(p).not.toContain('value');
    }
  });

  it('create-vs-update statuses + lifecycle audit actions pinned', () => {
    expect(body).toMatch(
      /isUpdate \? \('secret\.updated' as const\) : \('secret\.created' as const\)/,
    );
    expect(body).toContain("action: 'secret.deleted',");
    expect(body).toMatch(/reply\.code\(isUpdate \? 200 : 201\)/);
  });

  it('validates secret values by exact UTF-8 storage bytes before the service call', () => {
    expect(body).toContain('isValidPlatformSecretValue');
    expect(body).toContain('PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES');
    expect(body).toMatch(/value: z\.string\(\)\.refine\(isValidPlatformSecretValue,/);
  });
});
