// S13–S16 re-audit, round 1, finding 8 — the cutover follows M7's text for an
// Enterprise account.
//
// M7: an Enterprise account stays legacy "until an admin sets a contract or
// `admin_tier` override". The S16 fix (#3) accepted only a `contract`, so an
// Enterprise account an admin had put on a plan by hand (`admin_tier`) was
// refused `no_contract` — a refusal naming an agreement M7 does not require.
//
// Now a live override of EITHER reason lets an Enterprise account move, and
// `no_contract` is the refusal only for an Enterprise account with neither. A
// paid Stripe line on some other plan is still not an agreement (S16 #3,
// unchanged), and an override that grants nothing is the agreement without the
// coverage (`no_paid_coverage`).
//
// Real database, the real `CreditCutoverService` (dry run and real run), read
// back from the tables.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { paidLine, planOverride, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  decideCutover,
  type CutoverAccountDecisionFacts,
  type CutoverDecision,
} from '../../src/services/credit-cutover.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s1316_round2_m7';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: AdminCreditsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = adminCreditsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await harness?.base.database.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): AdminCreditsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

/** A legacy Enterprise account in C0. */
async function enterprise(): Promise<string> {
  const id = randomUUID();
  const email = `m7-${id}@driftstack.test`;
  await sql()`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${email}, 'enterprise')`;
  h().internalEmails.add(email);
  return id;
}

async function payForScale(accountId: string): Promise<void> {
  const subscriptionId = await subscription(sql(), accountId, { tier: 'api_scale' });
  await paidLine(sql(), accountId, { subscriptionId, tier: 'api_scale' });
}

function shape(d: CutoverDecision): { outcome: string; reason?: string } {
  return d.outcome === 'refuse' || d.outcome === 'not_eligible'
    ? { outcome: d.outcome, reason: d.reason }
    : { outcome: d.outcome };
}

/** The dry run and then the real run agree on `expected`. */
async function bothRuns(
  accountId: string,
  expected: { outcome: string; reason?: string },
): Promise<void> {
  const selector = { kind: 'account_ids' as const, accountIds: [accountId] };
  const planned = await h().cutover.planCutover(selector);
  expect(planned.map(shape), 'dry run').toEqual([expected]);
  const ran = await h().cutover.runCutover(selector, { onMoved: () => Promise.resolve() });
  expect(ran.map(shape), 'real run').toEqual([expected]);
}

async function billingMode(accountId: string): Promise<string | null> {
  const [row] = await sql()<Array<{ m: string }>>`
    SELECT billing_mode AS m FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return row?.m ?? null;
}

async function monthlyGrantedCredits(accountId: string): Promise<number[]> {
  const found = await sql()<Array<{ credits: number }>>`
    SELECT (granted_micro / 1000000)::int AS credits FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND kind = 'monthly'
     ORDER BY created_at, id`;
  return found.map((r) => r.credits);
}

describe.skipIf(!RUN_DB_TESTS)(
  'an Enterprise account moves on a live contract OR admin_tier override (M7)',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    it('CRITICAL Enterprise whose only override is an admin_tier plan moves, in the dry run and the real run, and is granted that plan’s figure', async () => {
      const accountId = await enterprise();
      await planOverride(sql(), accountId, { monthlyCredits: 3_000, reason: 'admin_tier' });
      await bothRuns(accountId, { outcome: 'move' });
      expect(await billingMode(accountId)).toBe('credits');
      expect(await monthlyGrantedCredits(accountId)).toEqual([3_000]);
    });

    it('CRITICAL Enterprise paying for Scale with an admin_tier override moves too — the override is the agreement', async () => {
      const accountId = await enterprise();
      await planOverride(sql(), accountId, { monthlyCredits: 50_000, reason: 'admin_tier' });
      await payForScale(accountId);
      await bothRuns(accountId, { outcome: 'move' });
      expect(await billingMode(accountId)).toBe('credits');
    });

    it('a contract still moves it, as before', async () => {
      const accountId = await enterprise();
      await planOverride(sql(), accountId, { monthlyCredits: 4_000, reason: 'contract' });
      await bothRuns(accountId, { outcome: 'move' });
    });

    it('CRITICAL NEGATIVE CONTROL — Enterprise with neither, paying only for Scale, is still refused no_contract and stays legacy', async () => {
      const accountId = await enterprise();
      await payForScale(accountId);
      await bothRuns(accountId, { outcome: 'refuse', reason: 'no_contract' });
      expect(await billingMode(accountId)).not.toBe('credits');
      expect(await monthlyGrantedCredits(accountId)).toEqual([]);
    });

    it('an admin_tier override that has ended is no override: no_contract', async () => {
      const accountId = await enterprise();
      await planOverride(sql(), accountId, {
        monthlyCredits: 3_000,
        reason: 'admin_tier',
        ends: "now() - interval '1 day'",
      });
      await bothRuns(accountId, { outcome: 'refuse', reason: 'no_contract' });
    });

    it('a 0-credit admin_tier override is the agreement without the coverage: no_paid_coverage, not no_contract', async () => {
      const accountId = await enterprise();
      await planOverride(sql(), accountId, { monthlyCredits: 0, reason: 'admin_tier' });
      await bothRuns(accountId, { outcome: 'refuse', reason: 'no_paid_coverage' });
    });
  },
);

describe('decideCutover — the Enterprise rule on its own (no database)', () => {
  function facts(over: Partial<CutoverAccountDecisionFacts>): CutoverAccountDecisionFacts {
    return {
      billingMode: 'legacy',
      status: 'active',
      tier: 'enterprise',
      consent: false,
      hasStoredKey: false,
      hasPaidCoverage: true,
      hasLivePlanOverride: false,
      inPhaseOneCohort: true,
      ...over,
    };
  }

  it('CRITICAL a live plan override of either reason moves an Enterprise account with paid coverage', () => {
    expect(decideCutover('a1', facts({ hasLivePlanOverride: true }))).toEqual({
      accountId: 'a1',
      outcome: 'move',
      aiSource: 'credits',
    });
  });

  it('with none, the refusal is no_contract', () => {
    expect(decideCutover('a1', facts({ hasLivePlanOverride: false }))).toEqual({
      accountId: 'a1',
      outcome: 'refuse',
      reason: 'no_contract',
    });
  });
});
