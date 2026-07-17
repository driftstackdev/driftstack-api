// W1030 — routes/admin-cost V-541.B + V-683 cross-source invariant.
// Three-hundred-fifty-sixth in the drift-guard series. Pins the apps/
// server/src/routes/admin-cost.ts admin cost-monitoring routes:
//
//   V-541.B anchor — 'V-541.B — admin cost-monitoring routes'.
//
//   3-endpoint inventory:
//     - GET /v1/admin/cost/accounts/:id?billing_cycle=YYYY-MM
//     - GET /v1/admin/cost/config (V-683)
//     - GET /v1/admin/cost/overview?account_ids=a,b,c&billing_cycle=
//       YYYY-MM
//
//   Auth framing — 'Auth: driftstack_internal_admin scope (V-326e6
//     pattern)'.
//
//   AccountSummaryParams + AccountSummaryQuery + OverviewQuery Zod
//     schemas sharing the strict BILLING_CYCLE_PATTERN authority.
//
//   accounts/:id summary returns 404 'Account has no usage in the
//     requested billing cycle.' on null summary.
//
//   V-683 framing — 'V-683 — config inspector. Returns the wired rate
//     card + tier thresholds without touching usage data. Useful for
//     ops to verify a deploy + for the what did we ship? admin
//     dashboard'.
//
//   /v1/admin/cost/config returns deps.service.getConfig().
//
//   overview account_ids comma-split + .trim() + filter(Boolean) +
//     empty-list BadRequestError.
//
//   All 3 routes preHandler [requireScope('driftstack_internal_
//     admin')].
//
// stays in lockstep across apps/server/src/routes/admin-cost.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1030 routes/admin-cost V-541.B + V-683 cross-source invariant', () => {
  it('CRITICAL V-541.B anchor + 3-endpoint inventory + V-326e6 auth pattern note.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/V-541\.B — admin cost-monitoring routes\./);
    expect(p).toMatch(/GET \/v1\/admin\/cost\/accounts\/:id\?billing_cycle=YYYY-MM/);
    expect(p).toMatch(/GET \/v1\/admin\/cost\/overview\?account_ids=a,b,c&billing_cycle=YYYY-MM/);
    expect(p).toMatch(/\/\/ Auth: driftstack_internal_admin scope \(V-326e6 pattern\)\./);
  });

  it('CRITICAL Zod schemas — AccountSummaryParams (id min 1) + both cost queries use the shared strict calendar-cycle authority.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/const AccountSummaryParams = z\.object\(\{/);
    expect(p).toMatch(/id: z\.string\(\)\.min\(1\)\.max\(100\),/);
    expect(p).toMatch(/const OverviewQuery = z\.object\(\{/);
    expect(p).toMatch(/account_ids: z\.string\(\)\.min\(1\)\.max\(4096\),/);
    expect(p).toMatch(/billing_cycle: z/);
    expect(p.match(/\.regex\(BILLING_CYCLE_PATTERN\)/g)).toHaveLength(2);
  });

  it("CRITICAL accounts/:id returns 404 NotFoundError 'Account has no usage in the requested billing cycle.' on null summary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/if \(summary === null\) \{/);
    expect(p).toMatch(
      /throw new NotFoundError\('Account has no usage in the requested billing cycle\.'\);/,
    );
  });

  it("CRITICAL V-683 framing — 'V-683 — config inspector. Returns the wired rate card + tier thresholds without touching usage data. Useful for ops to verify a deploy + for the what did we ship? admin dashboard'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/\/\/ V-683 — config inspector\. Returns the wired rate card \+ tier/);
    expect(p).toMatch(/\/\/ thresholds without touching usage data\. Useful for ops to verify/);
    expect(p).toMatch(/\/\/ a deploy \+ for the "what did we ship\?" admin dashboard\./);
  });

  it('CRITICAL /v1/admin/cost/config returns deps.service.getConfig().', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/'\/v1\/admin\/cost\/config',/);
    expect(p).toMatch(/return reply\.send\(deps\.service\.getConfig\(\)\);/);
  });

  it("CRITICAL overview account_ids comma-split + trim + filter(Boolean) + 'account_ids must contain at least one id.' on empty.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/const ids = query\.account_ids/);
    expect(p).toMatch(/\.split\(','\)/);
    expect(p).toMatch(/\.map\(\(s\) => s\.trim\(\)\)/);
    expect(p).toMatch(/\.filter\(Boolean\)/);
    // V-541 normalize: the cost endpoints lenient-strip acc_ so they accept the
    // public acc_<uuid> form like sibling admin routes. See
    // project_admin_cost_id_prefix_inconsistency.
    expect(p).toMatch(/\.map\(bareAccountId\);/);
    expect(p).toMatch(/if \(ids\.length === 0\) \{/);
    expect(p).toMatch(/throw new BadRequestError\('account_ids must contain at least one id\.'\);/);
  });

  it("CRITICAL all 3 routes preHandler [requireScope('driftstack_internal_admin')].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    const matches =
      p.match(/preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\]/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('CRITICAL billingCycleFromDate fallback default — billing_cycle ?? billingCycleFromDate(new Date(now())). Time source injectable via nowFn (test seam).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts'));
    expect(p).toMatch(/const now = deps\.nowFn \?\? Date\.now;/);
    expect(p).toMatch(
      /billingCycle: query\.billing_cycle \?\? billingCycleFromDate\(new Date\(now\(\)\)\),/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-cost-v541b-v683-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
