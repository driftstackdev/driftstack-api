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
import type { NotificationEventBus } from './notification-event-bus.js';
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
  /**
   * 2026-05-22 — count entries matching `action` since `since` (inclusive).
   * Used by the profile-import quota guard: legit backup/restore uses
   * are rare; abusive cycling (export → delete → import N) shows up as
   * a high count in a short window. The repo translates this to a
   * COUNT(*) WHERE account_id = ? AND action = ? AND ts >= ?.
   */
  countActionsSince(accountId: string, action: string, since: Date): Promise<number>;
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

/**
 * 2026-05-20 — actions republished onto the v0 NotificationEventBus
 * as `audit.high_severity`. Anything destructive / security-sensitive
 * that a customer would want to see in the panel toast feed without
 * polling the audit log. Drift on this set is intentional: adding a
 * new high-severity action should be a conscious choice, not a side
 * effect of widening the audit-action enum.
 *
 * The selection criterion: would a customer want to be notified
 * within seconds if this fired without their direct action?
 *   - api_key.revoked        — yes, possible compromise / account takeover
 *   - byok_anthropic.key_set — yes, BYOK swap is high-blast-radius
 *   - byok_anthropic.key_cleared — yes, same reason inverted
 *   - team.member_removed    — yes, may indicate hostile reshuffle
 *   - account.mfa_disabled   — yes, security regression
 *   - account.password_changed — yes, possible takeover signal
 *
 * Low-severity actions (logins, recovery-code usage, email-pref
 * changes) stay in the audit log only — customer can query via
 * GET /v1/account/audit-log.
 */
const HIGH_SEVERITY_AUDIT_ACTIONS = new Set<AccountAuditAction>([
  'api_key.revoked',
  'account.byok_anthropic_key_set',
  'account.byok_anthropic_key_cleared',
  'team.member_removed',
  'account.mfa_disabled',
  'account.password_changed',
]);

export class AccountAuditService {
  constructor(
    private readonly repo: AccountAuditRepo,
    private readonly metrics?: MetricsRegistry,
    private readonly notificationBus?: NotificationEventBus,
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
  /** 2026-05-22 — service-internal proxy for the count-since query.
   *  Used by ProfilesService.importProfile to enforce the per-cycle
   *  import cap. No scope-gate (internal-only). */
  async countActionsSince(accountId: string, action: string, since: Date): Promise<number> {
    return this.repo.countActionsSince(accountId, action, since);
  }

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
    // 2026-05-20 — selective republish onto the v0 NotificationEventBus
    // for high-severity actions. Best-effort: publish failures NEVER
    // break the customer-visible operation OR the audit-log insert
    // (which already succeeded above — the durable trail is intact
    // even if the panel notification drops).
    if (this.notificationBus !== undefined && HIGH_SEVERITY_AUDIT_ACTIONS.has(input.action)) {
      try {
        // Map server-side actor enum ('staff') to the panel's
        // 'admin' bucket — customer-facing labels treat any non-
        // customer non-system action as administrative.
        const actorType: 'customer' | 'admin' | 'system' =
          input.actorType === 'staff' ? 'admin' : input.actorType;
        this.notificationBus.publish({
          kind: 'audit.high_severity',
          accountId: input.accountId,
          action: input.action,
          actorType,
          targetResourceId: input.targetResourceId ?? null,
          at: row.timestamp.toISOString(),
        });
      } catch {
        // Swallow — audit log is the source of truth.
      }
    }
    return row;
  }
}
