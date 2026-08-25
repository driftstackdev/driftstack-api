// W413.B — drift guard for apps/server/src/routes/admin-overview.ts.
// Admin overview — single-roundtrip endpoint for admin panel index
// page (active/suspended/deleted accounts + DLQ depth). Read-only,
// no audit row. V-515 added deleted-account count + computed total.
// Drift here either splits the headline KPIs across endpoints (extra
// roundtrip for the admin panel) or breaks the V-515 total-derivation
// (admin dashboard shows wrong "X of Y accounts active" copy).
//
//   • Framing pinned: single-roundtrip headline counts; read-only; no
//     admin_audit_log row written; leads count deferred until leads
//     endpoint lands (admin /leads page is mock-only today).
//   • Wire path: GET /v1/admin/overview.
//   • Scope-gate: requireScope('driftstack_internal_admin') +
//     rateLimit('global').
//   • V-515 framing pinned: deleted-account count + computed total
//     so admin panel renders "X of Y accounts active" without extra
//     roundtrip.
//   • Counts source: 6-way Promise.all over countByStatus(active|
//     suspended|deleted) + countByTier + signupCounts +
//     webhooksAdmin.countDlq.
//   • Reply shape: {accounts:{active,suspended,deleted,total,by_tier,
//     signups}, webhooks:{dlq_depth}} — total = active+suspended+deleted.
//   • AdminOverviewRoutesOptions: accountsAdmin + webhooksAdmin.
//   • Future-extension framing: response shape will add leads.open
//     when leads tracking gets a Postgres surface.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W413.B apps/server/src/routes/admin-overview.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: single endpoint returning headline counts; read-only; no audit row', () => {
    expect(body).toMatch(
      /Admin overview route — single endpoint returning the headline counts\s*\/\/\s*the admin panel renders on its index page \(active accounts,\s*\/\/\s*suspended accounts, DLQ depth\)\. Read-only; no audit row written\./,
    );
  });

  it('Single-roundtrip rationale pinned: count methods (countByStatus, countDlqDeliveries) keep endpoint single-roundtrip vs iterating list endpoints', () => {
    expect(body).toMatch(
      /Adding individual count methods \(countByStatus, countDlqDeliveries\)\s*\/\/\s*keeps this endpoint single-roundtrip rather than asking the\s*\/\/\s*dashboard to iterate the list endpoints\./,
    );
  });

  it('Future-extension framing: leads.open deferred until leads endpoint lands (admin /leads page mock-only)', () => {
    expect(body).toMatch(
      /Open-leads count is not\s*\/\/\s*included today — leads tracking has no Postgres surface yet \(the\s*\/\/\s*admin \/leads page is mock-only\)\. When the leads endpoint lands,\s*\/\/\s*extend this response with `leads: \{ open: number \}`\./,
    );
  });

  it('AdminOverviewRoutesOptions: accountsAdmin (AccountsAdminService) + webhooksAdmin (WebhooksAdminService)', () => {
    expect(body).toMatch(
      /export interface AdminOverviewRoutesOptions \{\s*accountsAdmin: AccountsAdminService;\s*webhooksAdmin: WebhooksAdminService;\s*\}/,
    );
  });

  it("Wire path + scope-gate: GET /v1/admin/overview + requireScope('driftstack_internal_admin') + rateLimit('global')", () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/admin\/overview',\s*\{\s*preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],\s*\},/,
    );
  });

  it('Account-context invariant: ctx falsy → "account context missing after requireAuth"', () => {
    expect(body).toMatch(/const ctx = request\.account;/);
    expect(body).toMatch(
      /if \(!ctx\) throw new Error\('account context missing after requireAuth'\);/,
    );
  });

  it('V-515 framing pinned: deleted-account count + computed total for "X of Y accounts active" admin panel copy', () => {
    expect(body).toMatch(
      /\/\/ V-515 — also surface deleted-account count \+ computed total\s*\/\/ so the admin panel can show "X of Y accounts active" without\s*\/\/ a second roundtrip\./,
    );
  });

  it('6-way Promise.all: countByStatus active/suspended/deleted + countByTier + signupCounts + countDlq', () => {
    // Individual line pins (no long \s* chain — avoids backtracking hazard).
    expect(body).toMatch(
      /const \[activeAccounts, suspendedAccounts, deletedAccounts, byTier, signups, dlqDepth\] =/,
    );
    expect(body).toMatch(/accountsAdmin\.countByStatus\(ctx, 'active'\),/);
    expect(body).toMatch(/accountsAdmin\.countByStatus\(ctx, 'suspended'\),/);
    expect(body).toMatch(/accountsAdmin\.countByStatus\(ctx, 'deleted'\),/);
    expect(body).toMatch(/accountsAdmin\.countByTier\(ctx\),/);
    expect(body).toMatch(/accountsAdmin\.signupCounts\(ctx, new Date\(\)\),/);
    expect(body).toMatch(/webhooksAdmin\.countDlq\(ctx\),/);
  });

  it('Reply shape: accounts{active,suspended,deleted,total=active+suspended+deleted,by_tier,signups} + webhooks{dlq_depth}', () => {
    expect(body).toMatch(/active: activeAccounts,/);
    expect(body).toMatch(/suspended: suspendedAccounts,/);
    expect(body).toMatch(/deleted: deletedAccounts,/);
    expect(body).toMatch(/total: activeAccounts \+ suspendedAccounts \+ deletedAccounts,/);
    expect(body).toMatch(/by_tier: byTier,/);
    expect(body).toMatch(/signups,/);
    expect(body).toMatch(/dlq_depth: dlqDepth,/);
  });

  it('imports: FastifyInstance + AccountsAdminService + WebhooksAdminService types', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ AccountsAdminService \} from '\.\.\/services\/admin-accounts\.js';/,
    );
    expect(body).toMatch(
      /import type \{ WebhooksAdminService \} from '\.\.\/services\/webhooks\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
