// W414.B — drift guard for apps/server/src/routes/account-cost.ts.
// V-541.D customer-facing /v1/account/cost — scoped to calling account
// (ctx.account.id) reusing the admin V-541.B service. Drift here
// either leaks operator-tuned thresholds to customers (admin-only
// config) or 404s a fresh account with no usage (customer should see
// "spent €0 this cycle", not "not found").
//
//   • V-541.D framing pinned: customer-facing surface; service reused
//     from admin V-541.B; account id pinned to ctx.account.id not URL.
//   • billing_cycle uses the shared strict calendar-cycle authority (optional; defaults
//     to billingCycleFromDate(now)).
//   • Null-summary policy pinned: fresh-account zero-breakdown reply
//     (NOT 404) — "spent €0 this cycle" customer-facing copy
//     rationale; threshold_state: 'under-soft'.
//   • Customer-surface policy pinned: omit operator-tuned threshold
//     values (admin-only configuration; customers see only actual
//     spend, not numeric caps).
//   • Test seam: nowFn config defaults to Date.now.
//   • Auth + rate-limit: requireAuth + rateLimit('global').
//   • parseOrThrow helper: BadRequestError on zod fail.
//   • NotFoundError void reference held for V-541.E hook (explicit
//     "account exists, no data" distinction — not currently routed).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-cost.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W414.B apps/server/src/routes/account-cost.ts content parity', () => {
  const body = read(LIB);

  it('V-541.D framing pinned: customer-facing GET /v1/account/cost?billing_cycle=YYYY-MM; service reused from admin V-541.B; account id pinned to ctx', () => {
    expect(body).toMatch(/V-541\.D — customer-facing cost surface\./);
    expect(body).toMatch(/GET \/v1\/account\/cost\?billing_cycle=YYYY-MM/);
    expect(body).toMatch(
      /Scoped to the calling account via requireAuth — the service is\s*\/\/\s*reused from the admin path \(V-541\.B\) but the account id is pinned\s*\/\/\s*to ctx\.account\.id, not pulled from a URL param\./,
    );
  });

  it('Query zod schema: shared strict billing-cycle authority + optional', () => {
    expect(body).toMatch(
      /const Query = z\.object\(\{\s*billing_cycle: z\.string\(\)\.regex\(BILLING_CYCLE_PATTERN\)\.optional\(\),\s*\}\);/,
    );
  });

  it('RegisterAccountCostRoutesDeps: service + optional nowFn test seam (default Date.now)', () => {
    expect(body).toMatch(/export interface RegisterAccountCostRoutesDeps \{/);
    expect(body).toMatch(/service: CostMonitoringService;/);
    expect(body).toMatch(
      /\/\*\* Test seam\. Defaults to Date\.now\. \*\/\s*nowFn\?: \(\) => number;/,
    );
    expect(body).toMatch(/const now = deps\.nowFn \?\? Date\.now;/);
  });

  it("Auth posture: requireAuth + read:billing scope + rateLimit('global') preHandler (#122)", () => {
    expect(body).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:billing'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('Account id pinned to ctx.account.id; billing_cycle fallback via billingCycleFromDate(new Date(now()))', () => {
    expect(body).toMatch(/const ctx = request\.account;/);
    expect(body).toMatch(
      /const summary = await deps\.service\.getAccountSummary\(\{\s*accountId: ctx\.account\.id,\s*billingCycle: query\.billing_cycle \?\? billingCycleFromDate\(new Date\(now\(\)\)\),\s*\}\);/,
    );
  });

  it('Null-summary policy: fresh-account zero breakdown (NOT 404) with thresholdState under-soft as const', () => {
    expect(body).toMatch(
      /if \(summary === null\) \{\s*\/\/ Not 404 — for a fresh account with no usage in the cycle the\s*\/\/ customer should see "you've spent €0 this cycle", not "not\s*\/\/ found"\. Synthesize a zero breakdown response\./,
    );
    // S46 2026-07-07 (founder-approved) — account_id now carries the canonical
    // acc_ prefix (mirrors GET /v1/account/me); the S46 comment lines sit
    // between reply.send({ and the field, hence the comment-skipping group.
    expect(body).toMatch(
      /return reply\.send\(\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*account_id: `acc_\$\{ctx\.account\.id\}`,\s*billing_cycle: query\.billing_cycle \?\? billingCycleFromDate\(new Date\(now\(\)\)\),\s*tier: ctx\.account\.tier,\s*breakdown: \{\s*computeCents: 0,\s*storageCents: 0,\s*egressCents: 0,\s*emailCents: 0,\s*llmCents: 0,\s*totalCents: 0,\s*thresholdState: 'under-soft' as const,\s*\},\s*\}\);/,
    );
  });

  it('Customer-surface policy: omit operator-tuned threshold values (admin-only); customers see only their actual spend', () => {
    expect(body).toMatch(
      /\/\/ Customer surface omits the operator-tuned threshold values\s*\/\/ \(those are admin-only configuration; we don't surface the\s*\/\/ numeric caps to customers — they see only their actual spend\)\./,
    );
    // S46 2026-07-07 — acc_ prefix on the populated branch too.
    expect(body).toMatch(
      /return reply\.send\(\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*account_id: `acc_\$\{summary\.account_id\}`,\s*billing_cycle: summary\.billing_cycle,\s*tier: summary\.tier,\s*breakdown: summary\.breakdown,\s*\}\);/,
    );
  });

  it('V-541.E hook: void NotFoundError; reserved for explicit "account exists, no data" distinction', () => {
    expect(body).toMatch(
      /\/\/ Make the 404 reachable explicitly for clients that want to\s*\/\/ distinguish "account exists, no data" from "account doesn't\s*\/\/ exist"\. Not currently routed; left as a hook for V-541\.E\s*\/\/ detailed-view scope\./,
    );
    expect(body).toMatch(/void NotFoundError;/);
  });

  it('parseOrThrow helper: zod safeParse + a fixed BadRequestError message (no raw zod JSON leaked into the customer problem detail)', () => {
    expect(body).toMatch(
      /function parseOrThrow<T>\(schema: z\.ZodSchema<T>, input: unknown\): T \{\s*const result = schema\.safeParse\(input\);/,
    );
    expect(body).toContain(
      "if (!result.success) throw new BadRequestError('Invalid query: billing_cycle must be YYYY-MM.');",
    );
    expect(body).not.toMatch(/BadRequestError\(result\.error\.message\)/);
  });

  it('imports: Fastify + zod + shared cycle authority/service + errors', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{\s*BILLING_CYCLE_PATTERN,\s*type CostMonitoringService,\s*billingCycleFromDate,\s*\} from '\.\.\/services\/cost-monitoring\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
