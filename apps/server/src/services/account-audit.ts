// V-216 — customer-facing audit log service.
//
// Records customer-visible events on the account: api-key mint /
// revoke, session create / destroy, profile lifecycle, subscription
// changes, webhook-endpoint lifecycle. Mirrors the admin-audit
// service shape but customer-scoped — `list(accountId)` returns only
// the calling account's own entries, gated on account_owner scope.
//
// Append-only contract: insert + list, no update / delete. Same
// posture as admin_audit_log per D-025.

import type { AccountAuditAction, AccountAuditActorType } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';

export interface AccountAuditEntryRow {
  id: string;
  accountId: string;
  actorType: AccountAuditActorType;
  actorAccountId: string | null;
  actorKeyId: string | null;
  action: AccountAuditAction;
  targetResourceId: string | null;
  payload: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: Date;
}

export interface RecordAccountAuditInput {
  accountId: string;
  actorType: AccountAuditActorType;
  actorAccountId?: string | null;
  actorKeyId?: string | null;
  action: AccountAuditAction;
  targetResourceId?: string | null;
  payload?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListAccountAuditOpts {
  limit: number;
  cursor?: string;
  action?: AccountAuditAction;
  // V-484 — additional filters layered on the base shape.
  /** Inclusive lower bound on `timestamp`. */
  from?: Date;
  /** Inclusive upper bound on `timestamp`. */
  to?: Date;
  /** Filter by actor — `customer` (most common), `system`, `staff`. */
  actorType?: AccountAuditActorType;
  /** Filter by exact target resource id (e.g. `webhook_endpoint_<id>`). */
  targetResourceId?: string;
}

export interface ListAccountAuditPage {
  items: AccountAuditEntryRow[];
  nextCursor: string | null;
}

export interface AccountAuditRepo {
  insert(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow>;
  list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage>;
}

/** Arc 7 obs.10 — bucket an AccountAuditAction (dot-separated namespace
 *  like `api_key.created`, `agent_session.pair_mode.takeover`) into
 *  its top-level prefix (`api_key`, `agent_session`, etc.). Keeps
 *  the prefix label cardinality bounded by the namespace count, not
 *  the full action enum. */
export function auditActionPrefix(action: string): string {
  const dot = action.indexOf('.');
  return dot === -1 ? action : action.slice(0, dot);
}

export class AccountAuditService {
  constructor(
    private readonly repo: AccountAuditRepo,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Customer-facing read. Returns the calling account's own audit
   * entries in newest-first order. account_owner scope required.
   *
   * V-330b — when `opts.effectiveAccountId` is set (route layer
   * resolved X-Driftstack-Account to a team owner the caller is a
   * member of), the audit entries returned are the OWNER's, not the
   * caller's. The scope check stays on the caller's apiKey — being a
   * team member doesn't waive the account_owner scope requirement on
   * the calling principal.
   */
  async list(
    ctx: AccountContext,
    opts: ListAccountAuditOpts & { effectiveAccountId?: string },
  ): Promise<ListAccountAuditPage> {
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    return this.repo.list(accountId, opts);
  }

  /**
   * Service-internal record-on-event. Callers (api-keys service,
   * sessions service, etc.) invoke this to drop a customer-visible
   * event into the account's audit log. Fire-and-forget intent —
   * call sites swallow errors so audit failures never break the
   * underlying customer action.
   */
  async record(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow> {
    const row = await this.repo.insert(input);
    // Arc 7 obs.10 — bump the audit-emit counter labelled by the
    // top-level action prefix + actor type. Best-effort; metrics
    // failures never break the customer-visible operation.
    try {
      this.metrics?.inc(METRIC_NAMES.accountAuditEmitTotal, {
        prefix: auditActionPrefix(input.action),
        actor_type: input.actorType,
      });
    } catch {
      // Swallow.
    }
    return row;
  }
}
