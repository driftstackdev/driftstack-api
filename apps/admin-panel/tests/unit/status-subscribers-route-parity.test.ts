// W322.C — drift guard for admin /status-subscribers page. The
// page calls:
//   GET  /v1/admin/status-subscribers
//   POST /v1/admin/status-subscribers/:id/force-unsubscribe
// Both must be registered on the server. The force-unsubscribe
// audit action 'status_subscriber.force_unsubscribed' is in the
// AdminAuditAction enum.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/status-subscribers.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts');
const AUDIT = resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W322.C admin /status-subscribers ↔ route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const audit = read(AUDIT);

  it('page calls GET /v1/admin/status-subscribers', () => {
    expect(page).toContain('/v1/admin/status-subscribers');
  });

  it('page calls force-unsubscribe action', () => {
    expect(page).toMatch(
      /\/v1\/admin\/status-subscribers\/[^'"`]*force-unsubscribe|['"`]\/force-unsubscribe['"`]/,
    );
  });

  it('server registers GET /v1/admin/status-subscribers', () => {
    expect(route).toContain("'/v1/admin/status-subscribers'");
  });

  it('server registers POST /v1/admin/status-subscribers/:id/force-unsubscribe', () => {
    expect(route).toContain("'/v1/admin/status-subscribers/:id/force-unsubscribe'");
  });

  it('AdminAuditAction enum carries status_subscriber.force_unsubscribed', () => {
    expect(audit).toContain("'status_subscriber.force_unsubscribed'");
  });
});
