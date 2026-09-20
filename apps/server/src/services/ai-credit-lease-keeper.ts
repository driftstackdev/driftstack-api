// A task cut off by a crash, a deploy or a hang is settled from what it
// recorded — and nothing leaks (§4.7, §5.3).
//
// §5.3 calls the crash path the MAIN path, and it is: a deploy SIGTERMs the
// process while turns that run for minutes are still going, and the drain
// bounds itself at ten seconds. So the ordinary end of a task is not "the route
// settled it"; it is "the process that was running it went away". Everything
// here exists so that what happens next is decided by what the database
// already holds, and never by luck.
//
// ⛔ A TASK HOLDS THREE THINGS, AND ALL THREE LEAK TOGETHER. An open reservation
// holds one of the account's three slots, the credit its holds put beyond
// everyone's reach (not another task's, not a clawback's, not the expiry
// sweep's), and — until it settles — the charge the customer has not been told.
// Without a keeper, a process that dies mid-turn locks all three away until
// somebody settles the row by hand.
//
// Three jobs, one timer:
//
//   (a) THE HEARTBEAT keeps this process's LIVE tasks alive, every 15 seconds,
//       by pushing each lease 90 seconds out. It is the promise "I am still
//       here"; stop making it and, 90 seconds later, somebody else finishes the
//       task from what it recorded.
//   (b) THE SWEEP settles up to fifty tasks nobody is coming back for: the
//       lease lapsed, or the hard ceiling passed. One account at a time, its
//       credit row locked first.
//   (c) TEARDOWN hands back every lease this process holds, on the way out, so
//       the next boot frees a deploy's slots at once instead of 90 seconds
//       later.
//
// ⛔ THE LIVE SET ONLY EVER SHRINKS, AND ONLY THROUGH ITS OWNER (M1). `add` is
// called when a task reserves; `remove` in the owner's `finally`, WHATEVER the
// settle returned — a failed settle must still remove, or this process would
// renew that task's lease for ever and the keeper could never reach it. The
// keeper itself never removes: a task it cannot settle is a task it must keep
// trying. The database's own ceiling (`max_until`, at most 30 minutes) is the
// backstop for every way that could still go wrong, because the heartbeat
// refuses to renew past it.
//
// ⛔ A BOOT MUST NEVER SETTLE A LIVE LEASE (H6). There is NO single-process
// flag: a second boot, a canary, a manual `node dist/index.js` during an
// incident, and a deploy that runs migrations while the old process still
// serves are all ordinary. The boot pass is step (b) and nothing more, so it is
// safe with any number of processes — the only tasks it can touch are ones
// whose owner has stopped saying it is there.
//
// DARK. Bootstrap builds this only while DRIFTSTACK_AI_CREDITS_MODE is shadow
// or enforce; with the mode off there is no timer, no boot pass and no query.

import type {
  CreditLedgerExecutor,
  CreditLedgerTx,
  DrizzleCreditLedgerRepo,
} from '../db/credit-ledger-repo.js';
import type {
  CreditSettleReason,
  DrizzleCreditReservationsRepo,
  LapsedSettleReason,
} from '../db/credit-reservations-repo.js';
import type { Logger } from '../lib/logger.js';

/** How often the keeper heartbeats and sweeps (§5.3). */
export const CREDIT_LEASE_KEEPER_INTERVAL_MS = 15_000;

/**
 * How many abandoned tasks one sweep settles. A ceiling, not a target: each
 * settlement takes an account's credit lock and writes ledger rows, and a tick
 * that tried to drain an unbounded backlog would hold connections a live turn's
 * reserve is waiting on. What is left over is settled by the next tick, fifteen
 * seconds later.
 */
export const CREDIT_LEASE_KEEPER_BATCH = 50;

/** What one settlement did, as the keeper needs it. Narrower than the service's result. */
export interface CreditLeaseSettlement {
  readonly outcome: 'settled' | 'already_settled' | 'unknown';
  readonly chargedMicro: number;
}

/**
 * The settlement, inside a transaction the keeper already holds. The keeper
 * claims the task and settles it in ONE transaction, so a second keeper cannot
 * slip between the two.
 */
export interface CreditLeaseSettler {
  settleIn(
    tx: CreditLedgerTx,
    reservationId: string,
    reason: CreditSettleReason,
  ): Promise<CreditLeaseSettlement>;
}

export interface AiCreditLeaseKeeperDeps {
  readonly ledger: Pick<DrizzleCreditLedgerRepo, 'transaction' | 'lockAccount'>;
  readonly reservations: Pick<
    DrizzleCreditReservationsRepo,
    'renewLeases' | 'lapsedReservations' | 'claimLapsedReservation' | 'expireLeasesOfOwner'
  >;
  readonly settler: CreditLeaseSettler;
  /** The executor the lock-free statements run on: the pool, not a transaction. */
  readonly executor: CreditLedgerExecutor;
  /** This process's boot id. It owns the leases it takes, and only those. */
  readonly leaseOwner: string;
  readonly logger?: Logger;
  readonly batchSize?: number;
}

/** What one tick did. Counts only — never a reservation id or an account. */
export interface CreditLeaseKeeperTick {
  /** Tasks this process still says it is running. */
  readonly live: number;
  /** Of those, the ones whose lease the database moved. */
  readonly renewed: number;
  readonly settled: number;
  /** Candidates whose lease turned out to be live again, or already settled. */
  readonly skipped: number;
  readonly failed: number;
}

function errorFields(err: unknown): Record<string, unknown> {
  return err instanceof Error
    ? { name: err.name, message: err.message, cause: err.cause }
    : { value: err };
}

export class AiCreditLeaseKeeper {
  /** Tasks this process is running right now. Added on reserve, removed in the owner's finally. */
  private readonly live = new Set<string>();

  constructor(private readonly deps: AiCreditLeaseKeeperDeps) {}

  /** This task is running here: keep its lease alive until its owner says otherwise. */
  add(reservationId: string): void {
    this.live.add(reservationId);
  }

  /**
   * This task's owner has finished with it — whether it settled, refused or
   * threw (M1). After this the lease lapses on its own and the sweep finishes
   * whatever the owner could not.
   */
  remove(reservationId: string): void {
    this.live.delete(reservationId);
  }

  /** How many tasks this process is holding leases for. For tests and the tick log. */
  liveCount(): number {
    return this.live.size;
  }

  /**
   * One tick: heartbeat, then sweep. In that order, because a heartbeat is
   * cheap and a sweep is not — a tick that spent its time settling other
   * processes' abandoned tasks must not be the reason this process's own live
   * tasks lost their leases.
   */
  async tickOnce(): Promise<CreditLeaseKeeperTick> {
    const renewed = await this.heartbeat();
    const swept = await this.settleLapsed();
    return { live: this.live.size, renewed, ...swept };
  }

  /**
   * Push every live task's lease 90 seconds out (§4.7).
   *
   * ⛔ THE DATABASE DECIDES WHICH ROWS MOVE, not this set. The statement renews
   * only rows that are still open, still owned by THIS boot, and still inside
   * their ceiling — so a task another process has taken over, one already
   * settled, and one past `max_until` are all left alone even though this
   * process still lists them. The count that comes back is how many actually
   * moved, which is why it is worth returning.
   */
  private async heartbeat(): Promise<number> {
    if (this.live.size === 0) return 0;
    const renewed = await this.deps.reservations.renewLeases(this.deps.executor, {
      reservationIds: [...this.live],
      leaseOwner: this.deps.leaseOwner,
    });
    return renewed.length;
  }

  /**
   * Settle the tasks nobody is coming back for — the boot pass runs exactly
   * this and nothing else (H6).
   *
   * ⛔ ONE ACCOUNT AT A TIME, SERIALLY. Each settlement takes that account's
   * credit lock first and then the reservation's, which is the lock order every
   * credit writer uses. Settling in parallel would have several of them queued
   * on one account's lock while holding connections a live turn needs, and two
   * tasks of the SAME account would simply wait for each other anyway.
   *
   * ⛔ A FAILED SETTLEMENT IS COUNTED AND THE SWEEP CARRIES ON. One task whose
   * settlement throws — a lot that vanished, a constraint nobody expected —
   * must not stop the other forty-nine from being finished, and it will be
   * tried again in fifteen seconds. The tick never throws.
   */
  async settleLapsed(): Promise<{ settled: number; skipped: number; failed: number }> {
    const batch = this.deps.batchSize ?? CREDIT_LEASE_KEEPER_BATCH;
    let settled = 0;
    let skipped = 0;
    let failed = 0;
    const candidates = await this.deps.reservations.lapsedReservations(this.deps.executor, batch);
    for (const candidate of candidates) {
      try {
        const done = await this.settleOneLapsed(candidate.reservationId, candidate.accountId);
        if (done) settled += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        this.deps.logger?.error?.(
          {
            component: 'ai-credit-lease-keeper',
            event: 'ai_credits_lease_settle_failed',
            settleReason: candidate.reason,
            err: errorFields(err),
          },
          'settling an abandoned AI task failed — the keeper tries again on its next tick',
        );
      }
    }
    return { settled, skipped, failed };
  }

  /**
   * Claim one task and settle it, in one transaction.
   *
   * ⛔ THE CLAIM IS THE SAFETY (H6). `lapsedReservations` read without a lock,
   * so by now the task may have been renewed by the process that is still
   * running it, or settled by another keeper. `claimLapsedReservation` asks
   * again under the row's own lock, inside this transaction, and returns null
   * for both — which is the only reason a second process, a canary or a boot
   * pass is safe to run at all.
   *
   * The reason comes from the database too, not from the candidate read: a task
   * whose ceiling passed while the read was in flight is settled as `max_age`.
   */
  private async settleOneLapsed(reservationId: string, accountId: string): Promise<boolean> {
    return this.deps.ledger.transaction(async (tx) => {
      await this.deps.ledger.lockAccount(tx, accountId);
      const reason: LapsedSettleReason | null = await this.deps.reservations.claimLapsedReservation(
        tx,
        reservationId,
      );
      if (reason === null) return false;
      const result = await this.deps.settler.settleIn(tx, reservationId, reason);
      return result.outcome === 'settled';
    });
  }

  /**
   * The boot pass: step (b), once, at start-up (H6).
   *
   * It settles ONLY tasks whose lease has already lapsed or whose ceiling has
   * passed, so it is safe however many processes share the database. The old
   * design settled everything owned by another boot id and would have charged
   * every live task its full bound the moment anyone started a second process —
   * including the canary of a deploy, and including a deploy's own new process,
   * which comes up while the old one is still serving.
   */
  async bootPass(): Promise<{ settled: number; skipped: number; failed: number }> {
    return this.settleLapsed();
  }

  /**
   * Teardown: hand back every lease this process holds (H6).
   *
   * Expiring the lease is not settling the task — it says only "nobody is
   * running this any more", and the next boot's pass, or any other process's
   * next tick, then finishes it from what it recorded. That is what makes a
   * deploy free the customer's slots at once rather than 90 seconds later.
   *
   * ⛔ CALL IT BEFORE THE POOL CLOSES, and treat a failure as nothing worse
   * than today: if the statement does not land, every lease simply lapses on
   * its own schedule.
   */
  async releaseOwnLeases(): Promise<number> {
    const released = await this.deps.reservations.expireLeasesOfOwner(
      this.deps.executor,
      this.deps.leaseOwner,
    );
    if (released.length > 0) {
      this.deps.logger?.info?.(
        {
          component: 'ai-credit-lease-keeper',
          event: 'ai_credits_leases_released_at_shutdown',
          released: released.length,
        },
        'handed this process’s AI task leases back before shutting down',
      );
    }
    return released.length;
  }
}
