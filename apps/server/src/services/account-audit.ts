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
}

export interface ListAccountAuditPage {
  items: AccountAuditEntryRow[];
  nextCursor: string | null;
}

export interface AccountAuditRepo {
  insert(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow>;
  list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage>;
}

export class AccountAuditService {
  constructor(private readonly repo: AccountAuditRepo) {}

  /**
   * Customer-facing read. Returns the calling account's own audit
   * entries in newest-first order. account_owner scope required.
   */
  async list(ctx: AccountContext, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage> {
    throwIfMissingScope(ctx, 'account_owner');
    return this.repo.list(ctx.account.id, opts);
  }

  /**
   * Service-internal record-on-event. Callers (api-keys service,
   * sessions service, etc.) invoke this to drop a customer-visible
   * event into the account's audit log. Fire-and-forget intent —
   * call sites swallow errors so audit failures never break the
   * underlying customer action.
   */
  async record(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow> {
    return this.repo.insert(input);
  }
}
