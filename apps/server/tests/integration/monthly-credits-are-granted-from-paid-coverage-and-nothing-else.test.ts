// Monthly AI credits are granted from PAID coverage, and from nothing else.
//
// A subscription that says "active" has not necessarily been paid for. A
// renewal's payment is attempted after its period has already rolled over, and
// an upgrade may be billed later. If credits followed the subscription's status,
// a customer whose card then failed would hold a month of credits nobody paid
// for; one who upgraded and cancelled before the invoice would hold the larger
// plan's. So what grants is a PAYMENT: a paid invoice's subscription line (on a
// subscription that is also active right now), a paid crypto order's
// entitlement, or a plan an admin set by hand.
//
// Every arm drives the real service against Postgres, with the coverage rows
// written as the billing events write them, and reads back what the grant left
// behind: the window, its monthly lot, the grant row that funds it, and what a
// task could now spend.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  PLAN_CREDITS,
  cryptoEntitlement,
  grantCounts,
  grantsHarness,
  ledgerOf,
  lotsOf,
  newAccountOn,
  paidLine,
  payingCustomer,
  planOverride,
  subscription,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_grants_paid';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: GrantsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = grantsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): GrantsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

const NOTHING = { windows: 0, lots: 0, ledger: 0 };

describe.skipIf(!RUN_DB_TESTS)(
  'monthly credits are granted from paid coverage and nothing else',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    for (const [tier, credits] of Object.entries(PLAN_CREDITS)) {
      it(`CRITICAL a paid month on ${tier} grants ${String(credits)} credits: one window over the paid period, one monthly lot with the window’s own term, one grant row, and all of it spendable`, async () => {
        const { accountId, invoiceId } = await payingCustomer(db(), tier as AccountTier);
        const result = await h().grants.refreshCredits(accountId);

        expect(result.window).toMatchObject({
          outcome: 'created',
          source: 'stripe_invoice',
          sourceRef: invoiceId,
          grantedMicro: credits * MICRO,
        });
        const [w, ...moreWindows] = await windowsOf(db(), accountId);
        expect(moreWindows).toEqual([]);
        expect(w).toMatchObject({
          source: 'stripe_invoice',
          source_ref: invoiceId,
          tier,
          level_micro: String(credits * MICRO),
          level_seq: 0,
          current: true,
        });
        // A monthly line is its own natural month, and nothing came before it.
        expect(w?.window_start.getTime()).toBe(w?.natural_start.getTime());
        expect(w?.window_end.getTime()).toBe(w?.natural_end.getTime());

        const [lot, ...moreLots] = await lotsOf(db(), accountId);
        expect(moreLots).toEqual([]);
        expect(lot).toMatchObject({
          kind: 'monthly',
          window_id: w?.id,
          grant_key: `window:${w?.id ?? ''}`,
          granted_micro: String(credits * MICRO),
          remaining_micro: String(credits * MICRO),
        });
        expect(lot?.starts_at.getTime()).toBe(w?.window_start.getTime());
        expect(lot?.expires_at.getTime()).toBe(w?.window_end.getTime());

        expect(await ledgerOf(db(), accountId)).toEqual([
          {
            kind: 'grant',
            lot_id: lot?.id,
            lot_delta_micro: String(credits * MICRO),
            debt_delta_micro: '0',
            idempotency_key: `grant:${lot?.id ?? ''}`,
          },
        ]);
        expect(await h().ledger.spendableMicro(accountId)).toBe(credits * MICRO);
      });
    }

    it('CRITICAL an ACTIVE renewal whose invoice is not paid yet grants nothing. The subscription rolled into a new period and says active; the only paid invoice is last month’s. Credits wait for the payment', async () => {
      const accountId = await newAccountOn(db(), 'api_scale');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_scale' });
      // The mirror already describes the NEW period, as it does the moment Stripe rolls it over.
      await db()`
      UPDATE subscriptions
         SET current_period_start = now() - interval '10 minutes',
             current_period_end = now() + interval '30 days'
       WHERE stripe_subscription_id = ${subscriptionId}`;
      await paidLine(db(), accountId, {
        subscriptionId,
        tier: 'api_scale',
        start: "date_trunc('second', now()) - interval '31 days'",
        end: "date_trunc('second', now()) - interval '10 minutes'",
      });

      const result = await h().grants.refreshCredits(accountId);
      expect(result.window).toEqual({ outcome: 'none' });
      expect(await grantCounts(db(), accountId)).toEqual(NOTHING);

      // The renewal's invoice is paid: now, and only now, the month is granted.
      await paidLine(db(), accountId, {
        subscriptionId,
        tier: 'api_scale',
        start: "date_trunc('second', now()) - interval '10 minutes'",
        end: "date_trunc('second', now()) + interval '30 days'",
      });
      expect((await h().grants.refreshCredits(accountId)).window.outcome).toBe('created');
      expect(await h().ledger.spendableMicro(accountId)).toBe(30_000 * MICRO);
    });

    for (const status of [
      'trialing',
      'past_due',
      'unpaid',
      'paused',
      'canceled',
      'incomplete',
      'incomplete_expired',
    ] as const) {
      it(`a paid line on a subscription that is ${status} right now grants nothing: only an active one does`, async () => {
        const accountId = await newAccountOn(db(), 'api_builder');
        const subscriptionId = await subscription(db(), accountId, { tier: 'api_builder', status });
        await paidLine(db(), accountId, { subscriptionId, tier: 'api_builder' });
        expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
        expect(await grantCounts(db(), accountId)).toEqual(NOTHING);
      });
    }

    it('an account with no coverage at all is granted nothing, whatever its tier says: a tier may spend, it does not grant', async () => {
      const accountId = await newAccountOn(db(), 'api_scale');
      expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
      expect(await grantCounts(db(), accountId)).toEqual(NOTHING);
    });

    it('a paid line whose subscription this server has no mirror of grants nothing', async () => {
      const accountId = await newAccountOn(db(), 'api_builder');
      await paidLine(db(), accountId, { subscriptionId: 'sub_unknown_to_us', tier: 'api_builder' });
      expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
    });

    it('a fully refunded invoice covers nothing; a partly refunded one still covers; and a $0 invoice was paid and covers like any other', async () => {
      const refunded = await payingCustomer(db(), 'api_starter', {
        amountPaid: 2900,
        refunded: 2900,
      });
      expect((await h().grants.refreshCredits(refunded.accountId)).window).toEqual({
        outcome: 'none',
      });

      const partly = await payingCustomer(db(), 'api_starter', {
        amountPaid: 2900,
        refunded: 2899,
      });
      expect((await h().grants.refreshCredits(partly.accountId)).window.outcome).toBe('created');

      const free = await payingCustomer(db(), 'api_starter', { amountPaid: 0 });
      expect((await h().grants.refreshCredits(free.accountId)).window.outcome).toBe('created');
      expect(await h().ledger.spendableMicro(free.accountId)).toBe(3_000 * MICRO);
    });

    it('only the subscription’s own period line is coverage: the paid proration line of a plan change grants no month by itself', async () => {
      const accountId = await newAccountOn(db(), 'api_scale');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_scale' });
      await paidLine(db(), accountId, {
        subscriptionId,
        tier: 'api_scale',
        lineKind: 'proration_up',
      });
      expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
    });

    it('a paid line for a price the configuration does not name, or whose interval is unknown, covers nothing', async () => {
      const unmapped = await newAccountOn(db(), 'api_builder');
      const sub1 = await subscription(db(), unmapped, { tier: 'api_builder' });
      await paidLine(db(), unmapped, { subscriptionId: sub1, tier: null, interval: null });
      expect((await h().grants.refreshCredits(unmapped)).window).toEqual({ outcome: 'none' });

      const noInterval = await newAccountOn(db(), 'api_builder');
      const sub2 = await subscription(db(), noInterval, { tier: 'api_builder' });
      await paidLine(db(), noInterval, {
        subscriptionId: sub2,
        tier: 'api_builder',
        interval: null,
      });
      expect((await h().grants.refreshCredits(noInterval)).window).toEqual({ outcome: 'none' });
    });

    it('an Enterprise line has no plan-wide number, so it grants nothing until an admin sets the contract’s credits — and then the override grants exactly that', async () => {
      const { accountId } = await payingCustomer(db(), 'enterprise');
      expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });

      await planOverride(db(), accountId, { monthlyCredits: 250_000 });
      const result = await h().grants.refreshCredits(accountId);
      expect(result.window).toMatchObject({
        outcome: 'created',
        source: 'plan_override',
        sourceRef: 'override',
        grantedMicro: 250_000 * MICRO,
      });
      expect((await windowsOf(db(), accountId))[0]?.tier).toBe('enterprise');
    });

    it('CRITICAL an upgrade that has not been paid for does not raise the grant: the level is the LOWER of the paid line’s plan and the subscription’s current plan', async () => {
      // Paid for Starter; the mirror already says Scale (the plan was changed, the
      // update invoice is not paid).
      const accountId = await newAccountOn(db(), 'api_scale');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_scale' });
      await paidLine(db(), accountId, { subscriptionId, tier: 'api_starter' });

      const result = await h().grants.refreshCredits(accountId);
      expect(result.window).toMatchObject({ outcome: 'created', grantedMicro: 3_000 * MICRO });
      expect((await windowsOf(db(), accountId))[0]).toMatchObject({
        tier: 'api_starter',
        level_micro: String(3_000 * MICRO),
      });
    });

    it('CRITICAL a downgrade lowers the grant at once: paid for Scale, the subscription now says Starter, and the month is granted at Starter’s level', async () => {
      const accountId = await newAccountOn(db(), 'api_starter');
      const subscriptionId = await subscription(db(), accountId, { tier: 'api_starter' });
      await paidLine(db(), accountId, { subscriptionId, tier: 'api_scale' });

      const result = await h().grants.refreshCredits(accountId);
      expect(result.window).toMatchObject({ outcome: 'created', grantedMicro: 3_000 * MICRO });
      expect((await windowsOf(db(), accountId))[0]?.tier).toBe('api_starter');
    });

    it('a crypto payment grants for its own 31-day term: the window IS the term, at the plan’s whole monthly level', async () => {
      const accountId = await newAccountOn(db(), 'team_manual');
      const orderId = await cryptoEntitlement(db(), accountId, { tier: 'team_manual' });

      const result = await h().grants.refreshCredits(accountId);
      expect(result.window).toMatchObject({
        outcome: 'created',
        source: 'crypto_entitlement',
        sourceRef: orderId,
        grantedMicro: 5_000 * MICRO,
      });
      const [w] = await windowsOf(db(), accountId);
      const [term] = await db()<Array<{ starts_at: Date; expires_at: Date }>>`
      SELECT starts_at, expires_at FROM crypto_entitlements WHERE order_id = ${orderId}`;
      expect(w?.window_start.getTime()).toBe(term?.starts_at.getTime());
      expect(w?.window_end.getTime()).toBe(term?.expires_at.getTime());
      expect((w?.window_end.getTime() ?? 0) - (w?.window_start.getTime() ?? 0)).toBe(
        31 * 24 * 60 * 60 * 1000,
      );
    });

    it('a plan an admin set grants month by month from its anchor; one that has ended, has not begun, or grants nothing, covers nothing', async () => {
      const live = await newAccountOn(db(), 'agency_manual');
      await planOverride(db(), live, { monthlyCredits: 7_000, reason: 'admin_tier' });
      expect((await h().grants.refreshCredits(live)).window).toMatchObject({
        outcome: 'created',
        source: 'plan_override',
        grantedMicro: 7_000 * MICRO,
      });
      const [w] = await windowsOf(db(), live);
      // Anchored 40 days ago: now() is in its SECOND month.
      expect(w?.current).toBe(true);
      expect(w?.natural_start.getTime()).toBeLessThan(Date.now() - 5 * 24 * 60 * 60 * 1000);

      const ended = await newAccountOn(db(), 'agency_manual');
      await planOverride(db(), ended, {
        monthlyCredits: 7_000,
        ends: "now() - interval '1 hour'",
      });
      expect((await h().grants.refreshCredits(ended)).window).toEqual({ outcome: 'none' });

      const notYet = await newAccountOn(db(), 'agency_manual');
      await planOverride(db(), notYet, {
        monthlyCredits: 7_000,
        anchor: "now() + interval '2 days'",
      });
      expect((await h().grants.refreshCredits(notYet)).window).toEqual({ outcome: 'none' });

      const zero = await newAccountOn(db(), 'agency_manual');
      await planOverride(db(), zero, { monthlyCredits: 0 });
      expect((await h().grants.refreshCredits(zero)).window).toEqual({ outcome: 'none' });
      expect(await grantCounts(db(), zero)).toEqual(NOTHING);
    });

    it('CRITICAL two subscriptions on one account grant ONE month, at the higher allowance: windows belong to the account, not to the payment', async () => {
      const accountId = await newAccountOn(db(), 'api_builder');
      const low = await subscription(db(), accountId, { tier: 'api_starter' });
      const high = await subscription(db(), accountId, { tier: 'api_builder' });
      await paidLine(db(), accountId, { subscriptionId: low, tier: 'api_starter' });
      const highInvoice = await paidLine(db(), accountId, {
        subscriptionId: high,
        tier: 'api_builder',
      });

      expect((await h().grants.refreshCredits(accountId)).window).toMatchObject({
        outcome: 'created',
        sourceRef: highInvoice,
        grantedMicro: 10_000 * MICRO,
      });
      // The second payment covers the same time: nothing more, however often asked.
      expect((await h().grants.refreshCredits(accountId)).window).toEqual({ outcome: 'none' });
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
      expect(await h().ledger.spendableMicro(accountId)).toBe(10_000 * MICRO);
    });

    it('CRITICAL a billing event delivered twice grants once: the second refresh finds the month covered and writes nothing', async () => {
      const { accountId } = await payingCustomer(db(), 'solo_manual');
      const first = await h().grants.refreshCredits(accountId);
      const second = await h().grants.refreshCredits(accountId);
      const third = await h().grants.refreshCredits(accountId);

      expect(first.window.outcome).toBe('created');
      expect(second.window).toEqual({ outcome: 'none' });
      expect(third.window).toEqual({ outcome: 'none' });
      expect(second.currentWindowEnd).toBe(first.currentWindowEnd);
      expect(await grantCounts(db(), accountId)).toEqual({ windows: 1, lots: 1, ledger: 1 });
      expect(await h().ledger.spendableMicro(accountId)).toBe(1_500 * MICRO);
    });

    it('a refresh creates the account’s credit row if it had none, owing nothing and on legacy billing: granting credits moves nobody onto them', async () => {
      const { accountId } = await payingCustomer(db(), 'api_starter');
      await h().grants.refreshCredits(accountId);
      const [row] = await db()<
        Array<{ billing_mode: string; debt: string; ai_source: string | null }>
      >`
      SELECT billing_mode, debt_micro::text AS debt, ai_source
        FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
      expect(row).toEqual({ billing_mode: 'legacy', debt: '0', ai_source: null });
    });
  },
);
