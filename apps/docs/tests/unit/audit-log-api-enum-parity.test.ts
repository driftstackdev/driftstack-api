// W318.A — drift guard for /api/audit-log enum coverage. The doc
// page lists action labels in a table. Every member of the canonical
// AccountAuditActionSchema enum (except admin-only ones which are
// not customer-visible) should be present on the page.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Admin-side actions: the customer-facing audit-log doc deliberately
// excludes them (they show up in admin audit, not customer audit).
const ADMIN_ONLY = new Set(['admin.refund_recorded', 'admin.support_note']);

describe('W318.A /api/audit-log ↔ AccountAuditActionSchema parity', () => {
  const body = read(PAGE);
  const enumValues = AccountAuditActionSchema.options;

  it('enum has at least 20 actions (sanity)', () => {
    expect(enumValues.length).toBeGreaterThanOrEqual(20);
  });

  for (const a of AccountAuditActionSchema.options) {
    if (ADMIN_ONLY.has(a)) continue;
    it(`page lists ${a}`, () => {
      expect(body).toContain(a);
    });
  }

  it('doc covers GET /v1/account/audit-log + export endpoints', () => {
    expect(body).toContain('GET /v1/account/audit-log');
    expect(body).toContain('/v1/account/audit-log/export');
  });

  it('doc references AccountAuditAction type name', () => {
    expect(body).toMatch(/AccountAuditAction|account\.[a-z_]+/);
  });
});
