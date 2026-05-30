// W862 — AdminAuditAction 16-value cross-source invariant. One-
// hundred-eighty-eighth in the drift-guard series. Pins the
// admin-audit closed-action roster:
//
//   Lifecycle (3): account.tier_changed + account.suspended +
//                  account.unsuspended.
//   Operational (4): webhook_delivery.replayed +
//                    webhook_delivery.requeued +
//                    rate_limit_override.set +
//                    rate_limit_override.cleared.
//   V-100 force-actions (2): session.destroyed_by_admin +
//                            api_key.revoked_by_admin.
//   V-281 support (2): audit_note.added + refund.recorded.
//   V-295a incidents (3): incident.created + incident.updated +
//                         incident.resolved.
//   V-295c3 status-subscribers (2): status_subscriber.force_
//                                  unsubscribed + status_subscriber.purged.
//
// stays in lockstep across:
//   - packages/api-types/src/admin.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - apps/admin-panel/src/data/mocks.ts (mock-mode refs).
//
// The admin audit log is an append-only audit trail; pgEnum
// rejection of an unknown action would silently drop the audit
// row. Drift would create a gap in the audit history — a
// compliance / forensics problem.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ADMIN_AUDIT_ACTIONS = [
  'account.tier_changed',
  'account.suspended',
  'account.unsuspended',
  'webhook_delivery.replayed',
  'webhook_delivery.requeued',
  'rate_limit_override.set',
  'rate_limit_override.cleared',
  'session.destroyed_by_admin',
  'api_key.revoked_by_admin',
  'audit_note.added',
  'refund.recorded',
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'status_subscriber.force_unsubscribed',
  'status_subscriber.purged',
] as const;

describe('W862 AdminAuditAction cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/admin.ts AdminAuditActionSchema = z.enum([16 values]). The 16-value closed-roster is the contract every admin audit-log gate pivots on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/export const AdminAuditActionSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 16-value set, not merely
    // contain it — a 17th admin action (this enum GROWS with every new admin
    // endpoint) would silently pass the body-subset check below, the same weak
    // pattern that let the WebhookEventType roster drift out of the Go SDK.
    expect(AdminAuditActionSchema.options).toEqual([...ADMIN_AUDIT_ACTIONS]);
    const m = p.match(/AdminAuditActionSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'AdminAuditActionSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const a of ADMIN_AUDIT_ACTIONS) {
      expect(body, `AdminAuditActionSchema must include '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}'`),
      );
    }
  });

  it('CRITICAL AdminAuditAction type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/export type AdminAuditAction = z\.infer<typeof AdminAuditActionSchema>;/);
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts adminAuditAction = pgEnum('admin_audit_action', [16 values]). Postgres rejects INSERTs of unknown values — drift would silently DROP the audit row (compliance/forensics gap).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/adminAuditAction = pgEnum\('admin_audit_action', \[/);
    const m = p.match(/adminAuditAction = pgEnum\('admin_audit_action', \[([\s\S]+?)\]\);/);
    expect(m, 'adminAuditAction pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const a of ADMIN_AUDIT_ACTIONS) {
      expect(body, `pgEnum must include '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}'`),
      );
    }
  });

  // ─── V-anchor traceability ───────────────────────────────────

  it('CRITICAL V-100 + V-281 + V-295a + V-295c3-tombstone anchors pinned in api-types/admin.ts as inline section dividers. The anchors thread provenance for the action-roster expansion across feature work.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/V-100: force actions on customer resources/);
    expect(p).toMatch(/V-281: customer-support tooling \(audit-only\)/);
    expect(p).toMatch(/V-295a: status-page incident management/);
    expect(p).toMatch(/V-295c3-tombstone: status-page email subscriber admin actions/);
  });

  // ─── DB pgEnum has matching V-anchor comments ────────────────

  it('CRITICAL DB schema pgEnum mirror has the SAME 4 V-anchor section comments — V-100 + V-281 + V-295a + V-295c3-tombstone. The mirrored anchors keep the schema readable + cross-linkable to api-types.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    // Extract just the adminAuditAction block.
    const m = p.match(/adminAuditAction = pgEnum[\s\S]+?\]\);/);
    expect(m).not.toBeNull();
    const body = m![0];
    expect(body).toMatch(/V-100: admin force-actions on customer resources/);
    expect(body).toMatch(/V-281: customer-support tooling/);
    expect(body).toMatch(/V-295a: status-page incident management/);
    expect(body).toMatch(/V-295c3-tombstone: status-page email subscriber admin actions/);
  });

  // ─── 16-value cardinality + 6-category split ─────────────────

  it('CRITICAL AdminAuditAction = EXACTLY 16 values across 6 categories — 3 lifecycle + 4 operational + 2 V-100 force + 2 V-281 support + 3 V-295a incident + 2 V-295c3 subscriber. The 3/4/2/2/3/2 split is what the audit-log filter dropdown groups by.', () => {
    expect(ADMIN_AUDIT_ACTIONS.length).toBe(16);
    const lifecycle = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('account.'));
    const operational = ADMIN_AUDIT_ACTIONS.filter(
      (a) => a.startsWith('webhook_delivery.') || a.startsWith('rate_limit_override.'),
    );
    const force = ADMIN_AUDIT_ACTIONS.filter((a) => a.endsWith('_by_admin'));
    const support = ADMIN_AUDIT_ACTIONS.filter(
      (a) => a === 'audit_note.added' || a === 'refund.recorded',
    );
    const incident = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('incident.'));
    const subscriber = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('status_subscriber.'));
    expect(lifecycle.length).toBe(3);
    expect(operational.length).toBe(4);
    expect(force.length).toBe(2);
    expect(support.length).toBe(2);
    expect(incident.length).toBe(3);
    expect(subscriber.length).toBe(2);
  });

  // ─── Verb:resource naming convention ─────────────────────────

  it("CRITICAL all 16 actions follow the 'resource.verb' naming convention (account.tier_changed, session.destroyed_by_admin, etc.). The dot-delimiter is what audit-log filter parsing depends on. Drift to a different separator (slash, dash, underscore-only) would break filter UIs.", () => {
    for (const a of ADMIN_AUDIT_ACTIONS) {
      expect(a, `Action '${a}' must contain a dot separator`).toMatch(/\./);
      const [resource, verb] = a.split('.');
      expect(
        resource && verb,
        `Action '${a}' must have non-empty resource + verb parts`,
      ).toBeTruthy();
    }
  });

  // ─── Admin-panel mocks reference subset ──────────────────────

  it("CRITICAL apps/admin-panel/src/data/mocks.ts references at least 2 of the 16 actions in mock-mode audit rows ('account.tier_changed' + 'session.destroyed_by_admin'). The mock-mode audit-log UI must render canonical action strings — drift would render rows the production schema would reject.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/admin-panel/src/data/mocks.ts'));
    expect(p).toMatch(/action: 'account\.tier_changed'/);
    expect(p).toMatch(/action: 'session\.destroyed_by_admin'/);
  });

  // ─── ListAuditLogQuery exposes action filter ─────────────────

  it('CRITICAL packages/api-types/src/admin.ts ListAuditLogQuerySchema exposes action: AdminAuditActionSchema.optional() — admin audit-log filter UI pivots on this typed filter. Drift to a loose string would silently let admins filter on actions that never produce results.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/action: AdminAuditActionSchema\.optional\(\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/admin-audit-action-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
