// S16 — the PURE half of the per-account cutover: `decideCutoverAiSource`
// (§8.5's mapping) and `decideCutover` (§8.4's whole per-account decision),
// plus `summarizeCutoverDecisions` and the selector's Phase-2 refusal. No
// clock, no database, no HTTP — the integration suite
// (admin-ai-credits-routes.test.ts / credit-cutover-service.test.ts) proves
// these wired into the real routes and a real database; this file proves the
// policy decisions on their own, with every input named.

import { describe, expect, it } from 'vitest';
import {
  decideCutover,
  decideCutoverAiSource,
  summarizeCutoverDecisions,
  CreditCutoverService,
  legacyConsentOnRollback,
  PhaseTwoCohortError,
  type CutoverAccountDecisionFacts,
  type CutoverDecision,
} from '../../src/services/credit-cutover.js';

describe('decideCutoverAiSource — §8.5’s mapping', () => {
  it('a plan that forbids an own key (Personal) always gets credits, whatever the key or consent say', () => {
    for (const hasStoredKey of [true, false]) {
      for (const consent of [true, false]) {
        expect(
          decideCutoverAiSource({ ownKeyAllowed: false, hasStoredKey, consent }),
          `hasStoredKey=${String(hasStoredKey)} consent=${String(consent)}`,
        ).toBe('credits');
      }
    }
  });

  it('no stored key gets credits, whatever consent says — "consented, no key" and "no key on Team/Agency/Starter" are the same fact', () => {
    expect(decideCutoverAiSource({ ownKeyAllowed: true, hasStoredKey: false, consent: true })).toBe(
      'credits',
    );
    expect(
      decideCutoverAiSource({ ownKeyAllowed: true, hasStoredKey: false, consent: false }),
    ).toBe('credits');
  });

  it('a stored key with consent off gets own_key (H3: key only, never credits)', () => {
    expect(decideCutoverAiSource({ ownKeyAllowed: true, hasStoredKey: true, consent: false })).toBe(
      'own_key',
    );
  });

  it('a stored key with consent on gets automatic (null) — key first, credits when it is missing', () => {
    expect(decideCutoverAiSource({ ownKeyAllowed: true, hasStoredKey: true, consent: true })).toBe(
      null,
    );
  });
});

/** A base set of facts for `decideCutover`, overridden per test. */
function facts(over: Partial<CutoverAccountDecisionFacts> = {}): CutoverAccountDecisionFacts {
  return {
    billingMode: 'legacy',
    status: 'active',
    tier: 'team_manual',
    consent: false,
    hasStoredKey: false,
    hasPaidCoverage: true,
    hasLiveContractOverride: false,
    inPhaseOneCohort: true,
    ...over,
  };
}

describe('decideCutover — §8.4’s per-account decision', () => {
  it('a deleted account is refused, ahead of every other check', () => {
    const d = decideCutover('a1', facts({ status: 'deleted', billingMode: 'credits' }));
    expect(d).toEqual({ accountId: 'a1', outcome: 'refuse', reason: 'account_deleted' });
  });

  it('an already-moved account is reported already_moved and skipped — idempotent, never re-decided on its plan', () => {
    const d = decideCutover('a1', facts({ billingMode: 'credits', tier: 'free' }));
    expect(d).toEqual({ accountId: 'a1', outcome: 'already_moved' });
  });

  it('Free stays untouched: not_eligible, whatever else is true of the account', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'free', hasPaidCoverage: true, consent: true, hasStoredKey: true }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'not_eligible', reason: 'free_plan' });
  });

  it('a paid account with no paid coverage and no admin override stays legacy and is listed as refused', () => {
    const d = decideCutover('a1', facts({ tier: 'api_scale', hasPaidCoverage: false }));
    expect(d).toEqual({ accountId: 'a1', outcome: 'refuse', reason: 'no_paid_coverage' });
  });

  it('Enterprise without a contract stays legacy, refused no_contract — its plan-wide allowance is "contract"', () => {
    const d = decideCutover('a1', facts({ tier: 'enterprise', hasPaidCoverage: false }));
    expect(d).toEqual({ accountId: 'a1', outcome: 'refuse', reason: 'no_contract' });
  });

  it('CRITICAL Enterprise with paid coverage from some OTHER plan (a Stripe line) but no contract is refused no_contract (S16 audit #3, M7)', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'enterprise', hasPaidCoverage: true, hasLiveContractOverride: false }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'refuse', reason: 'no_contract' });
  });

  it('Enterprise WITH a live contract override moves — the override is its paid coverage too', () => {
    const d = decideCutover(
      'a1',
      facts({
        tier: 'enterprise',
        hasPaidCoverage: true,
        hasLiveContractOverride: true,
        hasStoredKey: false,
      }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'move', aiSource: 'credits' });
  });

  it('Enterprise with a contract that grants nothing is still refused no_paid_coverage', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'enterprise', hasPaidCoverage: false, hasLiveContractOverride: true }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'refuse', reason: 'no_paid_coverage' });
  });

  it('a plan with a plan-wide allowance never needs a contract', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'api_scale', hasPaidCoverage: true, hasLiveContractOverride: false }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'move', aiSource: 'credits' });
  });

  it('CRITICAL an account outside C0 is refused not_in_phase_1_cohort, whatever else is true of it (S16 audit #6)', () => {
    for (const over of [
      {},
      { billingMode: 'credits' as const },
      { tier: 'free' as const },
      { tier: 'enterprise' as const, hasLiveContractOverride: true },
    ]) {
      expect(decideCutover('a1', facts({ ...over, inPhaseOneCohort: false }))).toEqual({
        accountId: 'a1',
        outcome: 'refuse',
        reason: 'not_in_phase_1_cohort',
      });
    }
  });

  it('a deleted account is refused account_deleted even outside C0 — deletion is checked first', () => {
    expect(decideCutover('a1', facts({ status: 'deleted', inPhaseOneCohort: false }))).toEqual({
      accountId: 'a1',
      outcome: 'refuse',
      reason: 'account_deleted',
    });
  });

  it('Personal (solo_manual) moves onto credits-only, a stored key notwithstanding', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'solo_manual', hasStoredKey: true, consent: true }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'move', aiSource: 'credits' });
  });

  it('Team/Agency/Starter/Builder/Scale with no key moves onto credits — today a dead-end 402', () => {
    for (const tier of [
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ] as const) {
      const d = decideCutover('a1', facts({ tier, hasStoredKey: false, consent: false }));
      expect(d, tier).toEqual({ accountId: 'a1', outcome: 'move', aiSource: 'credits' });
    }
  });

  it('a stored key with consent off moves onto own_key', () => {
    const d = decideCutover(
      'a1',
      facts({ tier: 'api_builder', hasStoredKey: true, consent: false }),
    );
    expect(d).toEqual({ accountId: 'a1', outcome: 'move', aiSource: 'own_key' });
  });

  it('a stored key with consent moves onto automatic (null)', () => {
    const d = decideCutover('a1', facts({ tier: 'api_scale', hasStoredKey: true, consent: true }));
    expect(d).toEqual({ accountId: 'a1', outcome: 'move', aiSource: null });
  });
});

describe('summarizeCutoverDecisions', () => {
  it('buckets a flat decision list by outcome, in order, without recomputing anything', () => {
    const decisions: CutoverDecision[] = [
      { accountId: 'a1', outcome: 'move', aiSource: 'credits' },
      { accountId: 'a2', outcome: 'move', aiSource: null },
      { accountId: 'a3', outcome: 'already_moved' },
      { accountId: 'a4', outcome: 'not_eligible', reason: 'free_plan' },
      { accountId: 'a5', outcome: 'refuse', reason: 'no_paid_coverage' },
      { accountId: 'a6', outcome: 'refuse', reason: 'account_not_found' },
    ];
    expect(summarizeCutoverDecisions(decisions)).toEqual({
      moved: [
        { accountId: 'a1', aiSource: 'credits' },
        { accountId: 'a2', aiSource: null },
      ],
      alreadyMoved: ['a3'],
      notEligible: [{ accountId: 'a4', reason: 'free_plan' }],
      refused: [
        { accountId: 'a5', reason: 'no_paid_coverage' },
        { accountId: 'a6', reason: 'account_not_found' },
      ],
    });
  });

  it('an empty decision list summarizes to every bucket empty — the negative control for the arm above', () => {
    expect(summarizeCutoverDecisions([])).toEqual({
      moved: [],
      alreadyMoved: [],
      notEligible: [],
      refused: [],
    });
  });
});

describe('CreditCutoverService.resolveSelector — the Phase-2 cohort refusal', () => {
  /** Every dependency throws if touched: a Phase-2 cohort must be refused
   *  before anything is read, not merely before anything is written. */
  function unreachableService(): CreditCutoverService {
    const unreachable = (): Promise<never> =>
      Promise.reject(new Error('must not be reached for a Phase-2 cohort'));
    return new CreditCutoverService({
      ledger: {
        transaction: unreachable,
        lockAccount: unreachable,
        peekAccount: unreachable,
        setAiSourceIn: unreachable,
        setCutoverMoved: unreachable,
        setCutoverRolledBack: unreachable,
      },
      cutoverRepo: {
        readAccountFacts: unreachable,
        lockAccountFacts: unreachable,
        readBillingMode: unreachable,
        restoreLegacySettings: unreachable,
        listCohortAccountIds: unreachable,
        coverageFacts: unreachable,
      },
      creditGrants: { refreshCreditsIn: unreachable },
      pool: {} as never,
      internalEmails: new Set(),
    });
  }

  it('account_ids is accepted (and resolves to exactly the ids given) without touching any dependency', async () => {
    const service = unreachableService();
    await expect(
      service.resolveSelector({ kind: 'account_ids', accountIds: ['x', 'y'] }),
    ).resolves.toEqual(['x', 'y']);
  });

  it('C0 is accepted — this slice’s only cohort', async () => {
    // C0 DOES read `listCohortAccountIds`, so this only proves it is not
    // refused before that read — the read itself is proved against a real
    // database in the integration suite.
    const unreachable = (): Promise<never> => Promise.reject(new Error('unused'));
    const service = new CreditCutoverService({
      ledger: {
        transaction: unreachable,
        lockAccount: unreachable,
        peekAccount: unreachable,
        setAiSourceIn: unreachable,
        setCutoverMoved: unreachable,
        setCutoverRolledBack: unreachable,
      },
      cutoverRepo: {
        readAccountFacts: unreachable,
        lockAccountFacts: unreachable,
        readBillingMode: unreachable,
        restoreLegacySettings: unreachable,
        listCohortAccountIds: () => Promise.resolve(['internal-1']),
        coverageFacts: unreachable,
      },
      creditGrants: { refreshCreditsIn: unreachable },
      pool: {} as never,
      internalEmails: new Set(['staff@example.test']),
    });
    await expect(service.resolveSelector({ kind: 'cohort', cohort: 'C0' })).resolves.toEqual([
      'internal-1',
    ]);
  });

  it.each(['C1', 'C2', 'C3', 'C4'] as const)(
    'cohort %s is refused with PhaseTwoCohortError, not silently accepted',
    async (cohort) => {
      const service = unreachableService();
      await expect(service.resolveSelector({ kind: 'cohort', cohort })).rejects.toThrow(
        PhaseTwoCohortError,
      );
    },
  );
});

describe('legacyConsentOnRollback — what a rollback puts back as the legacy consent (S16 audit #10)', () => {
  it('CRITICAL a customer who chose their own key while moved rolls back with consent false, whatever the snapshot says', () => {
    expect(legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'customer' }, true)).toBe(
      false,
    );
    expect(legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'customer' }, false)).toBe(
      false,
    );
  });

  it('any other customer choice keeps the snapshot', () => {
    for (const snapshot of [true, false]) {
      expect(legacyConsentOnRollback({ aiSource: null, aiSourceSetBy: 'customer' }, snapshot)).toBe(
        snapshot,
      );
      expect(
        legacyConsentOnRollback({ aiSource: 'credits', aiSourceSetBy: 'customer' }, snapshot),
      ).toBe(snapshot);
    }
  });

  it('a source the cutover (or an admin) chose keeps the snapshot — own_key included', () => {
    expect(legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'cutover' }, true)).toBe(
      true,
    );
    expect(legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'admin' }, true)).toBe(
      true,
    );
  });
});
