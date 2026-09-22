// S16 — moving an existing account onto AI credits, and rolling one back.
// Plan §8 items 4-7, decisions 4 and 5 of §11.
//
// `decideCutover`/`decideCutoverAiSource` are PURE: every fact they need —
// the account's tier, its current billing mode, whether it consented, whether
// it has a stored BYOK key, whether it has paid coverage right now — is read
// by the caller first, the same split `services/ai-source.ts` uses for the
// per-turn decision this one feeds into. That is what lets §8.5's whole
// mapping table be stated and tested without a database.
//
// `CreditCutoverService` is the orchestration: `planCutover` reads every
// account a selector names and decides each, WITHOUT locking or writing
// anything (the dry run IS this read); `runCutover` re-decides each account
// UNDER ITS OWN LOCK, in its own transaction — one account, one transaction,
// per §8.4 — and commits the ones it decides to move; `rollbackAccount`
// restores one account's legacy snapshot in a transaction of its own.
//
// ⛔ LOCK ORDER: ACCOUNTS, THEN CREDIT_ACCOUNTS. Every locked transaction below
// calls `cutoverRepo.lockAccountFacts` BEFORE `ledger.lockAccount` — see
// `credit-cutover-repo.ts`'s file header for why the other order deadlocks
// against a credit writer's foreign-key check.
//
// ⛔ RESUMABLE BY CONSTRUCTION, NOT BY BOOKKEEPING. Each account is its own
// transaction, so a crash (or a thrown error) after N accounts have committed
// leaves those N moved and the rest untouched; nothing here catches a
// per-account error and continues past it, so a batch that fails stops where
// it failed, and calling `runCutover` again re-decides every account in the
// selector — the N already on credits are decided `already_moved` (read, not
// written, a second time) and the rest are decided and moved exactly as the
// first call would have.

import {
  aiEntitlementFor,
  type AccountTier,
  type AiBilling,
  type AiSource,
} from '@driftstack/api-types';
import type {
  CreditAccountRecord,
  CreditLedgerExecutor,
  CreditLedgerTx,
  DrizzleCreditLedgerRepo,
} from '../db/credit-ledger-repo.js';
import type { DrizzleCreditWindowsRepo } from '../db/credit-windows-repo.js';
import type { DrizzleCreditCutoverRepo } from '../db/credit-cutover-repo.js';
import type { CreditGrantsService } from './credit-grants.js';

/** §8's cutover cohorts. Only C0 is this slice's to move — see
 *  `PhaseTwoCohortError`. Mirrors `AI_CREDITS_COHORTS` in
 *  `db/ai-credits-report-repo.ts` (the census's own roster); kept in
 *  agreement with it by
 *  `the-cutover-cohort-schema-agrees-with-the-census-cohorts.test.ts`. */
export const CUTOVER_COHORTS = ['C0', 'C1', 'C2', 'C3', 'C4'] as const;
export type CutoverCohort = (typeof CUTOVER_COHORTS)[number];

export type CutoverSelector =
  | { readonly kind: 'account_ids'; readonly accountIds: readonly string[] }
  | { readonly kind: 'cohort'; readonly cohort: CutoverCohort };

/** A selector named a Phase-2 cohort. Phase 1 (this slice) moves C0 only. */
export class PhaseTwoCohortError extends Error {
  constructor(readonly cohort: string) {
    super(
      `cohort "${cohort}" is a Phase 2 cohort; this slice's cutover route moves only C0 (internal accounts)`,
    );
    this.name = 'PhaseTwoCohortError';
  }
}

export type CutoverNotEligibleReason = 'free_plan';
export type CutoverRefuseReason = 'no_paid_coverage' | 'account_not_found' | 'account_deleted';

export type CutoverDecision =
  | { readonly accountId: string; readonly outcome: 'move'; readonly aiSource: AiSource | null }
  | { readonly accountId: string; readonly outcome: 'already_moved' }
  | {
      readonly accountId: string;
      readonly outcome: 'not_eligible';
      readonly reason: CutoverNotEligibleReason;
    }
  | {
      readonly accountId: string;
      readonly outcome: 'refuse';
      readonly reason: CutoverRefuseReason;
    };

/**
 * §8.5's mapping, stated generically over the plan's ENTITLEMENT rather than
 * hard-coded per tier name (Team/Agency/Starter/Builder/Scale/Enterprise):
 * the plan's own row for "stored key plus consent (Builder, Scale,
 * Enterprise)" names those three tiers as its EXAMPLES, not an exhaustive
 * list — the rule it states ("key first, credits when the key is missing, as
 * they opted in") is exactly automatic (`ai_source = NULL`), which
 * `services/ai-source.ts`'s rule 4 already applies uniformly to every plan
 * that allows an own key. Stating it that way here means this function and
 * the per-turn resolver it feeds can never name a different set of tiers by
 * accident — one predicate (`ownKeyAllowed`), not two lists kept in step by
 * hand.
 *
 *   · plan forbids an own key (Personal) → credits, whatever the key or
 *     consent say — the plan's own row: "a stored key is kept but never
 *     read".
 *   · no stored key → credits, whatever consent says (the "consented, no
 *     key" and "no key on Team/Agency/Starter" rows are the same fact: no key
 *     to prefer).
 *   · a stored key, consent off → own_key (H3: key only, never credits).
 *   · a stored key, consent on → NULL (automatic: key first, credits when it
 *     is missing).
 *
 * ⛔ "STORED", NOT "USABLE". `hasStoredKey` is whether a key ROW exists
 * (`accounts.byok_anthropic_api_key_ciphertext IS NOT NULL`), never whether
 * it is still within its TTL — usability is `services/ai-source.ts`'s rule
 * 3/4 to re-check on EVERY turn, forever, off whatever `ai_source` this
 * writes. Deciding on usability here would bake today's TTL state into a
 * value nothing ever re-derives, and would get the required S16 test wrong:
 * "a moved account keeps its key-only choice after the key expires" is
 * exactly `ai_source = 'own_key'` outliving the key's usability, which is
 * rule 3's job (refuse, never fall back to credits), not this function's.
 */
export function decideCutoverAiSource(args: {
  readonly ownKeyAllowed: boolean;
  readonly hasStoredKey: boolean;
  readonly consent: boolean;
}): AiSource | null {
  if (!args.ownKeyAllowed) return 'credits';
  if (!args.hasStoredKey) return 'credits';
  return args.consent ? null : 'own_key';
}

export interface CutoverAccountDecisionFacts {
  readonly billingMode: AiBilling;
  readonly status: 'active' | 'suspended' | 'deleted';
  readonly tier: AccountTier;
  readonly consent: boolean;
  readonly hasStoredKey: boolean;
  /** `windows.coverageCandidates(...)` non-empty — a paid Stripe invoice, a
   *  paid crypto entitlement, or a live admin override with `monthly_credits
   *  > 0` — the SAME plumbing `refreshCredits` grants from (§8.4's "no paid
   *  coverage and no admin override" is one fact, not two, for exactly the
   *  reason `services/ai-source.ts`'s header warns about: deciding it twice
   *  is how the two copies drift). */
  readonly hasPaidCoverage: boolean;
}

/**
 * §8.4's per-account decision, pure. `accountId` travels through untouched —
 * this function never reads or writes anything — so the caller's decision
 * list can be built by mapping accounts through it.
 */
export function decideCutover(
  accountId: string,
  facts: CutoverAccountDecisionFacts,
): CutoverDecision {
  if (facts.status === 'deleted') {
    return { accountId, outcome: 'refuse', reason: 'account_deleted' };
  }
  if (facts.billingMode === 'credits') {
    return { accountId, outcome: 'already_moved' };
  }
  const entitlement = aiEntitlementFor(facts.tier);
  if (!entitlement.aiIncluded) {
    return { accountId, outcome: 'not_eligible', reason: 'free_plan' };
  }
  // §8.4/M7 — a paid tier with no paid coverage and no admin override stays
  // legacy, Enterprise (whose plan-wide allowance is 'contract' — no
  // Stripe price maps to it at all) included. §11 decision 4: no automatic
  // overrides.
  if (!facts.hasPaidCoverage) {
    return { accountId, outcome: 'refuse', reason: 'no_paid_coverage' };
  }
  const aiSource = decideCutoverAiSource({
    ownKeyAllowed: entitlement.ownKeyAllowed,
    hasStoredKey: facts.hasStoredKey,
    consent: facts.consent,
  });
  return { accountId, outcome: 'move', aiSource };
}

export interface CutoverRunResult {
  readonly moved: readonly { readonly accountId: string; readonly aiSource: AiSource | null }[];
  readonly alreadyMoved: readonly string[];
  readonly notEligible: readonly {
    readonly accountId: string;
    readonly reason: CutoverNotEligibleReason;
  }[];
  readonly refused: readonly { readonly accountId: string; readonly reason: CutoverRefuseReason }[];
}

export type RollbackResult =
  | {
      readonly outcome: 'rolled_back';
      readonly accountId: string;
      readonly restored: { readonly consent: boolean; readonly capCents: number };
    }
  | { readonly outcome: 'not_moved'; readonly accountId: string };

/** {@link CreditCutoverService.previewRollback}'s answer — its own type, not
 *  {@link RollbackResult} with a relabelled outcome, so a route cannot mix up
 *  a PREVIEW with an action that actually happened. */
export type RollbackPreview =
  | {
      readonly outcome: 'would_roll_back';
      readonly accountId: string;
      readonly restored: { readonly consent: boolean; readonly capCents: number };
    }
  | { readonly outcome: 'not_moved'; readonly accountId: string };

export interface CreditCutoverDeps {
  readonly ledger: Pick<
    DrizzleCreditLedgerRepo,
    | 'transaction'
    | 'lockAccount'
    | 'peekAccount'
    | 'setAiSourceIn'
    | 'setCutoverMoved'
    | 'setCutoverRolledBack'
  >;
  readonly windows: Pick<DrizzleCreditWindowsRepo, 'coverageCandidates'>;
  readonly cutoverRepo: Pick<
    DrizzleCreditCutoverRepo,
    | 'readAccountFacts'
    | 'lockAccountFacts'
    | 'readBillingMode'
    | 'restoreLegacySettings'
    | 'listCohortAccountIds'
  >;
  readonly creditGrants: Pick<CreditGrantsService, 'refreshCreditsIn'>;
  /** The pool-level executor — for `planCutover`'s no-lock coverage read.
   *  Every locked read in `runCutover`/`rollbackAccount` uses the
   *  transaction it opened instead. */
  readonly pool: CreditLedgerExecutor;
  /** C0 — the deployment's own accounts, lower-cased. Same set
   *  bootstrap.ts hands `DrizzleAiCreditsReportRepo` for the census. */
  readonly internalEmails: ReadonlySet<string>;
}

/** Bucket a flat decision list into the shape a staff response's `summary`
 *  wants — pure, so the route and any test can build it off exactly the
 *  decisions `planCutover`/`runCutover` returned, with nothing recomputed. */
export function summarizeCutoverDecisions(decisions: readonly CutoverDecision[]): CutoverRunResult {
  const moved: { accountId: string; aiSource: AiSource | null }[] = [];
  const alreadyMoved: string[] = [];
  const notEligible: { accountId: string; reason: CutoverNotEligibleReason }[] = [];
  const refused: { accountId: string; reason: CutoverRefuseReason }[] = [];
  for (const d of decisions) {
    switch (d.outcome) {
      case 'move':
        moved.push({ accountId: d.accountId, aiSource: d.aiSource });
        break;
      case 'already_moved':
        alreadyMoved.push(d.accountId);
        break;
      case 'not_eligible':
        notEligible.push({ accountId: d.accountId, reason: d.reason });
        break;
      case 'refuse':
        refused.push({ accountId: d.accountId, reason: d.reason });
        break;
    }
  }
  return { moved, alreadyMoved, notEligible, refused };
}

export class CreditCutoverService {
  constructor(private readonly deps: CreditCutoverDeps) {}

  /** The account ids a selector names, in a stable order — C0's is
   *  `accounts.id` ascending (`listCohortAccountIds`'s own ORDER BY), which
   *  is what makes a crash-and-resume walk the same sequence twice. */
  async resolveSelector(selector: CutoverSelector): Promise<string[]> {
    if (selector.kind === 'account_ids') return [...selector.accountIds];
    if (selector.cohort !== 'C0') throw new PhaseTwoCohortError(selector.cohort);
    return this.deps.cutoverRepo.listCohortAccountIds(this.deps.internalEmails);
  }

  /**
   * The dry run: every account the selector names, decided, with NOTHING
   * locked and NOTHING written — not even a stub `credit_accounts` row
   * (`cutoverRepo.readBillingMode` reads it without `ensureAccount`'s
   * insert). Proved with a row-count control in the integration tests.
   */
  async planCutover(selector: CutoverSelector): Promise<CutoverDecision[]> {
    const accountIds = await this.resolveSelector(selector);
    const decisions: CutoverDecision[] = [];
    for (const accountId of accountIds) {
      const facts = await this.deps.cutoverRepo.readAccountFacts(accountId);
      if (facts === null) {
        decisions.push({ accountId, outcome: 'refuse', reason: 'account_not_found' });
        continue;
      }
      const billingMode = await this.deps.cutoverRepo.readBillingMode(accountId);
      const hasPaidCoverage =
        billingMode === 'credits' ||
        (await this.deps.windows.coverageCandidates(this.deps.pool, accountId)).length > 0;
      decisions.push(
        decideCutover(accountId, {
          billingMode,
          status: facts.status,
          tier: facts.tier,
          consent: facts.consent,
          hasStoredKey: facts.hasStoredKey,
          hasPaidCoverage,
        }),
      );
    }
    return decisions;
  }

  /**
   * Execute: every account the selector names, one transaction each,
   * locked accounts-then-credit_accounts (§8.4). An error from any step
   * propagates — nothing here catches a per-account failure and moves on —
   * which is what makes "resumable" true by construction: accounts already
   * committed before the failure stay moved, and a fresh call re-walks the
   * whole selector, redeciding (and skipping) every one of them.
   */
  async runCutover(selector: CutoverSelector): Promise<CutoverDecision[]> {
    const accountIds = await this.resolveSelector(selector);
    const decisions: CutoverDecision[] = [];
    for (const accountId of accountIds) {
      decisions.push(await this.moveOneAccount(accountId));
    }
    return decisions;
  }

  private async moveOneAccount(accountId: string): Promise<CutoverDecision> {
    const { ledger, windows, cutoverRepo, creditGrants } = this.deps;
    return ledger.transaction(async (tx: CreditLedgerTx) => {
      const facts = await cutoverRepo.lockAccountFacts(tx, accountId);
      if (facts === null) {
        return { accountId, outcome: 'refuse' as const, reason: 'account_not_found' as const };
      }
      const credit: CreditAccountRecord = await ledger.lockAccount(tx, accountId);
      const hasPaidCoverage =
        credit.billingMode === 'credits' ||
        (await windows.coverageCandidates(tx, accountId)).length > 0;
      const decision = decideCutover(accountId, {
        billingMode: credit.billingMode,
        status: facts.status,
        tier: facts.tier,
        consent: facts.consent,
        hasStoredKey: facts.hasStoredKey,
        hasPaidCoverage,
      });
      if (decision.outcome !== 'move') return decision;

      // §8.4's order: set ai_source, refreshCredits (grants the current
      // window in full — §8's "no bridge lots"), THEN set billing_mode.
      await ledger.setAiSourceIn(tx, accountId, { aiSource: decision.aiSource, setBy: 'cutover' });
      await creditGrants.refreshCreditsIn(tx, accountId);
      await ledger.setCutoverMoved(tx, accountId, {
        legacyConsentAtMove: facts.consent,
        legacyCapCentsAtMove: facts.capCents,
        hadStoredKeyAtMove: facts.hasStoredKey,
      });
      return decision;
    });
  }

  /**
   * The rollback's dry run: what {@link rollbackAccount} WOULD do, with
   * nothing locked and nothing written — not even a stub `credit_accounts`
   * row for an account still on legacy (`ledger.peekAccount`, never
   * `ensureAccount`/`lockAccount`, which both insert one).
   */
  async previewRollback(accountId: string): Promise<RollbackPreview> {
    const credit = await this.deps.ledger.peekAccount(accountId);
    if (credit === null || credit.billingMode !== 'credits') {
      return { outcome: 'not_moved' as const, accountId };
    }
    if (credit.legacyConsentAtMove === null || credit.legacyCapCentsAtMove === null) {
      throw new Error(
        `credit_accounts ${accountId} is on credits with no move snapshot — ` +
          'the credit_accounts_move_snapshot CHECK should make this unreachable',
      );
    }
    return {
      outcome: 'would_roll_back' as const,
      accountId,
      restored: { consent: credit.legacyConsentAtMove, capCents: credit.legacyCapCentsAtMove },
    };
  }

  /**
   * One account → legacy (§8.7). Restores the legacy consent/cap snapshot
   * the cutover took and clears `ai_source`; touches no ledger row, lot or
   * window, so this month's spend stays exactly as it is (the S13 status
   * route then shows the OLD cap with this month's spend intact — proved
   * through the route in the integration tests). `not_moved` when the
   * account is not currently on credits; writes nothing in that case.
   */
  async rollbackAccount(accountId: string): Promise<RollbackResult> {
    const { ledger, cutoverRepo } = this.deps;
    return ledger.transaction(async (tx: CreditLedgerTx) => {
      // Lock order: accounts, then credit_accounts — even though this
      // account's own facts are not otherwise needed, the lock order still
      // has to hold against a concurrent credit writer's FK check.
      const locked = await cutoverRepo.lockAccountFacts(tx, accountId);
      if (locked === null) {
        throw new Error(`rollbackAccount: account ${accountId} does not exist`);
      }
      const credit = await ledger.lockAccount(tx, accountId);
      if (credit.billingMode !== 'credits') {
        return { outcome: 'not_moved' as const, accountId };
      }
      if (credit.legacyConsentAtMove === null || credit.legacyCapCentsAtMove === null) {
        throw new Error(
          `credit_accounts ${accountId} is on credits with no move snapshot — ` +
            'the credit_accounts_move_snapshot CHECK should make this unreachable',
        );
      }
      const restored = {
        consent: credit.legacyConsentAtMove,
        capCents: credit.legacyCapCentsAtMove,
      };
      await cutoverRepo.restoreLegacySettings(tx, accountId, restored);
      await ledger.setCutoverRolledBack(tx, accountId);
      return { outcome: 'rolled_back' as const, accountId, restored };
    });
  }
}
