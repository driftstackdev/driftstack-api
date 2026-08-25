// W1019 — routes/admin-usage V-689 cross-source invariant. Three-
// hundred-forty-fifth in the drift-guard series. Pins the apps/
// server/src/routes/admin-usage.ts admin-side per-account usage view:
//
//   V-689 anchor — 'V-689 — admin usage-summary route'.
//
//   Endpoint framing — 'GET /v1/admin/usage/accounts/:id. Returns the
//   same shape UsageService.currentPeriodSummary produces for the
//   caller, but for an arbitrary account by id. Used by ops when
//   triaging is this customer hitting our infra harder than their
//   tier suggests? without needing a customer-side API key'.
//
//   Auth framing — 'Auth: driftstack_internal_admin. Tier lookup goes
//   through AccountsAdminService (same source the admin accounts
//   route uses) so the answer can't drift from what the admin
//   dashboard shows'.
//
//   preHandler [requireScope('driftstack_internal_admin')].
//
//   Params Zod schema — z.object({ id: z.string().min(1) }).
//
//   Admin-getAccount-first framing — 'AccountsAdminService.getAccount
//   enforces the same scope check as our preHandler — kept to
//   surface 404 on unknown ids using the same NotFoundError shape
//   every other admin route uses'.
//
//   Response 6 fields — account_id + tier + period_start (ISO) +
//     period_end (ISO) + totals + quotas. The tier is the admin-
//     known tier (no drift from dashboard).
//
//   parseOrThrow helper — wraps Zod safeParse + BadRequestError on
//     fail.
//
// stays in lockstep across apps/server/src/routes/admin-usage.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1019 routes/admin-usage V-689 cross-source invariant', () => {
  it("CRITICAL V-689 anchor — 'V-689 — admin usage-summary route'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/\/\/ V-689 — admin usage-summary route\./);
  });

  it("CRITICAL endpoint framing — 'GET /v1/admin/usage/accounts/:id. Returns the same shape UsageService.currentPeriodSummary produces for the caller, but for an arbitrary account by id. Used by ops when triaging is this customer hitting our infra harder than their tier suggests? without needing a customer-side API key'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/\/\/\s+GET \/v1\/admin\/usage\/accounts\/:id/);
    expect(p).toMatch(/\/\/ Returns the same shape UsageService\.currentPeriodSummary produces/);
    expect(p).toMatch(/\/\/ for the caller, but for an arbitrary account by id\. Used by ops/);
    expect(p).toMatch(/\/\/ when triaging "is this customer hitting our infra harder than/);
    expect(p).toMatch(/\/\/ their tier suggests\?" without needing a customer-side API key\./);
  });

  it("CRITICAL auth framing — 'Auth: driftstack_internal_admin. Tier lookup goes through AccountsAdminService (same source the admin accounts route uses) so the answer can't drift from what the admin dashboard shows'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/\/\/ Auth: driftstack_internal_admin\. Tier lookup goes through/);
    expect(p).toMatch(/\/\/ AccountsAdminService \(same source the admin accounts route uses\)/);
    expect(p).toMatch(/\/\/ so the answer can't drift from what the admin dashboard shows\./);
  });

  it("CRITICAL preHandler [requireScope('driftstack_internal_admin')] + Params Zod schema z.object({ id: z.string().min(1) }).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\]/);
    expect(p).toMatch(/const Params = z\.object\(\{ id: z\.string\(\)\.min\(1\)\.max\(100\) \}\);/);
  });

  it("CRITICAL admin-getAccount-first framing — 'AccountsAdminService.getAccount enforces the same scope check as our preHandler — kept to surface 404 on unknown ids using the same NotFoundError shape every other admin route uses'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/\/\/ AccountsAdminService\.getAccount enforces the same scope check/);
    expect(p).toMatch(/\/\/ as our preHandler — kept to surface 404 on unknown ids using/);
    expect(p).toMatch(/\/\/ the same NotFoundError shape every other admin route uses\./);
    // V-1580 — the param used to reach getAccount verbatim. It lands in a uuid
    // column, so a malformed id was a cast error answered as 500 rather than as a
    // bad request. The shape is checked first; getAccount still runs, so the V-689
    // framing above is untouched — a well-formed id for no account is still a 404.
    expect(p).toMatch(
      /const account = await deps\.accountsAdminService\.getAccount\(\s*\n?\s*req\.account!,\s*\n?\s*accountUuidFromParam\(params\.id\),\s*\n?\s*\);/,
    );
  });

  it('CRITICAL response 6-field shape — account_id + tier + period_start (ISO) + period_end (ISO) + totals + quotas.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/account_id: account\.id,/);
    expect(p).toMatch(/tier: account\.tier,/);
    expect(p).toMatch(/period_start: summary\.periodStart\.toISOString\(\),/);
    expect(p).toMatch(/period_end: summary\.periodEnd\.toISOString\(\),/);
    expect(p).toMatch(/totals: summary\.totals,/);
    expect(p).toMatch(/quotas: summary\.quotas,/);
  });

  it('CRITICAL parseOrThrow helper wraps Zod safeParse + BadRequestError on fail.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-usage.ts'));
    expect(p).toMatch(/function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{/);
    expect(p).toMatch(/const result = schema\.safeParse\(input\);/);
    expect(p).toMatch(
      /if \(!result\.success\) throw new BadRequestError\(result\.error\.message\);/,
    );
    expect(p).toMatch(/return result\.data;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-usage-v689-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
