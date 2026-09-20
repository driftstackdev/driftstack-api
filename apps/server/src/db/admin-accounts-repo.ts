// Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status.

import { type SQL, and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type {
  AccountsAdminRepo,
  ListAccountsArgs,
  ListAccountsPage,
  SetAccountTierOptions,
} from '../services/admin-accounts.js';
import type { AccountRow } from '../services/auth.js';
import type { Database } from './client.js';
import type { CreditLedgerTx } from './credit-ledger-repo.js';
import type { DrizzleCreditPlanOverridesRepo } from './credit-plan-overrides-repo.js';
import { accounts, creditAccounts } from './schema.js';
import { BadRequestError } from '../lib/errors.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

// V-1245 — the staff account browser's page size, named and exported so the in-memory
// double reads THESE numbers instead of keeping its own `Math.min(args.limit ?? 50, 100)`.
// Both sides carried the literal, so the two agreed only until somebody edited one, and
// every test standing on the double would have gone on asserting the old cap.
//
// Its own constants, NOT shared with the customer profile listing or the snapshot listing,
// which carry the same two numbers today. Those are separate product limits that merely
// coincide; one constant across all three would mean raising the staff page size silently
// raised what customers get too.
export const ADMIN_ACCOUNTS_PAGE_DEFAULT = 50;
export const ADMIN_ACCOUNTS_PAGE_MAX = 100;

export class DrizzleAccountsAdminRepo implements AccountsAdminRepo {
  constructor(
    private readonly database: Database,
    /**
     * Writes the plan an admin set by hand. Null while AI credits are switched
     * off — there are then no accounts on credits and no overrides to end, so a
     * tier change does exactly what it always did.
     */
    private readonly overrides: DrizzleCreditPlanOverridesRepo | null = null,
  ) {}

  async findById(id: string): Promise<AccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? toRow(row) : null;
  }

  /**
   * Change an account's tier, in ONE TRANSACTION that locks the account first.
   *
   * It used to be a bare UPDATE. A tier is now read by the monthly AI credits
   * grants — which run under `credit_accounts`' own row lock — so a tier change
   * racing a refresh could have the refresh read one plan and grant against
   * another. The lock order here is ACCOUNTS, THEN CREDIT_ACCOUNTS.
   *
   * ⛔ THE ACCOUNT ROW IS TAKEN `FOR NO KEY UPDATE`, NOT `FOR UPDATE`, AND THAT
   * IS WHAT KEEPS THE TWO ORDERS FROM DEADLOCKING. A credit writer does not
   * touch `accounts` in any statement it writes — but every row it inserts
   * (a window, a lot, a ledger row, a clawback) carries a FOREIGN KEY to
   * `accounts`, and Postgres takes a `FOR KEY SHARE` lock on the parent row to
   * check it. So a refresh that already holds `credit_accounts` still ends up
   * waiting for this row, and with `FOR UPDATE` — the one strength that
   * conflicts with `FOR KEY SHARE` — the cycle closes and one side dies with
   * 40P01 (measured, and guarded by `…-holds-the-account-…`, the arm that says
   * THE OTHER ORDER DOES NOT DEADLOCK).
   *
   * `FOR NO KEY UPDATE` is exactly the strength the `UPDATE` below takes on its
   * own — `tier` is in no key — and it is no weaker where it matters: it still
   * conflicts with another tier change (this one and `stripe-webhooks-repo`'s,
   * which take the same row), and with a DELETE of the account. What it stops
   * conflicting with is a foreign key pointing AT this row, which was never a
   * change to it.
   *
   * ⛔ A LEGACY ACCOUNT BEHAVES EXACTLY AS IT DID. The credit row is read, not
   * created: an account that has never been on credits has no row, so the
   * `FOR UPDATE` matches nothing and neither rule below applies to it.
   *
   * Two rules apply to an account on credits (M7):
   *
   *   · ENTERPRISE HAS NO PLAN-WIDE ALLOWANCE. Every other plan's monthly
   *     credits are a number in the entitlement table; Enterprise's is whatever
   *     the agreement says. Assigning it without that figure would give the
   *     customer a plan that includes AI and grants nothing, so it is refused
   *     until `monthlyCredits` is supplied, which is written as the account's
   *     `contract` override. AN AMENDMENT TO AN AGREEMENT THE ACCOUNT ALREADY
   *     HAS MOVES THE FIGURE AND NOTHING ELSE: the override is written with
   *     `upsert`, which REPLACES the row, so the day the credits reset on and
   *     the own-key permission are carried forward from the contract that is
   *     standing rather than falling back to their defaults.
   *   · AN `admin_tier` OVERRIDE ENDS WITH THE TIER IT WAS SET FOR. It is the
   *     plan an admin assigned by hand; once a different one is assigned it
   *     would otherwise keep granting the old plan's credits for ever.
   *
   * The credits themselves are refreshed by the caller AFTER this commits
   * (`AccountsAdminService.changeTier`): a grant is idempotent and self-healing,
   * and a database blink while granting must not undo an admin action that has
   * already been decided.
   */
  async setTier(
    id: string,
    tier: AccountTier,
    at: Date,
    opts: SetAccountTierOptions = {},
  ): Promise<AccountRow | null> {
    return this.database.db.transaction(async (tx) => {
      // ⛔ `no key update`, NOT `update` — see the note above. `for('update')`
      // is the one strength that conflicts with the FOR KEY SHARE every credit
      // writer's foreign key takes on this same row, and the two lock orders
      // then deadlock. (Kept off the statement itself: the content-parity guard
      // for this file matches raw source, so a comment inside the pinned span
      // breaks it.)
      const [current] = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, id))
        .limit(1)
        .for('no key update');
      if (current === undefined) return null;

      const [credit] = await tx
        .select({ billingMode: creditAccounts.billingMode })
        .from(creditAccounts)
        .where(eq(creditAccounts.accountId, id))
        .limit(1)
        .for('update');
      const onCredits = credit?.billingMode === 'credits';

      if (onCredits && tier === 'enterprise' && opts.monthlyCredits === undefined) {
        throw new BadRequestError(
          'An Enterprise plan has no standard monthly AI credits. Send monthly_credits with the tier change.',
        );
      }
      if (current.tier !== tier) await this.endAdminTierOverride(tx, id);
      if (onCredits && tier === 'enterprise' && opts.monthlyCredits !== undefined) {
        if (this.overrides === null) {
          throw new Error('an Enterprise contract was supplied with no plan-override writer wired');
        }
        // ⛔ AN AMENDMENT MOVES THE FIGURE AND NOTHING ELSE. `upsert` REPLACES
        // the row, so every column this call leaves out goes back to a default:
        // `anchor_at` to the database's now(), `own_key_allowed` to true, the
        // note to ''. `anchor_at` is the day of the month the credits reset on
        // — `coverageCandidatesSql` counts the whole month calendar from it — so
        // re-anchoring a live agreement mid-month moves the customer's reset day
        // and hands them a short window at a full month's level; and
        // `own_key_allowed` is a policy somebody turned off by hand. Only what
        // THIS change decides moves: the figure, the admin key that asked, and a
        // note if one was sent. A standing `admin_tier` override is not an
        // agreement and carries nothing forward — it has just been ended above.
        const standing = await this.overrides.get(id, tx);
        const contract = standing !== null && standing.reason === 'contract' ? standing : null;
        await this.overrides.upsert(
          {
            accountId: id,
            monthlyCredits: opts.monthlyCredits,
            reason: 'contract',
            ...(contract === null
              ? {}
              : { anchorAt: contract.anchorAt, ownKeyAllowed: contract.ownKeyAllowed }),
            setByKeyId: opts.setByKeyId ?? null,
            note: opts.note ?? contract?.note ?? '',
          },
          tx,
        );
      }

      const [row] = await tx
        .update(accounts)
        .set({ tier, updatedAt: at })
        .where(eq(accounts.id, id))
        .returning();
      return row ? toRow(row) : null;
    });
  }

  /** No-op when no plan-override writer is wired: there is then no override to end. */
  private async endAdminTierOverride(tx: CreditLedgerTx, accountId: string): Promise<void> {
    if (this.overrides === null) return;
    await this.overrides.endAdminTierOverride(accountId, tx);
  }

  async setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null> {
    // GDPR Article 17 — stamp deleted_at when transitioning to 'deleted' so
    // the account-deletion-purge-sweeper can compute a 30-day retention
    // cutoff. There is no "undelete" flow, so deleted_at is never cleared
    // once set; active/suspended transitions never touch it.
    const [row] = await this.database.db
      .update(accounts)
      .set({ status, updatedAt: at, ...(status === 'deleted' ? { deletedAt: at } : {}) })
      .where(eq(accounts.id, id))
      .returning();
    return row ? toRow(row) : null;
  }

  async list(args: ListAccountsArgs): Promise<ListAccountsPage> {
    const limit = Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX);

    const filters: SQL[] = [];
    if (args.status !== undefined) filters.push(eq(accounts.status, args.status));
    if (args.tier !== undefined) filters.push(eq(accounts.tier, args.tier));
    if (args.emailContains !== undefined && args.emailContains.length > 0) {
      filters.push(ilike(accounts.email, `%${args.emailContains.toLowerCase()}%`));
    }

    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: accounts.createdAt, id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, args.cursor))
        .limit(1);
      if (cursorRow !== undefined) {
        const cursorClause = or(
          lt(accounts.createdAt, cursorRow.createdAt),
          and(eq(accounts.createdAt, cursorRow.createdAt), lt(accounts.id, cursorRow.id)),
        );
        if (cursorClause !== undefined) filters.push(cursorClause);
      }
    }

    const whereClause = filters.length === 0 ? undefined : and(...filters);

    const rows = await this.database.db
      .select()
      .from(accounts)
      .where(whereClause)
      .orderBy(desc(accounts.createdAt), desc(accounts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toRow);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return { data, hasMore, nextCursor };
  }

  async countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .where(eq(accounts.status, status));
    return row?.cnt ?? 0;
  }

  // One GROUP BY query rather than one count per tier — keeps the overview
  // endpoint single-roundtrip. Zero-fill from AccountTierSchema.options so
  // every tier is present (no hardcoded list to drift from the enum).
  async countByTier(): Promise<Record<AccountTier, number>> {
    const rows = await this.database.db
      .select({ tier: accounts.tier, cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .groupBy(accounts.tier);
    const out = emptyTierCounts();
    for (const row of rows) out[row.tier] = row.cnt;
    return out;
  }

  async countCreatedSince(since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(accounts)
      .where(gte(accounts.createdAt, since));
    return row?.cnt ?? 0;
  }
}

/** Zero-filled count record over every AccountTier (canonical enum order). */
function emptyTierCounts(): Record<AccountTier, number> {
  const out = {} as Record<AccountTier, number>;
  for (const tier of AccountTierSchema.options) out[tier] = 0;
  return out;
}

function toRow(r: typeof accounts.$inferSelect): AccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    status: r.status,
    timezone: r.timezone,
    avatarR2Key: r.avatarR2Key,
    slug: r.slug,
    region: r.region,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
