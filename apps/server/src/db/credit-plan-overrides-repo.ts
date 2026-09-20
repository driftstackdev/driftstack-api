// Reads and writes `credit_plan_overrides` (migration 0128): the monthly AI
// credits an admin set for one account by hand — a contract's figure, or the
// credits of a plan an admin assigned with no payment behind it.
//
// An account has at most one (its primary key). It is never created
// automatically: every row is an admin's decision, and nothing in the product
// writes one yet. While it is live it is one of the three kinds of paid coverage
// the monthly grants read (`credit-windows-repo.ts`), running month by month
// from `anchor_at` until `ends_at`.
//
// ⛔ THE DATABASE IS THE AUTHORITY. The range of `monthly_credits`, the two
// reasons, and "ends after it is anchored" are CHECKs; the checks here exist to
// fail early with a readable error.
//
// TIMES. `anchor_at` and `ends_at` are given as Dates and stored as given; when
// no anchor is given the override is anchored at the database's now().
// `effective_since` is always the database's now(): it records when THIS figure
// began to apply, which is what a mid-month change is prorated from.

import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  CREDIT_PLAN_OVERRIDE_REASONS,
  type CreditLedgerExecutor,
  type CreditPlanOverrideReason,
} from './credit-ledger-repo.js';
import { creditPlanOverrides, type CreditPlanOverrideRow } from './schema.js';

/** `credit_plan_overrides_credits_range`: 0 to ten million credits a month. */
export const CREDIT_PLAN_OVERRIDE_MAX_MONTHLY_CREDITS = 10_000_000;

export interface CreditPlanOverrideRecord {
  readonly accountId: string;
  /** Whole credits a month. */
  readonly monthlyCredits: number;
  readonly ownKeyAllowed: boolean;
  readonly anchorAt: Date;
  readonly endsAt: Date | null;
  readonly effectiveSince: Date;
  readonly reason: CreditPlanOverrideReason;
  readonly setByKeyId: string | null;
  readonly note: string;
}

export interface SetCreditPlanOverride {
  readonly accountId: string;
  readonly monthlyCredits: number;
  readonly reason: CreditPlanOverrideReason;
  readonly ownKeyAllowed?: boolean;
  /** The day of the month the credits reset on, as an instant. Omitted: the database's now(). */
  readonly anchorAt?: Date;
  /** When the override stops granting. Omitted or null: it does not end. */
  readonly endsAt?: Date | null;
  /** The admin API key that set it, for the audit trail. */
  readonly setByKeyId?: string | null;
  readonly note?: string;
}

function toRecord(r: CreditPlanOverrideRow): CreditPlanOverrideRecord {
  if (!(CREDIT_PLAN_OVERRIDE_REASONS as readonly string[]).includes(r.reason)) {
    throw new RangeError('credit_plan_overrides.reason holds an unknown value');
  }
  return {
    accountId: r.accountId,
    monthlyCredits: r.monthlyCredits,
    ownKeyAllowed: r.ownKeyAllowed,
    anchorAt: r.anchorAt,
    endsAt: r.endsAt,
    effectiveSince: r.effectiveSince,
    reason: r.reason as CreditPlanOverrideReason,
    setByKeyId: r.setByKeyId,
    note: r.note,
  };
}

export class DrizzleCreditPlanOverridesRepo {
  constructor(private readonly database: Database) {}

  async get(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditPlanOverrideRecord | null> {
    const [row] = await on
      .select()
      .from(creditPlanOverrides)
      .where(eq(creditPlanOverrides.accountId, accountId))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Set the account's override, replacing any it had. `effective_since` becomes
   * the database's now() every time: a replaced figure applies from now, not
   * from when the first one was set.
   *
   * ⛔ NOT NAMED `set`. It is an INSERT … ON CONFLICT DO UPDATE, and its payload
   * carries `accountId` because it is the row's OWNER, not a column being
   * moved. Called `set`, the literal reads as Drizzle's `.set({…})` to the
   * repo-wide `an-update-may-not-move-a-row-between-accounts` guard, which
   * scans for exactly that shape and whose exemption list is documented as
   * having to stay empty. A false entry there is worse than a longer name.
   */
  async upsert(
    input: SetCreditPlanOverride,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CreditPlanOverrideRecord> {
    const credits = input.monthlyCredits;
    if (
      !Number.isInteger(credits) ||
      credits < 0 ||
      credits > CREDIT_PLAN_OVERRIDE_MAX_MONTHLY_CREDITS
    ) {
      throw new RangeError(
        `monthly credits must be a whole number from 0 to ${String(CREDIT_PLAN_OVERRIDE_MAX_MONTHLY_CREDITS)}`,
      );
    }
    if (!(CREDIT_PLAN_OVERRIDE_REASONS as readonly string[]).includes(input.reason)) {
      throw new RangeError('an override is set for a contract or for an admin-assigned plan');
    }
    const written = {
      monthlyCredits: credits,
      ownKeyAllowed: input.ownKeyAllowed ?? true,
      anchorAt: input.anchorAt ?? sql`now()`,
      endsAt: input.endsAt ?? null,
      effectiveSince: sql`now()`,
      reason: input.reason,
      setByKeyId: input.setByKeyId ?? null,
      note: input.note ?? '',
    };
    const [row] = await on
      .insert(creditPlanOverrides)
      .values({ accountId: input.accountId, ...written })
      .onConflictDoUpdate({
        target: creditPlanOverrides.accountId,
        set: { ...written, updatedAt: sql`now()` },
      })
      .returning();
    if (row === undefined) throw new Error('a credit plan override was written and not returned');
    return toRecord(row);
  }

  /**
   * End a live `admin_tier` override now, and only that kind.
   *
   * ⚠️ IT ENDS ONE THAT IS ALREADY ANCHORED. An override anchored at or after
   * now() is left alone, because `credit_plan_overrides` refuses an `ends_at`
   * at or before its `anchor_at`; replace such a row with `upsert` instead.
   * Nothing in S6 writes a future anchor (`upsert` anchors at the database's
   * now()), so the only way to reach it today is an admin setting one by hand.
   *
   * An `admin_tier` override IS the plan an admin assigned by hand, so it
   * stops meaning anything the moment an admin assigns a different one: leaving
   * it live would go on granting the old plan's credits under the new tier.
   * A `contract` override is the opposite — it is the figure in a signed
   * agreement, which a tier change does not revoke — so this never touches one.
   */
  async endAdminTierOverride(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<boolean> {
    const rows = await on
      .update(creditPlanOverrides)
      .set({ endsAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(creditPlanOverrides.accountId, accountId),
          eq(creditPlanOverrides.reason, 'admin_tier'),
          lt(creditPlanOverrides.anchorAt, sql`now()`),
          or(isNull(creditPlanOverrides.endsAt), gt(creditPlanOverrides.endsAt, sql`now()`)),
        ),
      )
      .returning({ accountId: creditPlanOverrides.accountId });
    return rows.length > 0;
  }

  /**
   * End a live override now, on the database's clock. False when the account has
   * none that is live: none at all, one that already ended, or one anchored in
   * the future (replace that with `upsert`; an override cannot end before it is
   * anchored).
   */
  async end(accountId: string, on: CreditLedgerExecutor = this.database.db): Promise<boolean> {
    const rows = await on
      .update(creditPlanOverrides)
      .set({ endsAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(creditPlanOverrides.accountId, accountId),
          lt(creditPlanOverrides.anchorAt, sql`now()`),
          or(isNull(creditPlanOverrides.endsAt), gt(creditPlanOverrides.endsAt, sql`now()`)),
        ),
      )
      .returning({ accountId: creditPlanOverrides.accountId });
    return rows.length > 0;
  }
}
