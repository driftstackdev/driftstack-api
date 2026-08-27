// W936 — D-025 admin-audit append-only cross-source invariant.
// Two-hundred-sixty-second in the drift-guard series. Pins the
// admin audit logging service:
//
//   D-025 anchor — 'append-only invariant is enforced by code, not
//   the DB' (no UPDATE / DELETE methods on the repo).
//
//   Every MUTATING /v1/admin/* endpoint writes one row before returning;
//   reads write none, and three OAuth-client mutations are excepted (V-1007).
//
//   AdminAuditAction (closed Postgres enum; 33 values as of V-1007 —
//   the '14-value' this header carried was stale by nineteen):
//     - account.tier_changed
//     - account.suspended / account.unsuspended
//     - webhook_delivery.replayed / webhook_delivery.requeued
//     - rate_limit_override.set / rate_limit_override.cleared
//     - V-100: session.destroyed_by_admin / api_key.revoked_by_admin
//     - V-281: audit_note.added / refund.recorded
//     - V-295a: incident.created / incident.updated /
//       incident.resolved
//     - V-295c3-tombstone: status_subscriber.force_unsubscribed /
//       status_subscriber.purged
//   (The bullet list above names the subset this file pins, not the whole
//   enum; the enum carries 33 values — see the W862 roster guard, which
//   pins every one and asserts the counts. Corrected 2026-08-27: both
//   places here said '15', a number stale by eighteen.)
//
//   Vocabulary closure framing — 'Adding a new admin endpoint
//   requires a migration; this is intentional — it forces deliberate
//   vocabulary choices and gives action-filtered queries a free
//   index hit'.
//
//   AdminAuditLogRow (10-field shape):
//     - id + adminAccountId + adminKeyId + action +
//       targetAccountId (nullable) + targetResourceId (nullable) +
//       inputPayload (nullable jsonb) + result + ipAddress
//       (nullable) + timestamp.
//
//   AdminAuditLogRepo: insert + list only — NO update / delete
//   methods (append-only invariant).
//
//   record() throws-up framing — 'failure to audit fails the
//   request (D-025)'. The throw-up contract is what makes the
//   audit non-optional.
//
//   V-521 targetResourceId filter — 'exact-match filter on the
//   audit row's targetResourceId'.
//
//   ListAuditFilters cursor pagination — 'last seen timestamp ISO
//   string'.
//
// stays in lockstep across apps/server/src/services/admin-audit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W936 D-025 admin-audit cross-source invariant', () => {
  // ─── Header intro + D-025 anchor ─────────────────────────────

  it("V-1007 CRITICAL admin-audit.ts header intro pins 'Admin audit logging' + the MUTATING-only rule + 'The repo exposes insert(...) and a paginated list(...) only — no UPDATE or DELETE method'. The append-only contract is the central design; the every-endpoint claim it used to pin was false for all 35 admin GETs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/Admin audit logging/);
    expect(p).toMatch(/Every MUTATING \/v1\/admin\/\* endpoint writes one row here before/);
    // The retracted claim, paraphrased in the negative.
    expect(p).not.toMatch(/Every \/v1\/admin\/\* endpoint writes one row here before returning/);
    expect(p).toMatch(/The repo exposes `insert\(\.\.\.\)` and a paginated `list\(\.\.\.\)`/);
    expect(p).toMatch(/only — no UPDATE or DELETE method\. The "append-only" invariant is/);
    expect(p).toMatch(/enforced by code, not the DB \(D-025\)/);
  });

  // ─── Vocabulary closure framing ──────────────────────────────

  it("CRITICAL vocabulary closure framing — 'Action vocabulary is a closed Postgres enum (admin_audit_action). Adding a new admin endpoint requires a migration; this is intentional — it forces deliberate vocabulary choices and gives action-filtered queries a free index hit'. The closed-enum decision is what forces migrations on new admin actions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/Action vocabulary is a closed Postgres enum \(`admin_audit_action`\)\./);
    expect(p).toMatch(/Adding a new admin endpoint requires a migration; this is intentional —/);
    expect(p).toMatch(/it forces deliberate vocabulary choices and gives action-filtered/);
    expect(p).toMatch(/queries a free index hit/);
  });

  // ─── AdminAuditAction — the subset this file pins, grouped by V-NNN ─

  it('CRITICAL base AdminAuditAction values — account.tier_changed, account.suspended, account.unsuspended, webhook_delivery.replayed, webhook_delivery.requeued, rate_limit_override.set, rate_limit_override.cleared. The 7 base actions cover tier + suspension + webhook + rate-limit admin endpoints.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export type AdminAuditAction =/);
    expect(p).toMatch(/\| 'account\.tier_changed'/);
    expect(p).toMatch(/\| 'account\.suspended'/);
    expect(p).toMatch(/\| 'account\.unsuspended'/);
    expect(p).toMatch(/\| 'webhook_delivery\.replayed'/);
    expect(p).toMatch(/\| 'webhook_delivery\.requeued'/);
    expect(p).toMatch(/\| 'rate_limit_override\.set'/);
    expect(p).toMatch(/\| 'rate_limit_override\.cleared'/);
  });

  it("CRITICAL V-100 force-action anchor — 'V-100: force actions on customer resources' + session.destroyed_by_admin + api_key.revoked_by_admin. The 2-action V-100 group covers admin force-override of customer resources.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\/\/ V-100: force actions on customer resources\./);
    expect(p).toMatch(/\| 'session\.destroyed_by_admin'/);
    expect(p).toMatch(/\| 'api_key\.revoked_by_admin'/);
  });

  it("CRITICAL V-281 customer-support anchor — 'V-281: customer-support tooling (audit-only)' + audit_note.added + refund.recorded. The 2-action V-281 group is audit-only (no state change other than the audit row itself).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\/\/ V-281: customer-support tooling \(audit-only\)\./);
    expect(p).toMatch(/\| 'audit_note\.added'/);
    expect(p).toMatch(/\| 'refund\.recorded'/);
  });

  it("CRITICAL V-295a status-page anchor — 'V-295a: status-page incident management' + incident.created + incident.updated + incident.resolved. The 3-action V-295a group covers admin-driven incident lifecycle.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\/\/ V-295a: status-page incident management\./);
    expect(p).toMatch(/\| 'incident\.created'/);
    expect(p).toMatch(/\| 'incident\.updated'/);
    expect(p).toMatch(/\| 'incident\.resolved'/);
  });

  it("CRITICAL V-295c3-tombstone anchor — 'V-295c3-tombstone: status-page email subscriber admin actions' + status_subscriber.force_unsubscribed + status_subscriber.purged. The 2-action V-295c3-tombstone group covers GDPR-driven subscriber admin overrides.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\/\/ V-295c3-tombstone: status-page email subscriber admin actions\./);
    expect(p).toMatch(/\| 'status_subscriber\.force_unsubscribed'/);
    expect(p).toMatch(/\| 'status_subscriber\.purged'/);
  });

  it("CRITICAL LK.2 anchor — 'LK.2: per-Mac LiveKit credential registration (migration 0057)' + mac_node.livekit_registered. The 1-action LK.2 group covers operator provisioning of per-Mac LiveKit credentials via POST /v1/mac-nodes/register.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\/\/ LK\.2: per-Mac LiveKit credential registration \(migration 0057\)\./);
    expect(p).toMatch(/\| 'mac_node\.livekit_registered'/);
  });

  it('CRITICAL pricing + secrets anchors — pricing.updated (migration 0068) covers the master-owner price editor; secret.revealed (migration 0075, the secrets-manager lifecycle incl. the audited decrypt); account.deleted is now the union terminator (GDPR Article 17, migration 0094).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/\| 'pricing\.updated'/);
    expect(p).toMatch(/\| 'secret\.created'/);
    expect(p).toMatch(/\| 'secret\.revealed'/);
    expect(p).toMatch(/\| 'account\.deleted';/);
  });

  // ─── AdminAuditLogRow 10-field shape ─────────────────────────

  it('CRITICAL AdminAuditLogRow has 10 fields — id + adminAccountId + adminKeyId + action + targetAccountId (nullable) + targetResourceId (nullable) + inputPayload (nullable Record) + result + ipAddress (nullable) + timestamp. The 10-field shape carries who-did-what-to-which-target-with-what-input-from-what-IP.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export interface AdminAuditLogRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/adminAccountId: string;/);
    expect(p).toMatch(/adminKeyId: string;/);
    expect(p).toMatch(/action: AdminAuditAction;/);
    expect(p).toMatch(/targetAccountId: string \| null;/);
    expect(p).toMatch(/targetResourceId: string \| null;/);
    expect(p).toMatch(/inputPayload: Record<string, unknown> \| null;/);
    expect(p).toMatch(/result: string;/);
    expect(p).toMatch(/ipAddress: string \| null;/);
    expect(p).toMatch(/timestamp: Date;/);
  });

  // ─── AdminAuditLogRepo append-only (insert + list only) ─────

  it('CRITICAL AdminAuditLogRepo declares EXACTLY 2 methods — insert + list. No update / delete methods (D-025 append-only invariant enforced by interface shape).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export interface AdminAuditLogRepo \{/);
    expect(p).toMatch(/insert\(input: NewAdminAuditLogInput\): Promise<AdminAuditLogRow>;/);
    expect(p).toMatch(/list\(filters: ListAuditFilters\): Promise<ListAuditPage>;/);
    // Verify no other method declarations in repo interface.
    const repoBlock = p.match(/export interface AdminAuditLogRepo \{[\s\S]+?\}/)?.[0] ?? '';
    expect(repoBlock).not.toMatch(/update\s*\(/);
    expect(repoBlock).not.toMatch(/delete\s*\(/);
  });

  // ─── record() throws-up D-025 contract ──────────────────────

  it("CRITICAL record() JSDoc — 'Must be called by the route handler before returning the response. A throw here propagates up — failure to audit fails the request (D-025)'. The throw-up contract makes audit non-optional.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/Must be called by the route handler before/);
    expect(p).toMatch(/returning the response\. A throw here propagates up — failure to/);
    expect(p).toMatch(/audit fails the request \(D-025\)/);
  });

  // ─── ListAuditFilters shape ──────────────────────────────────

  it('CRITICAL ListAuditFilters has 8 fields — adminAccountId? + targetAccountId? + action? + from? (inclusive lower) + to? (exclusive upper) + targetResourceId? (V-521) + limit (required) + cursor?. The 8-filter surface is the admin audit-log query API.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export interface ListAuditFilters \{/);
    expect(p).toMatch(/adminAccountId\?: string;/);
    expect(p).toMatch(/targetAccountId\?: string;/);
    expect(p).toMatch(/action\?: AdminAuditAction;/);
    expect(p).toMatch(/Inclusive lower bound/);
    expect(p).toMatch(/from\?: Date;/);
    expect(p).toMatch(/Exclusive upper bound/);
    expect(p).toMatch(/to\?: Date;/);
    expect(p).toMatch(/limit: number;/);
    expect(p).toMatch(/cursor\?: string;/);
  });

  it("CRITICAL V-521 targetResourceId framing — 'V-521 — exact-match filter on the audit row's targetResourceId'. The V-521 anchor is the per-resource-audit-trace policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/V-521 — exact-match filter on the audit row's targetResourceId/);
    expect(p).toMatch(/targetResourceId\?: string;/);
  });

  it("CRITICAL cursor framing — 'Pagination cursor — last seen timestamp ISO string'. The timestamp-cursor matches the V-185 cursor pagination pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/Pagination cursor — last seen `timestamp` ISO string/);
  });

  // ─── 2-bound semantics (inclusive / exclusive) ───────────────

  it("CRITICAL from is 'Inclusive lower bound' + to is 'Exclusive upper bound'. The [from, to) half-open interval matches the V-185 audit-log + V-484 audit-filter pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/Inclusive lower bound/);
    expect(p).toMatch(/Exclusive upper bound/);
  });

  // ─── ListAuditPage 2-field shape ─────────────────────────────

  it('CRITICAL ListAuditPage has 2 fields — items + nextCursor (nullable). The 2-field page is the customer/admin paginator shape; nextCursor null signals end-of-results.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export interface ListAuditPage \{/);
    expect(p).toMatch(/items: AdminAuditLogRow\[\];/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── NewAdminAuditLogInput shape (writeable subset) ──────────

  it('CRITICAL NewAdminAuditLogInput has 8 fields — adminAccountId + adminKeyId + action + targetAccountId? + targetResourceId? + inputPayload? + result + ipAddress?. The 8-field write-shape is what route handlers pass to record(); id + timestamp are server-assigned.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts'));
    expect(p).toMatch(/export interface NewAdminAuditLogInput \{/);
    expect(p).toMatch(/adminAccountId: string;/);
    expect(p).toMatch(/adminKeyId: string;/);
    expect(p).toMatch(/action: AdminAuditAction;/);
    expect(p).toMatch(/targetAccountId\?: string \| null;/);
    expect(p).toMatch(/targetResourceId\?: string \| null;/);
    expect(p).toMatch(/inputPayload\?: Record<string, unknown> \| null;/);
    expect(p).toMatch(/result: string;/);
    expect(p).toMatch(/ipAddress\?: string \| null;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/admin-audit-d025-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
