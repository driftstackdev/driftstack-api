// W1018 — routes/admin-overview V-515 cross-source invariant. Three-
// hundred-forty-fourth in the drift-guard series. Pins the apps/
// server/src/routes/admin-overview.ts admin-headline-counts route:
//
//   Header — 'Admin overview route — single endpoint returning the
//   headline counts the admin panel renders on its index page
//   (active accounts, suspended accounts, DLQ depth). Read-only; no
//   audit row written'.
//
//   Single-roundtrip framing — 'Adding individual count methods
//   (countByStatus, countDlqDeliveries) keeps this endpoint
//   single-roundtrip rather than asking the dashboard to iterate the
//   list endpoints'.
//
//   Open-leads framing — 'Open-leads count is not included today —
//   leads tracking has no Postgres surface yet (the admin /leads
//   page is mock-only). When the leads endpoint lands, extend this
//   response with leads: { open: number }'.
//
//   V-515 framing — 'V-515 — also surface deleted-account count +
//   computed total so the admin panel can show X of Y accounts
//   active without a second roundtrip'.
//
//   Endpoint — GET /v1/admin/overview + preHandler [requireScope
//     ('driftstack_internal_admin'), rateLimit('global')].
//
//   4 parallel counts via Promise.all — active + suspended + deleted
//     status counts + DLQ depth.
//
//   Response shape — { accounts: {active, suspended, deleted, total},
//     webhooks: {dlq_depth} }.
//
//   total = active + suspended + deleted (no separate query).
//
// stays in lockstep across apps/server/src/routes/admin-overview.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1018 routes/admin-overview V-515 cross-source invariant', () => {
  it("CRITICAL header — 'Admin overview route — single endpoint returning the headline counts the admin panel renders on its index page (active accounts, suspended accounts, DLQ depth). Read-only; no audit row written'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/\/\/ Admin overview route — single endpoint returning the headline counts/);
    expect(p).toMatch(/\/\/ the admin panel renders on its index page \(active accounts,/);
    expect(p).toMatch(/\/\/ suspended accounts, DLQ depth\)\. Read-only; no audit row written\./);
  });

  it("CRITICAL single-roundtrip framing — 'Adding individual count methods (countByStatus, countDlqDeliveries) keeps this endpoint single-roundtrip rather than asking the dashboard to iterate the list endpoints'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/\/\/ Adding individual count methods \(countByStatus, countDlqDeliveries\)/);
    expect(p).toMatch(/\/\/ keeps this endpoint single-roundtrip rather than asking the/);
    expect(p).toMatch(/\/\/ dashboard to iterate the list endpoints\./);
  });

  it("CRITICAL open-leads-deferred framing — 'Open-leads count is not included today — leads tracking has no Postgres surface yet (the admin /leads page is mock-only). When the leads endpoint lands, extend this response with leads: { open: number }'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/Open-leads count is not/);
    expect(p).toMatch(/included today — leads tracking has no Postgres surface yet \(the/);
    expect(p).toMatch(/admin \/leads page is mock-only\)\. When the leads endpoint lands,/);
    expect(p).toMatch(/extend this response with `leads: \{ open: number \}`\./);
  });

  it("CRITICAL V-515 framing — 'V-515 — also surface deleted-account count + computed total so the admin panel can show X of Y accounts active without a second roundtrip'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/\/\/ V-515 — also surface deleted-account count \+ computed total/);
    expect(p).toMatch(/\/\/ so the admin panel can show "X of Y accounts active" without/);
    expect(p).toMatch(/\/\/ a second roundtrip\./);
  });

  it("CRITICAL endpoint + preHandler — GET /v1/admin/overview + [requireScope('driftstack_internal_admin'), rateLimit('global')].", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/app\.get\(/);
    expect(p).toMatch(/'\/v1\/admin\/overview',/);
    expect(p).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
  });

  it('CRITICAL 4-parallel-counts via Promise.all — active + suspended + deleted + DLQ depth.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(
      /const \[activeAccounts, suspendedAccounts, deletedAccounts, dlqDepth\] = await Promise\.all\(\[/,
    );
    expect(p).toMatch(/accountsAdmin\.countByStatus\(ctx, 'active'\),/);
    expect(p).toMatch(/accountsAdmin\.countByStatus\(ctx, 'suspended'\),/);
    expect(p).toMatch(/accountsAdmin\.countByStatus\(ctx, 'deleted'\),/);
    expect(p).toMatch(/webhooksAdmin\.countDlq\(ctx\),/);
  });

  it('CRITICAL response envelope — { accounts: {active, suspended, deleted, total}, webhooks: {dlq_depth} } + total = active+suspended+deleted (no separate query).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-overview.ts'));
    expect(p).toMatch(/active: activeAccounts,/);
    expect(p).toMatch(/suspended: suspendedAccounts,/);
    expect(p).toMatch(/deleted: deletedAccounts,/);
    expect(p).toMatch(/total: activeAccounts \+ suspendedAccounts \+ deletedAccounts,/);
    expect(p).toMatch(/dlq_depth: dlqDepth,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-overview-v515-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
