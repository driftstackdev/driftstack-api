// S15 — a real-database-backed `AiCreditsRuntime` (with its `.admin` and
// `.stateReads` bundles populated) for driving `routes/admin-ai-credits.ts`'s
// new admin routes through the FULL app (`buildTestApp({ aiCredits, ... })`),
// the same way bootstrap.ts wires it in production.
//
// Built on top of `credit-reservation-fixtures.ts`'s `reservationsHarness`
// (the real ledger/windows/reservations/rate-card repos + a real
// `CreditReservationsService`, already proven against the isolated database)
// rather than duplicating that construction: this file adds only what S15's
// admin surface needs beyond it — the plan-overrides repo, a second rate-card
// repo handle typed for the WRITER (the harness's own `rateCards` is typed as
// the narrower `CreditRateCardReader`), and the `stateReads`/`admin` bundles
// `AiCreditsRuntime` requires.

import type postgres from 'postgres';
import { DrizzleCreditPlanOverridesRepo } from '../../../src/db/credit-plan-overrides-repo.js';
import { DrizzleCreditRateCardRepo } from '../../../src/db/credit-rate-card-repo.js';
import { DrizzleCreditCutoverRepo } from '../../../src/db/credit-cutover-repo.js';
import { CreditGrantsService } from '../../../src/services/credit-grants.js';
import { CreditCutoverService } from '../../../src/services/credit-cutover.js';
import type { AiCreditsRuntime } from '../../../src/services/ai-credits-runtime.js';
import type { AiCreditsReportReader } from '../../../src/db/ai-credits-report-repo.js';
import { reservationsHarness, type ReservationsHarness } from './credit-reservation-fixtures.js';

export interface AdminCreditsHarness {
  readonly base: ReservationsHarness;
  readonly overrides: DrizzleCreditPlanOverridesRepo;
  readonly rateCardsWriter: DrizzleCreditRateCardRepo;
  readonly grants: CreditGrantsService;
  /** S16 */
  readonly cutoverRepo: DrizzleCreditCutoverRepo;
  readonly cutover: CreditCutoverService;
  readonly aiCredits: AiCreditsRuntime;
}

/** A report reader no admin-credits test calls; every method rejects loudly
 *  if a route somehow reaches it, the same convention
 *  `only-a-staff-key-can-read-the-ai-credits-report.test.ts`'s `creditsRuntime()`
 *  fixture uses for members outside what it exercises. */
function unusedReport(): AiCreditsReportReader {
  const unused = <T>(): Promise<T> =>
    Promise.reject(new Error('the admin-credits routes must not reach the shadow report'));
  return { shadowReport: unused, census: unused };
}

/** The real repos + a real `AiCreditsRuntime` (mode `enforce`, `.admin` and
 *  `.stateReads` both populated) over one connection pool on `url`.
 *  `internalEmails` (default empty) is C0's own predicate — see
 *  `services/credit-cutover.ts`. */
export function adminCreditsHarness(
  url: string,
  opts: { internalEmails?: ReadonlySet<string> } = {},
): AdminCreditsHarness {
  const base = reservationsHarness(url, { refresher: 'real' });
  const { database, ledger, windows, reservations } = base;
  const overrides = new DrizzleCreditPlanOverridesRepo(database);
  const rateCardsWriter = new DrizzleCreditRateCardRepo(database);
  const grants = new CreditGrantsService({ ledger, windows });
  const cutoverRepo = new DrizzleCreditCutoverRepo(database);
  const cutover = new CreditCutoverService({
    ledger,
    windows,
    cutoverRepo,
    creditGrants: grants,
    pool: database.db,
    internalEmails: opts.internalEmails ?? new Set(),
  });

  const aiCredits: AiCreditsRuntime = {
    mode: 'enforce',
    bootId: 'test-admin-credits-boot',
    reservations: base.service,
    leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
    report: unusedReport(),
    accounts: ledger,
    windows,
    stateReads: {
      heldMicro: ledger.heldMicro.bind(ledger),
      latestDebtReason: ledger.latestDebtReason.bind(ledger),
      monthlyLotForWindow: ledger.monthlyLotForWindow.bind(ledger),
      liveExtraLots: ledger.liveExtraLots.bind(ledger),
      ledgerPageWithBalance: ledger.ledgerPageWithBalance.bind(ledger),
      chargedForSessionMicro: ledger.chargedForSessionMicro.bind(ledger),
      pendingClaimTotalMicro: windows.pendingClaimTotalMicroNoLock.bind(windows),
      openEnforceCountNoLock: (accountId: string) =>
        reservations.openEnforceCountNoLock(accountId, database.db),
      cardInForce: rateCardsWriter.cardInForce.bind(rateCardsWriter),
      nextAnnouncedCard: rateCardsWriter.nextAnnouncedCard.bind(rateCardsWriter),
      modelRow: rateCardsWriter.modelRow.bind(rateCardsWriter),
    },
    admin: {
      transaction: ledger.transaction.bind(ledger),
      lockAccount: ledger.lockAccount.bind(ledger),
      insertLot: ledger.insertLot.bind(ledger),
      getLot: ledger.getLot.bind(ledger),
      append: ledger.append.bind(ledger),
      settleDebtFromFree: ledger.settleDebtFromFree.bind(ledger),
      planOverrides: overrides,
      rateCards: rateCardsWriter,
      refreshCredits: grants.refreshCredits.bind(grants),
    },
    cutover: {
      planCutover: cutover.planCutover.bind(cutover),
      runCutover: cutover.runCutover.bind(cutover),
      previewRollback: cutover.previewRollback.bind(cutover),
      rollbackAccount: cutover.rollbackAccount.bind(cutover),
    },
  };

  return { base, overrides, rateCardsWriter, grants, cutoverRepo, cutover, aiCredits };
}

export { type ReservationsHarness };
export type Sql = postgres.Sql | postgres.TransactionSql;
