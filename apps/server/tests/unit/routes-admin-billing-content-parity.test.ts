// Drift guard for apps/server/src/routes/admin-billing.ts.
// Admin billing analytics — GET /v1/admin/billing/subscriptions/stats,
// the active-subscription-by-tier (paying-customer mix) endpoint for the
// admin cockpit. Read-only, admin-scoped. Drift here would either move
// the wire path (breaking the cockpit fetch), drop the scope/rate-limit
// gate (exposing billing data), or change the reply shape the dashboard
// renders.
//
//   • Wire path: GET /v1/admin/billing/subscriptions/stats.
//   • Scope-gate: requireScope('driftstack_internal_admin') + rateLimit('global').
//   • Source: adminBilling.countActiveSubscriptionsByTier(ctx).
//   • Reply shape: { by_tier, total_active } — total_active derived from by_tier.
//   • Options interface: AdminBillingRoutesOptions { adminBilling }.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-billing.ts');
const body = readFileSync(LIB, 'utf8');

describe('apps/server/src/routes/admin-billing.ts content parity', () => {
  it('exports registerAdminBillingRoutes + AdminBillingRoutesOptions { adminBilling }', () => {
    expect(body).toContain('export function registerAdminBillingRoutes(');
    expect(body).toContain('export interface AdminBillingRoutesOptions {');
    expect(body).toContain('adminBilling: AdminBillingService;');
  });

  it('wire path is GET /v1/admin/billing/subscriptions/stats', () => {
    expect(body).toContain('app.get(');
    expect(body).toContain("'/v1/admin/billing/subscriptions/stats'");
  });

  it("scope-gated to driftstack_internal_admin + rateLimit('global')", () => {
    expect(body).toContain("app.requireScope('driftstack_internal_admin')");
    expect(body).toContain("app.rateLimit('global')");
  });

  it('reads the aggregate via adminBilling.countActiveSubscriptionsByTier(ctx)', () => {
    expect(body).toContain('adminBilling.countActiveSubscriptionsByTier(ctx)');
  });

  it('reply shape is { by_tier, total_active } with total_active derived from by_tier', () => {
    expect(body).toContain('by_tier: byTier');
    expect(body).toContain('total_active: totalActive');
    expect(body).toMatch(/Object\.values\(byTier\)\.reduce\(/);
  });
});
