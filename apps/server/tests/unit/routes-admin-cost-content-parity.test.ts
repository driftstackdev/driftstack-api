// W416.A — drift guard for apps/server/src/routes/admin-cost.ts.
// V-541.B admin cost-monitoring + V-683 config inspector. Drift here
// either lets the customer-side surface differ (admin sees different
// numbers than V-541.D customer view) or breaks the V-683 deploy-
// verification surface (ops can't confirm rate-card wiring).
//
//   • V-541.B framing pinned: GET /v1/admin/cost/accounts/:id +
//     GET /v1/admin/cost/overview; driftstack_internal_admin scope
//     (V-326e6 pattern).
//   • V-683 framing pinned: GET /v1/admin/cost/config returns wired
//     rate-card + tier thresholds without touching usage; ops deploy-
//     verification + "what did we ship?" admin dashboard.
//   • billing_cycle uses the shared strict calendar-cycle authority; default via
//     billingCycleFromDate(new Date(now())).
//   • account_ids overview: CSV string split + trim + filter(Boolean);
//     empty list → 400 BadRequestError.
//   • Account-summary 404 when service returns null (distinct from
//     V-541.D customer "spend €0" synthesis — admin gets actual 404).
//   • Test seam: nowFn config defaults to Date.now.
//   • Scope-gate: requireScope('driftstack_internal_admin') only —
//     no rate-limit (admin tools).
//   • parseOrThrow helper: zod safeParse + BadRequestError.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-cost.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W416.A apps/server/src/routes/admin-cost.ts content parity', () => {
  const body = read(LIB);

  it('V-541.B framing pinned: GET /v1/admin/cost/accounts/:id + overview + driftstack_internal_admin (V-326e6 pattern)', () => {
    expect(body).toMatch(/V-541\.B — admin cost-monitoring routes\./);
    expect(body).toMatch(/GET \/v1\/admin\/cost\/accounts\/:id\?billing_cycle=YYYY-MM/);
    expect(body).toMatch(
      /GET \/v1\/admin\/cost\/overview\?account_ids=a,b,c&billing_cycle=YYYY-MM/,
    );
    expect(body).toMatch(/Auth: driftstack_internal_admin scope \(V-326e6 pattern\)\./);
  });

  it('V-683 framing pinned: config inspector returns wired rate-card + tier thresholds without touching usage', () => {
    expect(body).toMatch(
      /\/\/ V-683 — config inspector\. Returns the wired rate card \+ tier\s*\n?\s*\/\/ thresholds without touching usage data\. Useful for ops to verify\s*\n?\s*\/\/ a deploy \+ for the "what did we ship\?" admin dashboard\./,
    );
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/admin\/cost\/config',\s*\n?\s*\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},\s*\n?\s*\(_req, reply\) => \{\s*\n?\s*return reply\.send\(deps\.service\.getConfig\(\)\);/,
    );
  });

  it('Schemas: AccountSummaryParams id min(1) + both queries share strict billing-cycle authority', () => {
    expect(body).toMatch(
      /const AccountSummaryParams = z\.object\(\{[\s\S]*?id: z\.string\(\)\.min\(1\)\.max\(100\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const AccountSummaryQuery = z\.object\(\{\s*\n?\s*billing_cycle: z\.string\(\)\.regex\(BILLING_CYCLE_PATTERN\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /const OverviewQuery = z\.object\(\{[\s\S]*?account_ids: z\.string\(\)\.min\(1\)\.max\(4096\),\s*\n?\s*billing_cycle: z\.string\(\)\.regex\(BILLING_CYCLE_PATTERN\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('RegisterAdminCostRoutesDeps: service + optional nowFn test seam (default Date.now)', () => {
    expect(body).toMatch(/export interface RegisterAdminCostRoutesDeps \{/);
    expect(body).toMatch(/service: CostMonitoringService;/);
    expect(body).toMatch(
      /\/\*\* Time source — defaults to `Date\.now`\. Test seam\. \*\/\s*\n?\s*nowFn\?: \(\) => number;/,
    );
    expect(body).toMatch(/const now = deps\.nowFn \?\? Date\.now;/);
  });

  it('Account summary: getAccountSummary dispatch + null → 404 NotFoundError (distinct from customer V-541.D synthesis)', () => {
    expect(body).toMatch(
      /const summary = await deps\.service\.getAccountSummary\(\{\s*\n?\s*accountId: bareAccountId\(params\.id\),\s*\n?\s*billingCycle: query\.billing_cycle \?\? billingCycleFromDate\(new Date\(now\(\)\)\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(summary === null\) \{\s*\n?\s*throw new NotFoundError\('Account has no usage in the requested billing cycle\.'\);/,
    );
  });

  it('Overview: account_ids CSV split + trim + filter(Boolean); empty → 400 "account_ids must contain at least one id."', () => {
    expect(body).toMatch(
      /const ids = query\.account_ids\s*\n?\s*\.split\(','\)\s*\n?\s*\.map\(\(s\) => s\.trim\(\)\)\s*\n?\s*\.filter\(Boolean\)\s*\n?\s*\.map\(bareAccountId\);/,
    );
    expect(body).toMatch(
      /if \(ids\.length === 0\) \{\s*\n?\s*throw new BadRequestError\('account_ids must contain at least one id\.'\);/,
    );
    expect(body).toMatch(
      /const summaries = await deps\.service\.getOverview\(\{\s*\n?\s*accountIds: ids,\s*\n?\s*billingCycle: query\.billing_cycle \?\? billingCycleFromDate\(new Date\(now\(\)\)\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/return reply\.send\(\{ summaries \}\);/);
  });

  it("Scope-gate: requireScope('driftstack_internal_admin') only — no rate-limit (admin tools)", () => {
    expect(body).toMatch(/preHandler: \[app\.requireScope\('driftstack_internal_admin'\)\] \},/);
    expect(body).not.toMatch(/admin\/cost.*rateLimit/);
  });

  it('parseOrThrow helper: zod safeParse + BadRequestError(result.error.message)', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*\n?\s*const result = schema\.safeParse\(input\);\s*\n?\s*if \(!result\.success\) throw new BadRequestError\(result\.error\.message\);\s*\n?\s*return result\.data;/,
    );
  });

  it('imports: Fastify + zod + errors + shared cycle authority/service', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{ NotFoundError, BadRequestError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*BILLING_CYCLE_PATTERN,\s*\n?\s*type CostMonitoringService,\s*\n?\s*billingCycleFromDate,\s*\n?\s*\} from '\.\.\/services\/cost-monitoring\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
