// W413.C — drift guard for apps/server/src/routes/admin-usage.ts.
// V-689 admin usage-summary — same shape as the customer-side
// currentPeriodSummary but accessible by ops for any account by id.
// Drift here either lets the admin shape drift from the customer
// shape (admins see different numbers than customers) or skips the
// double scope check (lets non-admin scopes bypass via the
// AccountsAdminService 404).
//
//   • V-689 framing pinned: GET /v1/admin/usage/accounts/:id; same
//     shape as UsageService.currentPeriodSummary; ops-triage usage.
//   • Scope-gate posture pinned: requireScope('driftstack_internal_admin')
//     preHandler; AccountsAdminService.getAccount enforces SAME scope
//     check (defense-in-depth); kept so 404s come from the standard
//     NotFoundError shape every other admin route uses.
//   • Tier-lookup-source rationale pinned: tier comes from
//     AccountsAdminService (same source admin accounts route uses)
//     so admin-usage tier can't drift from admin-accounts.
//   • Params schema: zod string min(1) id; parseOrThrow helper wraps
//     safeParse + BadRequestError on failure.
//   • Reply shape: {account_id, tier, period_start (ISO),
//     period_end (ISO), totals, quotas} — totals + quotas passed
//     through from summary verbatim.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W413.C apps/server/src/routes/admin-usage.ts content parity', () => {
  const body = read(LIB);

  it('V-689 framing pinned: GET /v1/admin/usage/accounts/:id + same shape as UsageService.currentPeriodSummary + ops-triage usage', () => {
    expect(body).toMatch(/V-689 — admin usage-summary route\./);
    expect(body).toMatch(/GET \/v1\/admin\/usage\/accounts\/:id/);
    expect(body).toMatch(
      /Returns the same shape UsageService\.currentPeriodSummary produces\s*\/\/\s*for the caller, but for an arbitrary account by id\. Used by ops\s*\/\/\s*when triaging "is this customer hitting our infra harder than\s*\/\/\s*their tier suggests\?" without needing a customer-side API key\./,
    );
  });

  it('Scope-gate framing pinned: driftstack_internal_admin + tier lookup via AccountsAdminService so it cannot drift from admin dashboard', () => {
    expect(body).toMatch(
      /Auth: driftstack_internal_admin\. Tier lookup goes through\s*\/\/\s*AccountsAdminService \(same source the admin accounts route uses\)\s*\/\/\s*so the answer can't drift from what the admin dashboard shows\./,
    );
  });

  it('Defense-in-depth pinned: AccountsAdminService.getAccount enforces same scope as preHandler; kept for standard NotFoundError 404 shape', () => {
    expect(body).toMatch(
      /\/\/ AccountsAdminService\.getAccount enforces the same scope check\s*\/\/ as our preHandler — kept to surface 404 on unknown ids using\s*\/\/ the same NotFoundError shape every other admin route uses\./,
    );
  });

  it('RegisterAdminUsageRoutesDeps: usageService + accountsAdminService', () => {
    expect(body).toMatch(
      /export interface RegisterAdminUsageRoutesDeps \{\s*usageService: UsageService;\s*accountsAdminService: AccountsAdminService;\s*\}/,
    );
  });

  it('Params zod schema: id z.string().min(1).max(100) (Slice 146 defensive cap)', () => {
    expect(body).toMatch(
      /const Params = z\.object\(\{ id: z\.string\(\)\.min\(1\)\.max\(100\) \}\);/,
    );
  });

  it("Route handler: preHandler requireScope('driftstack_internal_admin') only (no rate-limit); typed Params generic", () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/admin\/usage\/accounts\/:id',\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/,
    );
  });

  it('getAccount + summaryFor dispatch: accountsAdminService.getAccount(req.account!, params.id) + usageService.summaryFor(account.id, account.tier)', () => {
    expect(body).toMatch(
      /const account = await deps\.accountsAdminService\.getAccount\(\s*req\.account!,\s*accountUuidFromParam\(params\.id\),\s*\);\s*const summary = await deps\.usageService\.summaryFor\(account\.id, account\.tier\);/,
    );
  });

  it('Reply shape: account_id + tier + period_start/period_end ISO + totals + quotas (passed through verbatim)', () => {
    expect(body).toMatch(
      /return reply\.send\(\{\s*account_id: account\.id,\s*tier: account\.tier,\s*period_start: summary\.periodStart\.toISOString\(\),\s*period_end: summary\.periodEnd\.toISOString\(\),\s*totals: summary\.totals,\s*quotas: summary\.quotas,\s*\}\);/,
    );
  });

  it('parseOrThrow helper: generic zod parse wrapper; BadRequestError(result.error.message) on failure', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*const result = schema\.safeParse\(input\);\s*if \(!result\.success\) throw new BadRequestError\(result\.error\.message\);\s*return result\.data;/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + zod + BadRequestError + AccountsAdminService + UsageService', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
    expect(body).toMatch(
      /import type \{ AccountsAdminService \} from '\.\.\/services\/admin-accounts\.js';/,
    );
    expect(body).toMatch(/import type \{ UsageService \} from '\.\.\/services\/usage\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
