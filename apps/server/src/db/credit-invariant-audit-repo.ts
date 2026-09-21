// Asks the credit tables, once a day, whether they still agree with themselves
// (§5.3, "Daily invariant audit").
//
// Every rule below is ALREADY enforced — by a CHECK, a trigger, a COMMIT-time
// constraint trigger, or by the code that writes the rows. That is exactly why
// this exists. A guard that has been switched off, a trigger dropped by a
// migration that meant to drop something else, a statement that found a way
// round one of them, or a restore from a backup taken mid-transaction all leave
// the same trace: records that no longer add up, and nothing that ever asks.
// The enforcement says "this cannot happen"; the audit is the thing that checks
// whether that is still true.
//
// ⛔ EVERY CHECK IS A COUNT AND NOTHING ELSE. What comes back is a number per
// rule — never an account id, an email, a model name, an amount or a row. The
// breach travels from here into an alert that reaches a person, and a person's
// inbox is not a place customer data goes. Whoever investigates has the
// database.
//
// ⛔ READ-ONLY. Nothing here writes, so a fault in the audit can cost at most an
// alert; and each check is one statement, so the audit is one pass and not a
// walk that could hold a connection for minutes.
//
// Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01) and list prices
// are microcents per token — the same unit, because 1 credit is 1 cent. That is
// what lets `shadow_charge_vs_list_price` compare the two at all.

import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import type { CreditLedgerExecutor } from './credit-ledger-repo.js';
import { rowsOf } from './credit-ledger-repo.js';

/**
 * The rules the audit asks about, in the order §5.3 lists them. A closed set,
 * so a check name is safe to put in a log line, a metric label and an alert
 * subject.
 *
 * Two rules are NOT in §5.3's list and are here anyway, each beside the §5.3
 * rule it completes: `hold_open_past_its_task` beside the holds rule, because
 * a lot and a hold can agree with each other while the hold itself has
 * outlived the task it backs; and `rate_card_rate_vs_list_price` beside the
 * shadow rule, because the shadow comparison cannot reach a card's cache
 * rungs. Both are conditions the enforcement is supposed to make impossible
 * and does not, which is this file's subject.
 */
export const CREDIT_INVARIANT_CHECKS = [
  'lot_balance_vs_ledger',
  'account_debt_vs_ledger',
  'lot_held_vs_holds',
  'hold_open_past_its_task',
  'reservation_open_past_max_until',
  'claim_pending_with_no_open_hold',
  'shadow_charge_vs_list_price',
  'rate_card_rate_vs_list_price',
  'active_subscription_without_paid_invoice',
] as const;

export type CreditInvariantCheck = (typeof CREDIT_INVARIANT_CHECKS)[number];

/** One rule and how many rows break it. Zero for a rule that holds. */
export type CreditInvariantCounts = Readonly<Record<CreditInvariantCheck, number>>;

/**
 * How long past its hard ceiling a task may still be open before the audit
 * calls it a breach.
 *
 * The lease keeper settles a task at `max_until` within one 15-second tick, so
 * a task a few seconds past its ceiling is the system WORKING. Without this
 * grace the audit would alert on the ordinary case whenever its daily run
 * happened to land inside that window — an alert that means nothing is worse
 * than no alert, because it teaches the reader to ignore the next one.
 */
export const CREDIT_AUDIT_MAX_UNTIL_GRACE_MINUTES = 5;

/**
 * How far a shadow measurement may sit from the list price it should be twice
 * before it counts as a breach: one percent, and never less than one
 * microcredit, because integer rounding alone moves a small charge by one.
 */
export const CREDIT_AUDIT_SHADOW_TOLERANCE_FRACTION = 0.01;

/** Basis points in one whole multiple — `credit_rate_cards.markup_bp` is in these. */
const BASIS_POINTS = 10_000;

function count(result: unknown, what: string): number {
  const n = Number(rowsOf<{ n: string }>(result)[0]?.n ?? '-1');
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} did not count`);
  return n;
}

export class DrizzleCreditInvariantAuditRepo {
  constructor(private readonly database: Database) {}

  /**
   * Every lot's balance is the sum of the ledger rows that moved it.
   *
   * `credit_lots.remaining_micro` moves only through `credit_ledger_apply`, so
   * the two are written by one statement and can only part company if that
   * trigger stops firing. A lot with no ledger row at all must be empty, which
   * is why the join is a LEFT one: a funded lot whose `grant` row vanished is
   * the shape a restore-to-a-wrong-point produces, and it reads as free credit.
   */
  async lotBalanceVsLedger(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT l.id FROM credit_lots l
         LEFT JOIN credit_ledger g ON g.lot_id = l.id
         GROUP BY l.id, l.remaining_micro
        HAVING COALESCE(SUM(g.lot_delta_micro), 0) <> l.remaining_micro) x`);
    return count(result, 'lot balances');
  }

  /** Every account's debt is the sum of the ledger's debt movements for it. */
  async accountDebtVsLedger(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT a.account_id FROM credit_accounts a
         LEFT JOIN credit_ledger g ON g.account_id = a.account_id
         GROUP BY a.account_id, a.debt_micro
        HAVING COALESCE(SUM(g.debt_delta_micro), 0) <> a.debt_micro) x`);
    return count(result, 'account debts');
  }

  /**
   * Every lot holds exactly what the unreleased holds on it say.
   *
   * Held credit is the one amount that is spendable by nobody: not another
   * task, not a clawback, not the expiry sweep. A lot holding more than its
   * holds is credit the customer paid for and can never use, and nothing else
   * in the system would ever notice — the holds are what a settlement walks,
   * and it walks the ones that exist.
   */
  async lotHeldVsHolds(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT l.id FROM credit_lots l
         LEFT JOIN credit_reservation_holds h ON h.lot_id = l.id AND h.released_at IS NULL
         GROUP BY l.id, l.held_micro
        HAVING COALESCE(SUM(h.held_micro), 0) <> l.held_micro) x`);
    return count(result, 'lot holds');
  }

  /**
   * No hold outlives the task it backs.
   *
   * `lot_held_vs_holds` above asks whether a lot and its holds agree; this asks
   * whether the holds themselves still mean anything. They are different
   * questions, and a hold left behind by a task that has ended answers the
   * first one perfectly: the lot holds exactly what the hold says, and the
   * credit is gone anyway. It is spendable by nobody — every spendable
   * predicate is `remaining − held`, and so is `expireDueLots` — and no
   * settlement will ever walk it, because the settlement that would have has
   * already run and `credit_reservations_guard` refuses to let a settled task
   * change again.
   *
   * ⛔ TWO SHAPES, ONE CONDITION: A HOLD WHOSE TASK IS NOT A RUNNING ENFORCED
   * ONE. A hold on a SETTLED task is credit frozen after the fact. A hold on a
   * SHADOW task is credit frozen behind a measurement that is not supposed to
   * hold anything at all — `settleIn` returns before the holds walk for a
   * shadow reservation, so nothing there would ever release it either.
   *
   * ⛔ AND IT IS STILL REACHABLE — BUT NO LONGER BY AN ORDINARY STATEMENT, and
   * the difference is worth stating because it is what this audit is now for.
   * When this check was written a statement touching ONLY
   * `credit_reservation_holds` fired no COMMIT-time reservation check at all:
   * the only `credit_check_reservation` triggers hung off `credit_model_calls`
   * and `credit_reservations`, so the database simply accepted the row. 0132
   * added a third leg on `credit_ledger`, and 0133 added the fourth,
   * `credit_holds_reservation_balance`, on this very table — so a hold added to
   * an ENFORCED task by itself is now refused at COMMIT, because the task's
   * holds would no longer sum to what it reserved, and 0132's
   * `credit_holds_apply` lookup refuses a hold whose task is not open and
   * enforced before that.
   *
   * Two routes stay open, which is why this still runs. A hold on a SHADOW task
   * is judged by neither leg — `credit_check_reservation` returns for a
   * measurement before it reaches the holds — so only that INSERT-time lookup
   * stands between it and a frozen lot. And every shape arrives anyway when the
   * triggers are not firing: a guard dropped by a migration that meant to drop
   * something else, a restore from a backup taken mid-transaction, a
   * replication apply. Enforcement narrowing the ways in is not a reason to
   * stop asking whether the state is there.
   *
   * ⛔ IT IS THE HOLD'S OWN TASK THAT IS ASKED ABOUT, never the account's. A
   * correlation on `account_id` would let a stranded hold hide behind any live
   * turn on the same account — invisible for every customer still using the
   * product and visible only for the ones who had stopped. The arm that pins
   * this is the one seeding a stranded hold beside a task that is still
   * running.
   *
   * The whole reservation test sits inside the `NOT EXISTS`, so a hold whose
   * reservation has vanished altogether satisfies it and is COUNTED rather than
   * dropped: an unreadable row is a finding, never a silence.
   */
  async holdOpenPastItsTask(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservation_holds h
       WHERE h.released_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM credit_reservations r
                          WHERE r.id = h.reservation_id
                            AND r.state = 'open' AND r.mode = 'enforce')`);
    return count(result, 'holds outliving their task');
  }

  /**
   * No task is still open well past its hard ceiling (M1).
   *
   * This is the lease keeper's own liveness, asked from the other side: the
   * keeper settles a task at `max_until`, so a task minutes past it means the
   * keeper is not running — in which case every abandoned task's slot and
   * credit are leaking and nothing else says so.
   */
  async reservationOpenPastMaxUntil(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservations
       WHERE state = 'open'
         AND max_until < now() - make_interval(mins => ${CREDIT_AUDIT_MAX_UNTIL_GRACE_MINUTES})`);
    return count(result, 'open reservations past their ceiling');
  }

  /**
   * No clawback is still waiting on credit that no running task holds (M5).
   *
   * A pending claim is paid out of what a running task releases when it ends.
   * With no open hold on the account there is no task left to release
   * anything, so the claim can never be paid and can never become debt either:
   * it simply waits for ever, and the customer's balance silently overstates
   * what they may spend by the amount that was clawed back.
   *
   * ⛔ THE SUBJECT IS A RUNNING TASK, NOT AN UNRELEASED HOLD ROW, and the two
   * are not the same thing. A hold stranded on a task that has already ended
   * (see `holdOpenPastItsTask`) is an unreleased row that NOTHING will ever
   * release — the settlement that would have walked it has run, and a settled
   * task is final. Asked only for a hold row, this rule reports such an
   * account healthy while its claim waits for ever: measured, and it is why
   * `r.state = 'open' AND r.mode = 'enforce'` is here. A shadow task holds
   * nothing and releases nothing, so it cannot pay a claim either.
   */
  async claimPendingWithNoOpenHold(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_clawbacks c
       WHERE c.pending_micro > 0
         AND NOT EXISTS (SELECT 1 FROM credit_reservation_holds h
                           JOIN credit_reservations r ON r.id = h.reservation_id
                          WHERE h.account_id = c.account_id AND h.released_at IS NULL
                            AND r.state = 'open' AND r.mode = 'enforce')`);
    return count(result, 'pending claims');
  }

  /**
   * A shadow measurement costs about the card's markup times the provider's
   * list price for the same tokens (§5.3).
   *
   * This is the only check that re-derives money from FIRST PRINCIPLES rather
   * than comparing two records of the same write: the charge is re-computed
   * here, in SQL, from the token counts the provider reported and the list
   * prices the card recorded, and compared with what the service worked out.
   * Agreement means two independent calculations of one number agree, which is
   * what makes shadow mode evidence for switching enforcement on.
   *
   * ⛔ ONLY CACHE-FREE CALLS PRICED FROM PROVIDER USAGE. A card records a list
   * price for input and output and none for the three cache rates, so a call
   * that read or wrote cache cannot be re-derived from list at all — its rungs
   * are held instead by `rate_card_rate_vs_list_price`, which checks the ladder
   * the cache rates hang off. And any basis other than `provider_usage` is
   * priced from a rule rather than from tokens (the bound, zero, or the output
   * ceiling), so there is no list price it should equal.
   */
  async shadowChargeVsListPrice(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM (
        SELECT c.id
          FROM credit_model_calls c
          JOIN credit_reservations r ON r.id = c.reservation_id
          JOIN credit_rate_cards card ON card.version = r.rate_card_version
          JOIN credit_rate_card_models m
            ON m.version = r.rate_card_version AND m.model = c.model
         WHERE r.mode = 'shadow' AND c.state = 'settled' AND c.settle_basis = 'provider_usage'
           AND COALESCE(c.cache_read_tokens, 0) = 0
           AND COALESCE(c.cache_write_5m_tokens, 0) = 0
           AND COALESCE(c.cache_write_1h_tokens, 0) = 0
           AND abs(COALESCE(c.actual_micro, 0)::numeric
                   - (COALESCE(c.uncached_input_tokens, 0)::numeric
                        * m.list_input_microcents_per_token
                      + COALESCE(c.output_tokens, 0)::numeric
                        * m.list_output_microcents_per_token)
                     * card.markup_bp / ${BASIS_POINTS})
               > GREATEST(1::numeric,
                          COALESCE(c.actual_micro, 0)::numeric
                            * ${CREDIT_AUDIT_SHADOW_TOLERANCE_FRACTION})) x`);
    return count(result, 'shadow charges');
  }

  /**
   * Every published card charges its own markup over the list price it recorded.
   *
   * The owner's promise is a number — list price times two — and the rates a
   * task is actually charged are separate columns written when the card was
   * published. Nothing re-checks them afterwards, so a card published with one
   * rate mistyped would overcharge every task on that model for as long as it
   * was in force, and every other record would agree with itself perfectly.
   */
  async rateCardRateVsListPrice(on: CreditLedgerExecutor = this.database.db): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_rate_card_models m
        JOIN credit_rate_cards c ON c.version = m.version
       WHERE m.input_micro_per_token
             <> round(m.list_input_microcents_per_token::numeric * c.markup_bp / ${BASIS_POINTS})
          OR m.output_micro_per_token
             <> round(m.list_output_microcents_per_token::numeric * c.markup_bp / ${BASIS_POINTS})`);
    return count(result, 'rate card rows');
  }

  /**
   * No subscription is active without a paid invoice covering this instant
   * (H1).
   *
   * Credits are granted from PAID coverage and never from the subscription
   * mirror, which turns active before a renewal's payment is even attempted. An
   * active subscription with no paid invoice covering now is either a renewal
   * whose payment failed and was not noticed, or a webhook that never arrived —
   * and in both cases the account is being treated as a paying customer by
   * everything that reads the mirror.
   */
  async activeSubscriptionWithoutPaidInvoice(
    on: CreditLedgerExecutor = this.database.db,
  ): Promise<number> {
    const result = await on.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM subscriptions s
       WHERE s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM billing_invoice_payments p
                          WHERE p.account_id = s.account_id
                            AND p.stripe_subscription_id = s.stripe_subscription_id
                            AND p.line_kind IS NOT NULL
                            AND p.line_period_start <= now()
                            AND now() < p.line_period_end)`);
    return count(result, 'active subscriptions');
  }

  /** Every rule, asked once, in the order `CREDIT_INVARIANT_CHECKS` lists them. */
  async countAll(on: CreditLedgerExecutor = this.database.db): Promise<CreditInvariantCounts> {
    return {
      lot_balance_vs_ledger: await this.lotBalanceVsLedger(on),
      account_debt_vs_ledger: await this.accountDebtVsLedger(on),
      lot_held_vs_holds: await this.lotHeldVsHolds(on),
      hold_open_past_its_task: await this.holdOpenPastItsTask(on),
      reservation_open_past_max_until: await this.reservationOpenPastMaxUntil(on),
      claim_pending_with_no_open_hold: await this.claimPendingWithNoOpenHold(on),
      shadow_charge_vs_list_price: await this.shadowChargeVsListPrice(on),
      rate_card_rate_vs_list_price: await this.rateCardRateVsListPrice(on),
      active_subscription_without_paid_invoice: await this.activeSubscriptionWithoutPaidInvoice(on),
    };
  }
}
