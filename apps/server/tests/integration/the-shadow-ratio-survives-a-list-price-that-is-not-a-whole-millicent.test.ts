// The shadow ratio survives a list price that is not a whole millicent.
//
// §8 step 3 will not move an account to enforce until the shadow numbers show
// "shadow charge = 2x list price". `the-shadow-charge-is-twice-what-the-turn-
// really-cost` proves the JOIN that makes that comparison about one turn. This
// file proves the other half, which a hand-picked fixture hides: the UNITS
// survive a real call.
//
// ⛔ A LIST PRICE IS ALMOST NEVER A WHOLE MILLICENT. `listPriceCostMillicents`
// returns `Math.round(microcents) / 1000`, so a real call prices at 3034.66 or
// 883.07 millicents; only a fixture built out of round token counts lands on an
// integer. A report that rounds the day's millicent total to a whole millicent
// BEFORE scaling it to microcredits therefore moves the denominator by up to
// 500 microcredits on every row — and the criterion it is read against is not
// "about 2", it is 2. The operator sees 1.99977 and cannot tell an arithmetic
// artefact from a real overcharge, which is the one question the number exists
// to answer.
//
// So the arm below uses the card's own numbers rather than tidy ones: the token
// counts are arbitrary, the charge comes out of `settleCall` and the list price
// out of `listPriceCostMillicents`, and the two are compared exactly.
//
// ⛔ ITS OWN ISOLATED DATABASE, and not out of caution. The report groups by DAY
// and MODEL, `created_at` is immutable by trigger, and the sibling file already
// owns one arm per priced model on today's date. Sharing a database would make
// each file assert the other's sums.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPriceCostMillicents, type ModelCallTokens } from '@driftstack/api-types';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import {
  DrizzleAiCreditsReportRepo,
  MICROCREDITS_PER_MILLICENT,
  SHADOW_CHARGE_MARKUP,
} from '../../src/db/ai-credits-report-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  ON_CREDITS_MODEL,
  fundedTaskLot,
  newTaskAccount,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ratio';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-ratio';

/**
 * Arbitrary counts, chosen for being untidy rather than for any property. They
 * price at 3034.66 millicents — two decimal places, which is what a call off the
 * wire looks like and what the whole file is about.
 */
const REPORTED: ModelCallTokens = {
  uncachedInput: 1_137,
  output: 842,
  cacheRead: 12_043,
  cacheWrite5m: 0,
  cacheWrite1h: 4_311,
};

/** Generous: what is being measured is the arithmetic, not the fit ladder. */
const BOUND: CreditCallBound = {
  inputBoundTokens: 32_768,
  inputBoundMicro: 32_768 * 800,
  maxOutputTokens: 8_192,
  boundMicro: 32_768 * 800 + 8_192 * 2_000,
  basis: 'region_bytes',
};

let client: postgres.Sql | null = null;
let url: string | null = null;
let harness: ReservationsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (db === null) return;
  client = db.sql;
  url = db.url;
  harness = reservationsHarness(db.url, { max: 3 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null || url === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): ReservationsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

describe.skipIf(!RUN_DB_TESTS)(
  'the shadow ratio survives a list price that is not a whole millicent',
  () => {
    it('CRITICAL a real call prices at a FRACTION of a millicent, and the report must carry every thousandth of it into microcredits. Rounding the day’s total to a whole millicent first moves the denominator by up to 500 µcr, so the ratio an operator compares with 2.0 reads 1.99977 — an arithmetic artefact wearing the shape of an overcharge, on the one number §8 will not let an account move without.', async () => {
      // The independent half: the provider's list price for these counts is not
      // a whole millicent, which is the ordinary case and not a contrivance.
      const listMillicents = listPriceCostMillicents(ON_CREDITS_MODEL, REPORTED);
      expect(listMillicents).toBe(3_034.66);
      expect(Number.isInteger(listMillicents)).toBe(false);

      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
      const reservationId = randomUUID();
      const reserved = await h().service.reserve({
        accountId,
        reservationId,
        agentSessionId: `as_${reservationId}`,
        idempotencyKey: null,
        model: ON_CREDITS_MODEL,
        mode: 'shadow',
        bootId: BOOT,
      });
      expect(reserved.outcome).toBe('shadowed');

      const callId = randomUUID();
      const admitted = await h().service.admitCall({
        reservationId,
        purpose: 'plan',
        model: ON_CREDITS_MODEL,
        bound: BOUND,
        callId,
      });
      expect(admitted.outcome).toBe('admitted');
      await h().service.markSent(callId);
      const settled = await h().service.settleCall({
        callId,
        basis: 'provider_usage',
        usage: REPORTED,
      });
      await h().service.settle(reservationId, 'completed');

      // The card really is the list price doubled, to the microcredit. If this
      // ever stops holding, the arm below is measuring the card and not the
      // report, and it must be read again before it is believed.
      expect(settled.chargedMicro).toBe(
        (listMillicents ?? 0) * MICROCREDITS_PER_MILLICENT * SHADOW_CHARGE_MARKUP,
      );

      await db()`
        INSERT INTO usage_records (account_id, record_type, quantity, metadata, recorded_at)
        VALUES (${accountId}::uuid, 'agent_decomposer_bundled', 1,
                ${JSON.stringify({
                  credit_reservation_id: reservationId,
                  list_price_cost_millicents: listMillicents,
                  model: ON_CREDITS_MODEL,
                })}::text::jsonb, now())`;

      const until = new Date(Date.now() + 60 * 60 * 1000);
      const report = await new DrizzleAiCreditsReportRepo(h().database).shadowReport({
        since: new Date(until.getTime() - 3 * 24 * 60 * 60 * 1000),
        until,
      });
      const row = report.rows.find((r) => r.model === ON_CREDITS_MODEL);

      expect(row?.tasks).toBe(1);
      expect(row?.shadowCalls).toBe(1);
      // 3034.66 millicents is 3,034,660 microcredits — not 3,035,000.
      expect(row?.listPriceMicro).toBe(3_034_660);
      expect(row?.shadowChargeMicro).toBe(6_069_320);
      // The exit criterion, exactly, on a call the card priced rather than one
      // the fixture rounded.
      expect(row?.ratio).toBe(SHADOW_CHARGE_MARKUP);
    });
  },
);
