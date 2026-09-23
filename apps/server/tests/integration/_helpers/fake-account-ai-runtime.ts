// A scripted `AiCreditsRuntime` for the S14 customer routes
// (`routes/account-ai.ts`, `routes/ai-models.ts`) — every statement those
// routes can reach answers from a mutable `state`, and every account id a read
// was asked about is recorded, so a test can prove WHICH account a route read
// (act-as) and WHETHER it refreshed first, without a database. The real SQL
// underneath is proved against Postgres in
// the-credit-ledger-route-survives-debt-and-groups-a-tasks-charges-on-a-real-database.test.ts.

import { CREDIT_RATE_CARD_V1, type AiSource, type AiSourceSetBy } from '@driftstack/api-types';
import type {
  AiCreditsRuntime,
  AiCreditsStateReads,
  CreditAccountRecord,
  CurrentCreditWindow,
} from '../../../src/services/ai-credits-runtime.js';
import type {
  CreditLedgerPageWithBalance,
  CreditLedgerRecordWithBalance,
  CreditLotRecord,
} from '../../../src/db/credit-ledger-repo.js';
import type {
  CreditRateCardModelRecord,
  CreditRateCardRecord,
} from '../../../src/db/credit-rate-card-repo.js';
import type { CreditPlanOverrideRecord } from '../../../src/db/credit-plan-overrides-repo.js';

export const MICRO = 1_000_000;

export const CARD_V1: CreditRateCardRecord = {
  version: 1,
  markupBp: 20_000,
  announcedAt: new Date('2025-12-01T00:00:00Z'),
  effectiveAt: new Date('2026-01-01T00:00:00Z'),
  withdrawnAt: null,
  createdByKeyId: null,
  note: 'v1',
};

/** The launch card's row for `model`, or null for a model it does not price. */
export function launchCardRow(model: string): CreditRateCardModelRecord | null {
  const row = (
    CREDIT_RATE_CARD_V1.models as Record<
      string,
      (typeof CREDIT_RATE_CARD_V1.models)['claude-sonnet-5']
    >
  )[model];
  return row === undefined ? null : { ...row, version: 1, model };
}

export interface FakeAccountAiState {
  mode: 'shadow' | 'enforce';
  billingMode: 'legacy' | 'credits';
  aiSource: AiSource | null;
  aiSourceSetBy: AiSourceSetBy | null;
  debtMicro: number;
  window: CurrentCreditWindow | null;
  monthlyLot: CreditLotRecord | null;
  extraLots: CreditLotRecord[];
  spendableMicro: number;
  tasksInFlight: number;
  ledgerEntries: CreditLedgerRecordWithBalance[];
  planOverride: CreditPlanOverrideRecord | null;
  /** What the refresh does; default: nothing. May mutate `state`. */
  refresh: (accountId: string) => Promise<void>;
}

export interface FakeAccountAiCalls {
  readonly ensureAccount: string[];
  readonly ledgerPage: string[];
  readonly refresh: string[];
  readonly setAiSource: string[];
}

export function fakeAccountAiRuntime(initial: Partial<FakeAccountAiState> = {}): {
  runtime: AiCreditsRuntime;
  state: FakeAccountAiState;
  calls: FakeAccountAiCalls;
} {
  const state: FakeAccountAiState = {
    mode: 'enforce',
    billingMode: 'credits',
    aiSource: 'credits',
    aiSourceSetBy: null,
    debtMicro: 0,
    window: null,
    monthlyLot: null,
    extraLots: [],
    spendableMicro: 0,
    tasksInFlight: 0,
    ledgerEntries: [],
    planOverride: null,
    refresh: () => Promise.resolve(),
    ...initial,
  };
  const calls = { ensureAccount: [], ledgerPage: [], refresh: [], setAiSource: [] } as {
    ensureAccount: string[];
    ledgerPage: string[];
    refresh: string[];
    setAiSource: string[];
  };
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('the S14 customer routes never reach this'));
  const record = (accountId: string): CreditAccountRecord => ({
    accountId,
    billingMode: state.billingMode,
    aiSource: state.aiSource,
    aiSourceSetBy: state.aiSourceSetBy,
    aiSourceSetAt: null,
    debtMicro: state.debtMicro,
    autoTopUpEnabled: false,
    legacyConsentAtMove: null,
    legacyCapCentsAtMove: null,
    hadStoredKeyAtMove: null,
    movedToCreditsAt: null,
    movedBackAt: null,
  });
  const stateReads: AiCreditsStateReads = {
    heldMicro: () => Promise.resolve(0),
    latestDebtReason: () => Promise.resolve(state.debtMicro > 0 ? 'payment_reversed' : null),
    monthlyLotForWindow: () => Promise.resolve(state.monthlyLot),
    liveExtraLots: () => Promise.resolve([...state.extraLots]),
    ledgerPageWithBalance: (accountId: string): Promise<CreditLedgerPageWithBalance> => {
      calls.ledgerPage.push(accountId);
      return Promise.resolve({ entries: [...state.ledgerEntries], nextCursor: null });
    },
    chargedForSessionMicro: unreachable,
    pendingClaimTotalMicro: () => Promise.resolve(0),
    openEnforceCountNoLock: () => Promise.resolve(state.tasksInFlight),
    cardInForce: () => Promise.resolve(CARD_V1),
    nextAnnouncedCard: () => Promise.resolve(null),
    modelRow: (_version: number, model: string) => Promise.resolve(launchCardRow(model)),
    planOverride: () => Promise.resolve(state.planOverride),
    refreshCredits: async (accountId: string) => {
      calls.refresh.push(accountId);
      await state.refresh(accountId);
      return {
        expired: [],
        window: { outcome: 'none' },
        level: null,
        repaid: [],
        currentWindowEnd: null,
      };
    },
  };
  const runtime: AiCreditsRuntime = {
    get mode() {
      return state.mode;
    },
    bootId: 'boot-fake-account-ai',
    reservations: {
      reserve: unreachable,
      settle: unreachable,
      planCall: unreachable,
      admitCall: unreachable,
      markSent: unreachable,
      settleCall: unreachable,
    },
    leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
    report: { shadowReport: unreachable, census: unreachable },
    accounts: {
      ensureAccount: (accountId: string) => {
        calls.ensureAccount.push(accountId);
        return Promise.resolve(record(accountId));
      },
      setAiSource: (
        accountId: string,
        args: { aiSource: AiSource | null; setBy: AiSourceSetBy },
      ) => {
        calls.setAiSource.push(accountId);
        state.aiSource = args.aiSource;
        state.aiSourceSetBy = args.setBy;
        return Promise.resolve(record(accountId));
      },
      spendableMicro: () => Promise.resolve(state.spendableMicro),
      otherLiveGrantedMicro: unreachable,
      chargedInWindowMicro: unreachable,
    },
    windows: { currentWindow: () => Promise.resolve(state.window) },
    stateReads,
  };
  return { runtime, state, calls };
}

/** A live window and its funded monthly lot, `credits` granted and unspent. */
export function liveMonthly(credits: number): {
  window: CurrentCreditWindow;
  monthlyLot: CreditLotRecord;
} {
  return {
    window: {
      id: 'window-1',
      windowStart: '2026-06-01T00:00:00.000000Z',
      windowEnd: '2026-07-01T00:00:00.000000Z',
      levelMicro: credits * MICRO,
    },
    monthlyLot: {
      id: 'lot-monthly-1',
      accountId: 'acct',
      kind: 'monthly',
      spendRank: 0,
      windowId: 'window-1',
      grantKey: 'window:window-1',
      grantedMicro: credits * MICRO,
      remainingMicro: credits * MICRO,
      heldMicro: 0,
      startsAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: new Date('2026-07-01T00:00:00Z'),
      revokedAt: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    },
  };
}
