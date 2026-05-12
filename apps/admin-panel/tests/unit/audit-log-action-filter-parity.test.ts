// W345.C — drift guard for the admin /audit-log page. The page
// advertises specific admin-audit actions in its filter placeholder
// + lifecycle footnote. Pins:
//
//   • The placeholder action example (account.tier_changed) is a
//     real AdminAuditActionSchema value.
//   • The endpoint+filter shape (/v1/admin/audit-log?action=&
//     admin_id=&limit=50) matches what ListAuditLogQuerySchema
//     accepts server-side.
//   • The 90-day retention + JSON-Lines export claim stays pinned
//     (ADR-006).
//   • Result-only filtering happens client-side (the endpoint
//     doesn't accept a `result` query param yet) — pin this
//     posture so a future server addition doesn't silently leave
//     the dual-path code in place.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');
const SCHEMA = resolve(REPO_ROOT, 'packages/api-types/src/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W345.C admin /audit-log filter + lifecycle parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const schemaSrc = read(SCHEMA);
  const schemaValues = new Set<string>(
    (AdminAuditActionSchema._def as { values: readonly string[] }).values,
  );

  it('placeholder example action (account.tier_changed) is a real AdminAuditAction', () => {
    expect(page).toMatch(/account\.tier_changed/);
    expect(schemaValues.has('account.tier_changed')).toBe(true);
  });

  it('schema is non-trivially large (canary)', () => {
    expect(schemaValues.size).toBeGreaterThanOrEqual(15);
  });

  it('page hits GET /v1/admin/audit-log and the server registers it', () => {
    expect(page).toMatch(/\/v1\/admin\/audit-log/);
    expect(route).toContain("'/v1/admin/audit-log'");
  });

  it('page sends action + admin_id + limit query params (matches ListAuditLogQuerySchema)', () => {
    expect(page).toMatch(/params\.set\('action',/);
    expect(page).toMatch(/params\.set\('admin_id',/);
    expect(page).toMatch(/params\.set\('limit', '50'\)/);
    // Server schema declares these three fields explicitly.
    expect(schemaSrc).toMatch(/action: AdminAuditActionSchema/);
    expect(schemaSrc).toMatch(/admin_id/);
  });

  it('result-only filtering is client-side (server schema does not accept result yet)', () => {
    // Catches a future server addition that should remove the
    // client-side filter pass.
    expect(page).toMatch(/entries\.filter\(\(e\) => e\.result === resultFilter\)/);
    expect(schemaSrc).not.toMatch(/result:\s*z\.enum/);
  });

  it('footnote pins 90-day hot retention + JSON-Lines export (ADR-006)', () => {
    expect(page).toMatch(/Retention 90 days hot in Postgres/);
    expect(page).toMatch(/ADR-006/);
    expect(page).toMatch(/\?format=jsonl/);
  });

  it('append-only + admin-immutability framing (D-025) is preserved', () => {
    expect(page).toMatch(/Append-only/);
    expect(page).toMatch(/Cannot be mutated by admins/);
    expect(page).toMatch(/D-025/);
  });

  it('result badge uses emerald for success / red for error (semantic colour)', () => {
    expect(page).toMatch(
      /'success'\s*\?\s*'bg-emerald-50 text-emerald-700'\s*:\s*'bg-red-50 text-red-700'/,
    );
  });

  it('result filter dropdown lists exactly {empty, success, error} (matches MockAdminAuditEntry.result)', () => {
    const opts = [...page.matchAll(/<option value="([a-z]*)">/g)].map((m) => m[1]!).sort();
    expect(opts).toEqual(['', 'error', 'success']);
  });
});
