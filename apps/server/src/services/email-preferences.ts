// V-204 — per-account email notification preferences.
//
// Customers opt out of "lifecycle" emails (signup-welcome, session-
// failed-first, tier-changed, billing-receipt). Security + financial emails (signup-
// verification, password-reset, billing-failure) bypass this gate
// entirely — they always send. (S44 2026-07-07 trimmed the never-
// wired subscription-cancellation + support-ack templates; the
// bypass list shrank with them.)
//
// Storage convention: absence of a row means opted-in (default).
// Explicit opt-out writes a row with opted_in=false. Steady-state
// is zero rows per account; only customers who flipped a preference
// have rows in the table.

import type { OptOutableEmailEvent } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

export interface EmailPreferenceRecord {
  accountId: string;
  eventType: OptOutableEmailEvent;
  optedIn: boolean;
  updatedAt: Date;
}

export interface EmailPreferencesRepo {
  list(accountId: string): Promise<EmailPreferenceRecord[]>;
  /**
   * Upsert by (accountId, eventType). Setting `optedIn=true` deletes
   * the row instead of writing it (default-opted-in convention).
   */
  set(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean): Promise<void>;
  /**
   * True if the customer has explicitly opted out of `eventType`.
   * False (default) for absent rows or `optedIn=true` rows.
   */
  isOptedOut(accountId: string, eventType: OptOutableEmailEvent): Promise<boolean>;
}

export class EmailPreferencesService {
  constructor(private readonly repo: EmailPreferencesRepo) {}

  /**
   * Customer-facing list. Returns one entry per opt-outable event
   * type, with `opted_in` true by default for any event type that
   * doesn't have a row.
   */
  async list(
    ctx: AccountContext,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<EmailPreferenceRecord[]> {
    throwIfMissingScope(ctx, 'account_owner');
    // V-330d — when effectiveAccountId is set, list the OWNER's
    // preferences. Read-only — both 'member' and 'admin' roles
    // allowed (gate is at the route layer; service stays neutral).
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const stored = await this.repo.list(accountId);
    const storedMap = new Map(stored.map((r) => [r.eventType, r]));

    const allEvents: OptOutableEmailEvent[] = [
      'signup-welcome',
      'session-failed-first',
      'session-success-first',
      'tier-changed',
      'billing-receipt',
      'billing-renewal-reminder',
    ];

    return allEvents.map((eventType) => {
      const existing = storedMap.get(eventType);
      if (existing) return existing;
      // Default opted-in. updatedAt is the account creation time
      // by convention, but we don't have that here without a join;
      // surface a stable epoch instead so consumers can detect
      // "never customised".
      return {
        accountId,
        eventType,
        optedIn: true,
        updatedAt: new Date(0),
      };
    });
  }

  async set(
    ctx: AccountContext,
    eventType: OptOutableEmailEvent,
    optedIn: boolean,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<void> {
    throwIfMissingScope(ctx, 'account_owner');
    // V-330d — when effectiveAccountId is set, the route layer has
    // already enforced the 'admin' role requirement (Q2 verdict —
    // member role is read-only on writes). Service writes to the
    // OWNER's account; the audit footprint of the change is the
    // owner's audit log, not the caller's.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    await this.repo.set(accountId, eventType, optedIn);
  }

  /**
   * Service-internal gate: returns true when the email **should send**
   * (default opted-in). Wire callers in EmailService send methods so
   * opt-outable events check this before firing.
   */
  async shouldSend(accountId: string, eventType: OptOutableEmailEvent): Promise<boolean> {
    const optedOut = await this.repo.isOptedOut(accountId, eventType);
    return !optedOut;
  }
}
