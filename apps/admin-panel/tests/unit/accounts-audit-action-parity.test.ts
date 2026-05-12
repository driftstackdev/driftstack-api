// W333.C — drift guard for admin accounts page audit-action parity.
// The admin /accounts/[id] page narrates that tier change, suspend,
// unsuspend, audit-note, and refund-record all leave an audit row.
// Each route in admin-accounts.ts must invoke withAudit() with the
// canonical AdminAuditAction label. The AdminAuditAction enum carries
// all five.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');
const AUDIT = resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts');

const REQUIRED_ACTIONS = [
  'account.tier_changed',
  'account.suspended',
  'account.unsuspended',
  'audit_note.added',
  'refund.recorded',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W333.C admin accounts ↔ audit-action parity', () => {
  const route = read(ROUTE);
  const audit = read(AUDIT);

  for (const action of REQUIRED_ACTIONS) {
    it(`AdminAuditAction enum carries '${action}'`, () => {
      expect(audit).toContain(`'${action}'`);
    });

    it(`admin-accounts route invokes the '${action}' action`, () => {
      expect(route).toContain(`'${action}'`);
    });
  }
});
