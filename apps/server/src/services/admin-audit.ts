// Admin audit logging.
//
// Every /v1/admin/* endpoint writes one row here before returning its
// response. The repo exposes `insert(...)` and a paginated `list(...)`
// only — no UPDATE or DELETE method. The "append-only" invariant is
// enforced by code, not the DB (D-025).
//
// Action vocabulary is a closed Postgres enum (`admin_audit_action`).
// Adding a new admin endpoint requires a migration; this is intentional —
// it forces deliberate vocabulary choices and gives action-filtered
// queries a free index hit.

import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';
import { auditActionPrefix } from './account-audit.js';

export type AdminAuditAction =
  | 'account.tier_changed'
  | 'account.suspended'
  | 'account.unsuspended'
  | 'webhook_delivery.replayed'
  | 'webhook_delivery.requeued'
  | 'webhook_delivery.discarded'
  | 'rate_limit_override.set'
  | 'rate_limit_override.cleared'
  // V-100: force actions on customer resources.
  | 'session.destroyed_by_admin'
  | 'api_key.revoked_by_admin'
  // V-281: customer-support tooling (audit-only).
  | 'audit_note.added'
  | 'refund.recorded'
  // V-295a: status-page incident management.
  | 'incident.created'
  | 'incident.updated'
  | 'incident.resolved'
  // V-295c3-tombstone: status-page email subscriber admin actions.
  | 'status_subscriber.force_unsubscribed'
  | 'status_subscriber.force_subscribed'
  | 'incident.reopened'
  // V-783 — RESERVED, never emitted. Migration 0027 added this value for the
  // automated 90d email purge, and nothing can write it: admin_audit_log
  // requires a non-null admin_account_id AND admin_key_id (both FKs), and
  // account_audit_log requires an accountId. The purge is fired by a timer and
  // a status subscriber is an anonymous email with no account and no key, so
  // there is no actor to attribute the row to. A Postgres enum value cannot be
  // dropped without rebuilding the type, so it stays in the vocabulary; the
  // reachability guard lists it as unemittable rather than pretending. The only
  // evidence the purge ran is its structured log line in bootstrap.
  | 'status_subscriber.purged'
  // LK.2: per-Mac LiveKit credential registration (migration 0057).
  | 'mac_node.livekit_registered'
  // Fleet-admin (§A5) node control: cordon/uncordon/drain/restart (migration 0084).
  | 'mac_node.control'
  // owner price edit — pricing-as-data master-owner cockpit (migration 0068).
  | 'pricing.updated'
  // Admin-cockpit secrets Phase A slice 2 (migration 0075) — owner
  // secrets-management; every reveal (decrypt) is audited.
  | 'secret.created'
  | 'secret.updated'
  | 'secret.deleted'
  | 'secret.revealed'
  // D-025 audit-gap fix (migration 0097) — admin-crypto-orders.ts and
  // admin-validation-harness.ts had zero audit wiring despite this file's
  // header invariant. sweep-expired / apply-ipn / internal-note now audit
  // via crypto_order.*; validation-schedule upsert / remove / trigger via
  // validation_schedule.*.
  | 'crypto_order.swept'
  | 'crypto_order.ipn_applied'
  | 'crypto_order.note_updated'
  | 'validation_schedule.upserted'
  | 'validation_schedule.removed'
  | 'validation_schedule.triggered'
  // GDPR Article 17 admin-triggered account termination (migration 0094).
  // AccountsAdminService.deleteAccount() sets status='deleted' + reclaims
  // sessions/web-sessions/API-keys/webhooks; the admin route records this
  // action before returning (same D-025 shape as account.suspended).
  | 'account.deleted';

export interface AdminAuditLogRow {
  id: string;
  adminAccountId: string;
  adminKeyId: string;
  action: AdminAuditAction;
  targetAccountId: string | null;
  targetResourceId: string | null;
  inputPayload: Record<string, unknown> | null;
  result: string;
  ipAddress: string | null;
  timestamp: Date;
}

export interface NewAdminAuditLogInput {
  adminAccountId: string;
  adminKeyId: string;
  action: AdminAuditAction;
  targetAccountId?: string | null;
  targetResourceId?: string | null;
  inputPayload?: Record<string, unknown> | null;
  result: string;
  ipAddress?: string | null;
}

export interface ListAuditFilters {
  adminAccountId?: string;
  targetAccountId?: string;
  action?: AdminAuditAction;
  /** Inclusive lower bound. */
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  /** V-521 — exact-match filter on the audit row's targetResourceId. */
  targetResourceId?: string;
  limit: number;
  /** Pagination cursor — last seen `timestamp` ISO string. */
  cursor?: string;
}

export interface ListAuditPage {
  items: AdminAuditLogRow[];
  nextCursor: string | null;
}

export interface AdminAuditLogRepo {
  insert(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow>;
  list(filters: ListAuditFilters): Promise<ListAuditPage>;
}

export class AdminAuditService {
  constructor(
    private readonly repo: AdminAuditLogRepo,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Record one admin action. Must be called by the route handler before
   * returning the response. A throw here propagates up — failure to
   * audit fails the request (D-025).
   */
  async record(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    const labels = { prefix: auditActionPrefix(input.action) };
    let row;
    try {
      row = await this.repo.insert(input);
    } catch (err) {
      // Same reasoning as AccountAuditService.record: a failed staff-action
      // audit write is the one that matters most and was the least visible.
      // Counted here, re-thrown unchanged.
      try {
        this.metrics?.inc(METRIC_NAMES.adminAuditEmitTotal, { ...labels, outcome: 'error' });
      } catch {
        // Metrics are best-effort even on the failure path.
      }
      throw err;
    }
    // Arc 7 obs.11 — admin-audit emission counter, labelled by the
    // top-level admin-action prefix (account / webhook_delivery /
    // rate_limit_override / session / api_key / audit_note / refund /
    // incident / status_subscriber). Bounded cardinality. Best-effort;
    // a metric failure must not break the admin-action persistence.
    try {
      this.metrics?.inc(METRIC_NAMES.adminAuditEmitTotal, { ...labels, outcome: 'ok' });
    } catch {
      // Swallow.
    }
    return row;
  }

  list(filters: ListAuditFilters): Promise<ListAuditPage> {
    return this.repo.list(filters);
  }
}
