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
//
// ⛔ AND AUDITED BY CONSTRUCTION. `runCutover`/`rollbackAccount` take the
// caller's audit hook and run it INSIDE each account's own transaction, after
// the change it records: a committed move always has its audit row, and an
// account a failed batch never committed has none. (Audited after the whole
// batch, a batch that failed part-way left its committed moves with no row,
// and the resume reported them `already_moved` — never audited.)
//
// ⛔ PHASE 1 MOVES C0 ONLY, BY COHORT OR BY ID. The `account_ids` selector is
// not a way around the cohort: an id outside C0 is refused per account
// (`not_in_phase_1_cohort`), in the dry run as in the real run.
//
// ⛔ THE M9 OVER-ALLOWANCE GATE IS NOT BUILT, and belongs to Phase 2. M9 (and
// §8's cohort table, C3) keeps a consented bundled account whose 30-day shadow
// spend exceeds its allowance on legacy until Phase 3's purchase path or an
// admin goodwill grant. That gate is a property of the Phase-2 cohorts
// (C1–C4), which this slice refuses outright (`PhaseTwoCohortError`, and the
// C0-only rule above for ids); nothing here reads shadow spend. Whoever opens
// a Phase-2 cohort must build that gate first.

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
import type {
  CutoverAccountFacts,
  CutoverCoverageFacts,
  DrizzleCreditCutoverRepo,
} from '../db/credit-cutover-repo.js';
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
/** Mirrors `AiCreditsCutoverRefuseReasonSchema` in `@driftstack/api-types`, which
 *  says what each one means. */
export type CutoverRefuseReason =
  | 'no_paid_coverage'
  | 'no_contract'
  | 'not_in_phase_1_cohort'
  | 'account_not_found'
  | 'account_deleted';

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
  /**
   * A paid source covers now(): a paid Stripe subscription line, a crypto
   * term, or a live admin override with `monthly_credits > 0`
   * (`cutoverRepo.coverageFacts`) — the three sources `refreshCredits` grants
   * from, asked WHETHER they cover now, not whether a window is still OWED
   * for it. (Asked the second way, as it once was, every account whose month
   * had already been granted read as uncovered.) §8.4's "no paid coverage and
   * no admin override" is this one fact: a live override IS a paid source.
   */
  readonly hasPaidCoverage: boolean;
  /** A live `contract` override — what a plan whose allowance is `'contract'`
   *  (Enterprise) must have to move (§8.4/M7). */
  readonly hasLiveContractOverride: boolean;
  /** The account is in C0 (its e-mail is one of the deployment's internal
   *  ones). Phase 1 moves nothing else, whatever the selector. */
  readonly inPhaseOneCohort: boolean;
}

/**
 * §8.4's per-account decision, pure. `accountId` travels through untouched —
 * this function never reads or writes anything — so the caller's decision
 * list can be built by mapping accounts through it.
 *
 * In order: deleted → outside C0 → already moved → Free → a contract plan
 * with no live contract → no paid coverage → move.
 */
export function decideCutover(
  accountId: string,
  facts: CutoverAccountDecisionFacts,
): CutoverDecision {
  if (facts.status === 'deleted') {
    return { accountId, outcome: 'refuse', reason: 'account_deleted' };
  }
  // Phase 1 is C0 (§8's cohort table). An id named directly is held to the
  // same cohort as the `cohort: 'C0'` selector: without this, `account_ids`
  // moved any account at all — a consented bundled customer over their
  // allowance (C3, the M9 case) included.
  if (!facts.inPhaseOneCohort) {
    return { accountId, outcome: 'refuse', reason: 'not_in_phase_1_cohort' };
  }
  if (facts.billingMode === 'credits') {
    return { accountId, outcome: 'already_moved' };
  }
  const entitlement = aiEntitlementFor(facts.tier);
  if (!entitlement.aiIncluded) {
    return { accountId, outcome: 'not_eligible', reason: 'free_plan' };
  }
  // §8.4/M7 — a plan with no plan-wide allowance (Enterprise: 'contract')
  // moves only on the figure an admin set as its contract. A paid Stripe line
  // on some OTHER plan (an Enterprise account paying a Scale subscription) is
  // coverage, but not the agreement M7 asks for, and would otherwise move the
  // account on that other plan's allowance. §11 decision 4: no automatic
  // overrides — the cutover never writes one.
  if (entitlement.monthlyCredits === 'contract' && !facts.hasLiveContractOverride) {
    return { accountId, outcome: 'refuse', reason: 'no_contract' };
  }
  // §8.4 — a paid tier with no paid coverage and no admin override stays
  // legacy, listed in the dry run.
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

/** A decision that moved an account. */
export type CutoverMove = Extract<CutoverDecision, { outcome: 'move' }>;

/**
 * What `runCutover` runs INSIDE each account's move transaction, after the
 * move is written and before it commits — the audit row (see the file header,
 * "audited by construction"). A hook that throws rolls that account's move
 * back and stops the batch there, exactly as a failed move does.
 */
export interface CutoverRunHooks {
  onMoved(tx: CreditLedgerTx, decision: CutoverMove): Promise<void>;
}

/** The same, for `rollbackAccount`: run inside the rollback's transaction,
 *  only when the account was actually rolled back. */
export interface RollbackHooks {
  onRolledBack(
    tx: CreditLedgerTx,
    result: Extract<RollbackResult, { outcome: 'rolled_back' }>,
  ): Promise<void>;
}

/**
 * S16 audit fix #10 — the legacy consent a rollback puts back. The move's
 * snapshot, EXCEPT when the customer chose their own source while moved
 * (`ai_source_set_by = 'customer'`): a customer who chose their own key
 * (`own_key`) turned the credits fallback OFF, and the legacy equivalent of
 * that is consent false — restoring a `true` snapshot would switch back on a
 * fallback they had just refused. Any other customer choice keeps the
 * snapshot (the coordinator's rule: choosing credits while moved has no
 * legacy meaning stronger than the consent the account had before).
 */
export function legacyConsentOnRollback(
  credit: Pick<CreditAccountRecord, 'aiSource' | 'aiSourceSetBy'>,
  snapshotConsent: boolean,
): boolean {
  if (credit.aiSourceSetBy === 'customer' && credit.aiSource === 'own_key') return false;
  return snapshotConsent;
}

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
  /**
   * NO LONGER READ. Coverage used to come from `windows.coverageCandidates`,
   * which answers "is a window still owed" and so said "uncovered" for every
   * account whose month was already granted (S16 audit #1); it now comes from
   * `cutoverRepo.coverageFacts`. Optional, not removed, only because
   * `lib/bootstrap.ts` (outside this fix) still passes it — remove the two
   * together.
   */
  readonly windows?: Pick<DrizzleCreditWindowsRepo, 'coverageCandidates'>;
  readonly cutoverRepo: Pick<
    DrizzleCreditCutoverRepo,
    | 'readAccountFacts'
    | 'lockAccountFacts'
    | 'readBillingMode'
    | 'restoreLegacySettings'
    | 'listCohortAccountIds'
    | 'coverageFacts'
  >;
  readonly creditGrants: Pick<CreditGrantsService, 'refreshCreditsIn'>;
  /** The pool-level executor — for `planCutover`'s no-lock coverage read.
   *  Every locked read in `runCutover`/`rollbackAccount` uses the
   *  transaction it opened instead. */
  readonly pool: CreditLedgerExecutor;
  /** C0 — the deployment's own accounts. Same set bootstrap.ts hands
   *  `DrizzleAiCreditsReportRepo` for the census; compared case-insensitively
   *  on both sides, as the census does. */
  readonly internalEmails: ReadonlySet<string>;
}

/** The C0 set lower-cased — read at each call, never cached, so it is always
 *  the set the census reads. */
function loweredEmails(emails: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...emails].map((e) => e.toLowerCase()));
}

function decisionFacts(
  facts: CutoverAccountFacts,
  billingMode: AiBilling,
  coverage: CutoverCoverageFacts,
  c0: ReadonlySet<string>,
): CutoverAccountDecisionFacts {
  return {
    billingMode,
    status: facts.status,
    tier: facts.tier,
    consent: facts.consent,
    hasStoredKey: facts.hasStoredKey,
    hasPaidCoverage: coverage.hasPaidCoverage,
    hasLiveContractOverride: coverage.hasLiveContractOverride,
    inPhaseOneCohort: c0.has(facts.email.toLowerCase()),
  };
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
    const c0 = loweredEmails(this.deps.internalEmails);
    const decisions: CutoverDecision[] = [];
    for (const accountId of accountIds) {
      const facts = await this.deps.cutoverRepo.readAccountFacts(accountId);
      if (facts === null) {
        decisions.push({ accountId, outcome: 'refuse', reason: 'account_not_found' });
        continue;
      }
      const billingMode = await this.deps.cutoverRepo.readBillingMode(accountId);
      const coverage = await this.deps.cutoverRepo.coverageFacts(accountId, this.deps.pool);
      decisions.push(decideCutover(accountId, decisionFacts(facts, billingMode, coverage, c0)));
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
   *
   * `hooks.onMoved` is REQUIRED: it is how a move gets its audit row inside
   * its own transaction (the file header, "audited by construction").
   */
  async runCutover(selector: CutoverSelector, hooks: CutoverRunHooks): Promise<CutoverDecision[]> {
    const accountIds = await this.resolveSelector(selector);
    const c0 = loweredEmails(this.deps.internalEmails);
    const decisions: CutoverDecision[] = [];
    for (const accountId of accountIds) {
      decisions.push(await this.moveOneAccount(accountId, c0, hooks));
    }
    return decisions;
  }

  private async moveOneAccount(
    accountId: string,
    c0: ReadonlySet<string>,
    hooks: CutoverRunHooks,
  ): Promise<CutoverDecision> {
    const { ledger, cutoverRepo, creditGrants } = this.deps;
    return ledger.transaction(async (tx: CreditLedgerTx) => {
      const facts = await cutoverRepo.lockAccountFacts(tx, accountId);
      if (facts === null) {
        return { accountId, outcome: 'refuse' as const, reason: 'account_not_found' as const };
      }
      const credit: CreditAccountRecord = await ledger.lockAccount(tx, accountId);
      const coverage = await cutoverRepo.coverageFacts(accountId, tx);
      const decision = decideCutover(
        accountId,
        decisionFacts(facts, credit.billingMode, coverage, c0),
      );
      if (decision.outcome !== 'move') return decision;

      // §8.4's order: set ai_source, refreshCredits (grants the current
      // window in full — §8's "no bridge lots"; nothing when it was granted
      // already), THEN set billing_mode, THEN audit.
      await ledger.setAiSourceIn(tx, accountId, { aiSource: decision.aiSource, setBy: 'cutover' });
      await creditGrants.refreshCreditsIn(tx, accountId);
      await ledger.setCutoverMoved(tx, accountId, {
        legacyConsentAtMove: facts.consent,
        legacyCapCentsAtMove: facts.capCents,
        hadStoredKeyAtMove: facts.hasStoredKey,
      });
      await hooks.onMoved(tx, decision);
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
      restored: {
        consent: legacyConsentOnRollback(credit, credit.legacyConsentAtMove),
        capCents: credit.legacyCapCentsAtMove,
      },
    };
  }

  /**
   * One account → legacy (§8.7). Restores the legacy cap snapshot the cutover
   * took, and the legacy consent per {@link legacyConsentOnRollback} (the
   * snapshot, unless the customer chose their own key while moved), and
   * clears `ai_source`; touches no ledger row, lot or window, so this month's
   * spend stays exactly as it is (the S13 status route then shows the OLD cap
   * with this month's spend intact — proved through the route in the
   * integration tests). `not_moved` when the account is not currently on
   * credits; writes nothing to either table in that case (it may create the
   * empty `credit_accounts` row `lockAccount` ensures).
   *
   * `hooks.onRolledBack` runs inside the same transaction, only for an
   * account actually rolled back — the audit row commits with the rollback.
   */
  async rollbackAccount(accountId: string, hooks: RollbackHooks): Promise<RollbackResult> {
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
        consent: legacyConsentOnRollback(credit, credit.legacyConsentAtMove),
        capCents: credit.legacyCapCentsAtMove,
      };
      await cutoverRepo.restoreLegacySettings(tx, accountId, restored);
      await ledger.setCutoverRolledBack(tx, accountId);
      const result = { outcome: 'rolled_back' as const, accountId, restored };
      await hooks.onRolledBack(tx, result);
      return result;
    });
  }
}
