// W862 — AdminAuditAction 33-value cross-source invariant. One-
// hundred-eighty-eighth in the drift-guard series. Pins the
// admin-audit closed-action roster:
//
//   Lifecycle (4): account.tier_changed + account.suspended +
//                  account.unsuspended + account.deleted.
//   Operational (5): webhook_delivery.replayed +
//                    webhook_delivery.requeued +
//                    webhook_delivery.discarded +
//                    rate_limit_override.set +
//                    rate_limit_override.cleared.
//   V-100 force-actions (2): session.destroyed_by_admin +
//                            api_key.revoked_by_admin.
//   V-281 support (2): audit_note.added + refund.recorded.
//   V-295a incidents (4): incident.created + incident.updated +
//                         incident.resolved + incident.reopened.
//   V-295c3 status-subscribers (3): status_subscriber.force_
//                                  unsubscribed + status_subscriber.purged +
//                                  status_subscriber.force_subscribed.
//   LK.2 mac-node (2): mac_node.livekit_registered + mac_node.control.
//   Pricing (1): pricing.updated.
//   Secrets (4, migration 0075): secret.created/updated/deleted/revealed.
//   D-025 audit-gap fix (6, migration 0097): crypto_order.swept +
//   crypto_order.ipn_applied + crypto_order.note_updated +
//   validation_schedule.upserted + validation_schedule.removed +
//   validation_schedule.triggered — admin-crypto-orders.ts and
//   admin-validation-harness.ts had zero audit wiring on their 6 mutating
//   endpoints.
//   GDPR Article 17 (1, migration 0094): account.deleted — admin-triggered
//   account termination.
//
// 2026-08-27 — title corrected 21 → 33. The GROUPS above were current the whole
// time; only this line rotted, which is why the count assertions below stayed
// green. Two things make the group list look like it disagrees: `account.deleted`
// is listed TWICE on purpose (under Lifecycle and again under its GDPR anchor),
// and the Secrets row writes four values in slash form
// (`secret.created/updated/deleted/revealed`). 34 mentions, 33 distinct.
//
// 2026-06-04 — corrected from 16 → 20: migrations 0057/0061/0062/0063
// had added the last value of operational/incident/subscriber + the
// mac-node action to the pgEnum + the server AdminAuditAction union,
// but api-types AdminAuditActionSchema (this enum's canonical source)
// was never updated, so the admin audit-log filter rejected those 4
// actions and the SDK/openapi response type omitted them. The pgEnum
// assertion below is a SUBSET check (it allows the DB to lead), which
// is why the drift went uncaught; the api-types assertion is EXACT.
//
// stays in lockstep across:
//   - packages/api-types/src/admin.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
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
  'webhook_delivery.discarded',
  'rate_limit_override.set',
  'rate_limit_override.cleared',
  'session.destroyed_by_admin',
  'api_key.revoked_by_admin',
  'audit_note.added',
  'refund.recorded',
  'incident.created',
  'incident.updated',
  'incident.resolved',
  'incident.reopened',
  'status_subscriber.force_unsubscribed',
  'status_subscriber.purged',
  'status_subscriber.force_subscribed',
  'mac_node.livekit_registered',
  'mac_node.control',
  'pricing.updated',
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.revealed',
  'crypto_order.swept',
  'crypto_order.ipn_applied',
  'crypto_order.note_updated',
  'validation_schedule.upserted',
  'validation_schedule.removed',
  'validation_schedule.triggered',
  'account.deleted',
] as const;

describe('W862 AdminAuditAction cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/admin.ts AdminAuditActionSchema = z.enum([33 values]). The 33-value closed-roster is the contract every admin audit-log gate pivots on.', () => {
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

  it("CRITICAL apps/server/src/db/schema.ts adminAuditAction = pgEnum('admin_audit_action', [33 values]). Postgres rejects INSERTs of unknown values — drift would silently DROP the audit row (compliance/forensics gap).", () => {
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
    // 2026-06-05 anti-recurrence — the pgEnum must contain NO value beyond the
    // roster this file pins above (there are no internal-only admin actions:
    // every admin_audit_action is
    // written to a customer-visible audit row + must be filterable). A prior
    // subset-only check here let the DB enum lead api-types silently — migrations
    // 0057/0061/0062/0063 added 4 values the canonical schema lacked, breaking the
    // audit-log filter (fixed a50151db). This EXACT-set pin makes that drift class
    // (a pgEnum value with no api-types counterpart) fail loudly. See
    // [[project_admin_audit_action_enum_drift_fixed]].
    const pgValues = ((body ?? '').match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
    expect(new Set(pgValues)).toEqual(new Set(ADMIN_AUDIT_ACTIONS));
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

  it('CRITICAL AdminAuditAction = EXACTLY 33 values across 11 categories — 4 lifecycle + 5 operational + 2 V-100 force + 2 V-281 support + 4 V-295a incident + 3 V-295c3 subscriber + 2 mac-node + 1 pricing + 4 secrets + 3 crypto-order + 3 validation-schedule. The split is what the audit-log filter dropdown groups by. (2026-06-05: +pricing.updated, migration 0068. 2026-06-12: +secret.created/updated/deleted/revealed, migration 0075. 2026-06-18: +mac_node.control for the fleet-admin node-control panel, migration 0084. 2026-07-01: +account.deleted for GDPR Article 17 admin-triggered account termination, migration 0094 — lifecycle grows from 3 to 4. 2026-07-01 D-025 audit-gap fix, migration 0097: +crypto_order.swept/ipn_applied/note_updated + validation_schedule.upserted/removed/triggered — admin-crypto-orders.ts + admin-validation-harness.ts had zero audit wiring on 6 mutating endpoints.)', () => {
    expect(ADMIN_AUDIT_ACTIONS.length).toBe(33);
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
    const macNode = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('mac_node.'));
    const pricing = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('pricing.'));
    const secrets = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('secret.'));
    const cryptoOrder = ADMIN_AUDIT_ACTIONS.filter((a) => a.startsWith('crypto_order.'));
    const validationSchedule = ADMIN_AUDIT_ACTIONS.filter((a) =>
      a.startsWith('validation_schedule.'),
    );
    expect(lifecycle.length).toBe(4);
    expect(operational.length).toBe(5);
    expect(force.length).toBe(2);
    expect(support.length).toBe(2);
    expect(incident.length).toBe(4);
    expect(subscriber.length).toBe(3);
    expect(macNode.length).toBe(2);
    expect(pricing.length).toBe(1);
    expect(secrets.length).toBe(4);
    expect(cryptoOrder.length).toBe(3);
    expect(validationSchedule.length).toBe(3);
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
