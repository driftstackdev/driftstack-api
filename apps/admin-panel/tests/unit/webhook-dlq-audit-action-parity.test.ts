// W318.C — drift guard for admin webhook-DLQ audit narrative. The
// DLQ page promises a requeue mutation writes an admin audit row.
// The action label on the server is 'webhook_delivery.requeued'.
// Catches drift if either side renames or the route stops auditing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/webhook-dlq.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-webhooks.ts');
const AUDIT = resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W318.C admin /webhook-dlq audit-action parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const audit = read(AUDIT);

  it('AdminAuditAction enum carries webhook_delivery.requeued', () => {
    expect(audit).toContain("'webhook_delivery.requeued'");
  });

  it('admin-webhooks route uses the canonical webhook_delivery.requeued action label', () => {
    expect(route).toMatch(/webhook_delivery\.requeued/);
  });

  it('DLQ page narrative confirms an admin audit row is written on requeue', () => {
    expect(page).toMatch(/[Aa]udit row records/);
  });

  it('DLQ page promises a delivery resets to attempt=1 + retry budget refresh on requeue', () => {
    expect(page).toMatch(/attempt\s*=\s*1/);
    expect(page).toMatch(/retry budget/i);
  });
});
