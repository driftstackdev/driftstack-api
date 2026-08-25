// W399.B — drift guard for apps/server/src/services/admin-audit.ts.
// Admin audit log: every MUTATING /v1/admin/* endpoint writes one row
// BEFORE returning its response. Append-only invariant enforced by
// code, not DB (D-025). The AdminAuditAction closed Postgres enum is
// the load-bearing artefact; drift here either silently loses an
// audit row (record throws but caller swallows) or opens an unbounded
// action vocabulary that breaks action-filtered queries.
//
//   • D-025 append-only invariant pinned (enforced by code, not DB).
//   • Closed-enum action vocabulary: adding a new admin endpoint
//     requires a migration — deliberate, gives action-filtered
//     queries a free index hit.
//   • AdminAuditAction union: 14 literals across 6 clusters
//     (lifecycle / webhook-delivery / rate-limit-override / V-100
//     force / V-281 customer-support tooling / V-295a incident /
//     V-295c3-tombstone subscriber admin).
//   • AdminAuditLogRow: 9 camelCased fields.
//   • NewAdminAuditLogInput: required (adminAccountId, adminKeyId,
//     action, result) + 4 optional.
//   • ListAuditFilters: 6 filters + limit/cursor.
//   • V-521 targetResourceId exact-match filter framing pinned.
//   • record(): throw propagates — failure to audit fails the request
//     (D-025).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/admin-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W399.B apps/server/src/services/admin-audit.ts content parity', () => {
  const body = read(LIB);

  it('V-1007 Module framing: every MUTATING /v1/admin/* endpoint writes one row before response, reads do not, three OAuth-client mutations excepted; append-only', () => {
    expect(body).toMatch(
      /Every MUTATING \/v1\/admin\/\* endpoint writes one row here before\s*\/\/ returning its response, with three exceptions\. Reads do not\./,
    );
    // V-1007 — the retracted claim, paraphrased in the negative. "every
    // endpoint" is what an auditor would cite for staff-access traceability,
    // and 35 of 68 admin registrations are GETs that write nothing.
    expect(body).not.toMatch(/Every \/v1\/admin\/\* endpoint writes one row here before returning/);
    expect(body).toMatch(/The repo exposes `insert\(\.\.\.\)` and a paginated `list\(\.\.\.\)`/);
  });

  it('Closed-enum framing: new admin endpoint = migration (action-filtered query index)', () => {
    expect(body).toMatch(
      /Action vocabulary is a closed Postgres enum \(`admin_audit_action`\)\.\s*\/\/\s*Adding a new admin endpoint requires a migration; this is intentional —\s*\/\/\s*it forces deliberate vocabulary choices and gives action-filtered\s*\/\/\s*queries a free index hit\./,
    );
  });

  it('AdminAuditAction: 3-literal lifecycle cluster (tier_changed / suspended / unsuspended)', () => {
    expect(body).toMatch(/export type AdminAuditAction =/);
    expect(body).toMatch(/\| 'account\.tier_changed'/);
    expect(body).toMatch(/\| 'account\.suspended'/);
    expect(body).toMatch(/\| 'account\.unsuspended'/);
  });

  it('AdminAuditAction: webhook-delivery cluster (replayed / requeued)', () => {
    expect(body).toMatch(/\| 'webhook_delivery\.replayed'/);
    expect(body).toMatch(/\| 'webhook_delivery\.requeued'/);
  });

  it('AdminAuditAction: rate-limit-override cluster (set / cleared)', () => {
    expect(body).toMatch(/\| 'rate_limit_override\.set'/);
    expect(body).toMatch(/\| 'rate_limit_override\.cleared'/);
  });

  it('AdminAuditAction: V-100 force-on-customer-resources cluster (session.destroyed_by_admin / api_key.revoked_by_admin)', () => {
    expect(body).toMatch(/\/\/ V-100: force actions on customer resources\./);
    expect(body).toMatch(/\| 'session\.destroyed_by_admin'/);
    expect(body).toMatch(/\| 'api_key\.revoked_by_admin'/);
  });

  it('AdminAuditAction: V-281 customer-support-tooling cluster (audit_note.added / refund.recorded)', () => {
    expect(body).toMatch(/\/\/ V-281: customer-support tooling \(audit-only\)\./);
    expect(body).toMatch(/\| 'audit_note\.added'/);
    expect(body).toMatch(/\| 'refund\.recorded'/);
  });

  it('AdminAuditAction: V-295a status-incident-management cluster (incident.created/updated/resolved)', () => {
    expect(body).toMatch(/\/\/ V-295a: status-page incident management\./);
    expect(body).toMatch(/\| 'incident\.created'/);
    expect(body).toMatch(/\| 'incident\.updated'/);
    expect(body).toMatch(/\| 'incident\.resolved'/);
  });

  it('AdminAuditAction: V-295c3-tombstone status-subscriber cluster (force_unsubscribed / purged) + LK.2 mac_node.livekit_registered + pricing.updated (0068) + secret.revealed (0075) + account.deleted terminator (GDPR Article 17, migration 0094)', () => {
    expect(body).toMatch(/\/\/ V-295c3-tombstone: status-page email subscriber admin actions\./);
    expect(body).toMatch(/\| 'status_subscriber\.force_unsubscribed'/);
    expect(body).toMatch(/\| 'status_subscriber\.purged'/);
    expect(body).toMatch(/\| 'mac_node\.livekit_registered'/);
    expect(body).toMatch(/\| 'pricing\.updated'/);
    // Secrets Phase A slice 2: secret.revealed audits every decrypt.
    expect(body).toMatch(/\| 'secret\.revealed'/);
    // GDPR Article 17 admin-triggered account termination now terminates
    // the union (migration 0094).
    expect(body).toMatch(/\| 'account\.deleted';/);
  });

  it('AdminAuditLogRow: 9 camelCased fields (id, adminAccountId, adminKeyId, action, targetAccountId?, targetResourceId?, inputPayload?, result, ipAddress?, timestamp)', () => {
    expect(body).toMatch(/export interface AdminAuditLogRow \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/adminAccountId: string;/);
    expect(body).toMatch(/adminKeyId: string;/);
    expect(body).toMatch(/action: AdminAuditAction;/);
    expect(body).toMatch(/targetAccountId: string \| null;/);
    expect(body).toMatch(/targetResourceId: string \| null;/);
    expect(body).toMatch(/inputPayload: Record<string, unknown> \| null;/);
    expect(body).toMatch(/result: string;/);
    expect(body).toMatch(/ipAddress: string \| null;/);
    expect(body).toMatch(/timestamp: Date;/);
  });

  it('ListAuditFilters: 6 filters + limit + cursor; V-521 targetResourceId exact-match filter', () => {
    expect(body).toMatch(/export interface ListAuditFilters \{/);
    expect(body).toMatch(/adminAccountId\?: string;/);
    expect(body).toMatch(/targetAccountId\?: string;/);
    expect(body).toMatch(/action\?: AdminAuditAction;/);
    expect(body).toMatch(/\/\*\* Inclusive lower bound\. \*\/\s*from\?: Date;/);
    expect(body).toMatch(/\/\*\* Exclusive upper bound\. \*\/\s*to\?: Date;/);
    expect(body).toMatch(
      /\/\*\* V-521 — exact-match filter on the audit row's targetResourceId\. \*\/\s*targetResourceId\?: string;/,
    );
    expect(body).toMatch(/limit: number;/);
    expect(body).toMatch(
      /\/\*\* Pagination cursor — last seen `timestamp` ISO string\. \*\/\s*cursor\?: string;/,
    );
  });

  it('AdminAuditLogRepo: 2 methods (insert + list — append-only)', () => {
    expect(body).toMatch(
      /export interface AdminAuditLogRepo \{\s*insert\(input: NewAdminAuditLogInput\): Promise<AdminAuditLogRow>;\s*list\(filters: ListAuditFilters\): Promise<ListAuditPage>;\s*\}/,
    );
  });

  it('record(): MUST be called by route before response; throw propagates — failure to audit fails the request (D-025) (+ Arc 7 obs.11 best-effort metrics bump labelled by audit-action prefix)', () => {
    expect(body).toMatch(
      /Record one admin action\. Must be called by the route handler before\s*\*\s*returning the response\. A throw here propagates up — failure to\s*\*\s*audit fails the request \(D-025\)\./,
    );
    // Re-pinned when the counter gained an `outcome` dimension so a FAILED
    // staff-action audit write is counted rather than showing up only as a
    // success rate that stops rising. Asserted as the properties that matter
    // — insert awaited in a try, failure counted as error and re-thrown so
    // callers keep swallowing it, success counted as ok — rather than one
    // exact rendering of the method.
    expect(body).toMatch(/row = await this\.repo\.insert\(input\);/);
    expect(body).toMatch(/outcome: 'error'/);
    expect(body).toMatch(/throw err;/);
    expect(body).toMatch(/\.\.\.labels, outcome: 'ok'/);
    expect(body).toMatch(/prefix: auditActionPrefix\(input\.action\)/);
    // Arc 7 obs.11 — best-effort metrics bump after insert.
    expect(body).toMatch(/METRIC_NAMES\.adminAuditEmitTotal/);
  });

  it('list: delegates to repo.list(filters)', () => {
    expect(body).toMatch(
      /list\(filters: ListAuditFilters\): Promise<ListAuditPage> \{\s*return this\.repo\.list\(filters\);\s*\}/,
    );
  });

  it('imports: NONE from api-types (self-contained — closed enum lives here). Internal cross-module imports from ./metrics-registry + ./account-audit are required for the Arc 7 obs.11 best-effort metrics bump.', () => {
    // No api-types or @driftstack-package imports.
    expect(body).not.toMatch(/^import .* from '@driftstack\//m);
    // Allowed internal imports.
    expect(body).toMatch(
      /import \{ METRIC_NAMES, type MetricsRegistry \} from '\.\/metrics-registry/,
    );
    expect(body).toMatch(/import \{ auditActionPrefix \} from '\.\/account-audit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
