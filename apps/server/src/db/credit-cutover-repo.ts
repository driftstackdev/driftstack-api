// S16 — the `accounts`-table half of the cutover and rollback: reading one
// account's tier/status/legacy-settings/stored-key facts, listing the C0
// cohort, and restoring the legacy settings a rollback gives back.
//
// The `credit_accounts`-table half (locking it, writing `billing_mode`, the
// move snapshot and `ai_source`) stays in `credit-ledger-repo.ts`, which
// already owns every other write to that table — `services/credit-cutover.ts`
// composes the two, the same way `credit-grants.ts` composes `ledger` and
// `windows` without owning either table itself.
//
// ⛔ LOCK ORDER: ACCOUNTS, THEN CREDIT_ACCOUNTS — same order and the same
// reason `DrizzleAccountsAdminRepo.setTier` documents on its own lock: a
// credit writer's foreign key (a window, a lot, a ledger row, all pointing at
// `accounts`) takes `FOR KEY SHARE` on this row to check it, so a mutation
// that holds `credit_accounts` first and then reaches for `accounts` would
// deadlock against one going the other way. `FOR NO KEY UPDATE`, not
// `FOR UPDATE`, for the same reason: it is the strength this file's own write
// (`restoreLegacySettings`, two ordinary columns, neither in any key) needs,
// and it does not conflict with `FOR KEY SHARE`.
//
// ⛔ NO LOCKING QUERY HERE JOINS `credit_accounts`. Postgres refuses to lock
// the nullable side of an outer join (an account never touched by credits has
// no `credit_accounts` row at all), so `lockAccountFacts` locks `accounts`
// alone; a caller that also needs `billing_mode` reads it separately, under
// its OWN lock, from `DrizzleCreditLedgerRepo.lockAccount` — which every
// caller of this file already calls right after, per the lock order above.

import { and, eq, ne, sql } from 'drizzle-orm';
import {
  AccountTierSchema,
  AiBillingSchema,
  type AccountTier,
  type AiBilling,
} from '@driftstack/api-types';
import type { Database } from './client.js';
import type { CreditLedgerExecutor, CreditLedgerTx } from './credit-ledger-repo.js';
import { accounts, creditAccounts } from './schema.js';

export type AccountLifecycleStatus = 'active' | 'suspended' | 'deleted';

export interface CutoverAccountFacts {
  readonly accountId: string;
  readonly email: string;
  readonly tier: AccountTier;
  readonly status: AccountLifecycleStatus;
  /** `accounts.bundled_llm_consent` — the legacy consent flag. */
  readonly consent: boolean;
  /** `accounts.bundled_llm_monthly_cap_usd_cents` — the legacy cap. */
  readonly capCents: number;
  /** Whether a BYOK Anthropic key is STORED — presence, not usability
   *  (§8.5's mapping is stated in terms of "a stored key", and rule 3/4 of
   *  `decideAiSource` re-check usability at every turn regardless of what
   *  `ai_source` the cutover wrote — see `decideCutoverAiSource`'s own
   *  comment for why usability would be the wrong fact here). */
  readonly hasStoredKey: boolean;
}

const FACTS_COLUMNS = {
  id: accounts.id,
  email: accounts.email,
  tier: accounts.tier,
  status: accounts.status,
  consent: accounts.bundledLlmConsent,
  capCents: accounts.bundledLlmMonthlyCapUsdCents,
  hasStoredKey: sql<boolean>`${accounts.byokAnthropicApiKeyCiphertext} IS NOT NULL`,
};

interface FactsRow {
  readonly id: string;
  readonly email: string;
  readonly tier: string;
  readonly status: string;
  readonly consent: boolean;
  readonly capCents: number;
  readonly hasStoredKey: boolean;
}

const ACCOUNT_STATUSES: readonly AccountLifecycleStatus[] = ['active', 'suspended', 'deleted'];

function member<T extends string>(what: string, values: readonly T[], value: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new RangeError(`${what} holds an unknown value`);
  }
  return value as T;
}

function toFacts(row: FactsRow): CutoverAccountFacts {
  return {
    accountId: row.id,
    email: row.email,
    tier: member('accounts.tier', AccountTierSchema.options, row.tier),
    status: member('accounts.status', ACCOUNT_STATUSES, row.status),
    consent: row.consent,
    capCents: row.capCents,
    hasStoredKey: row.hasStoredKey,
  };
}

export class DrizzleCreditCutoverRepo {
  constructor(private readonly database: Database) {}

  /** No lock — for the dry-run plan, which writes and locks nothing. */
  async readAccountFacts(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<CutoverAccountFacts | null> {
    const [row] = await on
      .select(FACTS_COLUMNS)
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row === undefined ? null : toFacts(row);
  }

  /**
   * `FOR NO KEY UPDATE` on `accounts` alone — see the file header. Call
   * BEFORE `DrizzleCreditLedgerRepo.lockAccount` in the same transaction, not
   * after: that is the lock order the whole file exists to keep.
   */
  async lockAccountFacts(
    tx: CreditLedgerTx,
    accountId: string,
  ): Promise<CutoverAccountFacts | null> {
    const [row] = await tx
      .select(FACTS_COLUMNS)
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
      .for('no key update');
    return row === undefined ? null : toFacts(row);
  }

  /**
   * `credit_accounts.billing_mode`, with NO row locked and NO row inserted —
   * unlike `DrizzleCreditLedgerRepo.ensureAccount`/`lockAccount`, which both
   * insert the row if it is missing. The dry-run plan must write nothing at
   * all, even a harmless stub credit_accounts row, so it reads this instead.
   * `'legacy'` for an account credits has never touched, which is exactly
   * what an absent row means.
   */
  async readBillingMode(
    accountId: string,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<AiBilling> {
    const [row] = await on
      .select({ billingMode: creditAccounts.billingMode })
      .from(creditAccounts)
      .where(eq(creditAccounts.accountId, accountId))
      .limit(1);
    if (row === undefined) return 'legacy';
    return member('credit_accounts.billing_mode', AiBillingSchema.options, row.billingMode);
  }

  /**
   * C0 — internal accounts, by lower-cased e-mail, the SAME predicate
   * `DrizzleAiCreditsReportRepo.census` uses for the same cohort (the report
   * repo's own doc comment: "internal" is configuration, not a column). Not
   * deleted. Ordered by id, so a crash mid-list and a re-run walk the exact
   * same sequence (§8.4's "resumable").
   */
  async listCohortAccountIds(
    internalEmails: ReadonlySet<string>,
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<string[]> {
    const lowered = [...internalEmails].map((e) => e.toLowerCase());
    // No internal emails configured means C0 is empty, which is the truth —
    // an `IN ()` with nothing inside it is a syntax error, so this returns
    // early rather than building one (the same trap the census's own comment
    // names).
    if (lowered.length === 0) return [];
    const rows = await on
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(ne(accounts.status, 'deleted'), sql`lower(${accounts.email}) IN ${lowered}`))
      .orderBy(accounts.id);
    return rows.map((r) => r.id);
  }

  /** The rollback's `accounts` write: put the legacy consent + cap back
   *  exactly as the cutover found them. Inside the caller's transaction,
   *  after `lockAccountFacts` has locked this row. */
  async restoreLegacySettings(
    tx: CreditLedgerTx,
    accountId: string,
    args: { readonly consent: boolean; readonly capCents: number },
  ): Promise<void> {
    await tx
      .update(accounts)
      .set({ bundledLlmConsent: args.consent, bundledLlmMonthlyCapUsdCents: args.capCents })
      .where(eq(accounts.id, accountId));
  }
}
