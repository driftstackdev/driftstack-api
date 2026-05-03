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

export type AdminAuditAction =
  | 'account.tier_changed'
  | 'account.suspended'
  | 'account.unsuspended'
  | 'webhook_delivery.replayed'
  | 'webhook_delivery.requeued'
  | 'rate_limit_override.set'
  | 'rate_limit_override.cleared'
  // V-100: force actions on customer resources.
  | 'session.destroyed_by_admin'
  | 'api_key.revoked_by_admin';

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
  constructor(private readonly repo: AdminAuditLogRepo) {}

  /**
   * Record one admin action. Must be called by the route handler before
   * returning the response. A throw here propagates up — failure to
   * audit fails the request (D-025).
   */
  record(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    return this.repo.insert(input);
  }

  list(filters: ListAuditFilters): Promise<ListAuditPage> {
    return this.repo.list(filters);
  }
}
