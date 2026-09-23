// S13–S16 re-audit, round 1, finding 2 — `plan.monthly_included_credits` on
// `GET /v1/account/me/ai` is the figure the monthly grant actually uses.
//
// It showed any live plan override's figure. The grant does not work that way:
// it takes the HIGHEST-level paid source (`pickWindowCandidate`), and a
// 0-credit override grants nothing at all (the coverage query's
// `monthly_credits > 0`). So an Enterprise account with a 20,000 contract that
// also pays for a Scale subscription read "plan 20,000" beside a 30,000 grant,
// and a Team account paying 5,000 with a 0-credit admin override read
// "plan 0" beside a 5,000 grant.
//
// The rule now:
//   · the account has a window over now() → that window's level, in credits —
//     the figure the grant used, whichever source it came from;
//   · no window → the grant's own choice between the plan's two sources: the
//     higher of the tier's own figure and a live override's, a 0-credit
//     override counting as none; null only for an Enterprise account with
//     neither.
//
// Every arm reads the real route over a freshly migrated database, with the
// real grants service writing the windows (`adminCreditsHarness`).

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountAiStateSchema, type AccountTier } from '@driftstack/api-types';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { paidLine, planOverride, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s1316_round2_planfig';
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

/** The harness's runtime plus the two reads bootstrap.ts wires beside it. */
function runtime(): AiCreditsRuntime {
  const base = h().aiCredits;
  if (base.stateReads === undefined) throw new Error('the harness wires stateReads');
  return {
    ...base,
    mode: 'enforce',
    stateReads: {
      ...base.stateReads,
      planOverride: h().overrides.get.bind(h().overrides),
      refreshCredits: h().grants.refreshCredits.bind(h().grants),
    },
  };
}

async function account(tier: AccountTier, billing: 'credits' | 'legacy'): Promise<string> {
  const id = randomUUID();
  await sql()`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${`planfig-${id}@example.test`}, ${tier}::account_tier)`;
  await sql()`INSERT INTO credit_accounts (account_id, billing_mode) VALUES (${id}::uuid, ${billing})`;
  return id;
}

async function payFor(accountId: string, tier: AccountTier): Promise<void> {
  const subscriptionId = await subscription(sql(), accountId, { tier });
  await paidLine(sql(), accountId, { subscriptionId, tier });
}

/** The level, in whole credits, of the window over now() — what the grant used. */
async function windowLevelCredits(accountId: string): Promise<number | null> {
  const [row] = await sql()<Array<{ credits: number }>>`
    SELECT (level_micro / 1000000)::int AS credits FROM credit_windows
     WHERE account_id = ${accountId}::uuid AND window_start <= now() AND now() < window_end
     ORDER BY window_start`;
  return row?.credits ?? null;
}

interface StateBody {
  billing: string;
  plan: { monthly_included_credits: number | null };
  balance: { monthly: { granted_credits: number } | null };
}

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

async function stateOf(accountId: string, tier: AccountTier): Promise<StateBody> {
  fx = await buildTestApp({ accountId, tier, aiCredits: runtime() });
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/account/me/ai',
    headers: { authorization: `Bearer ${fx.plaintext}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(AccountAiStateSchema.safeParse(res.json()).success).toBe(true);
  return res.json<StateBody>();
}

describe.skipIf(!RUN_DB_TESTS)(
  'plan.monthly_included_credits is the figure the monthly grant uses',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(harness).not.toBeNull();
    });

    describe('with a window over now(), the plan is that window’s level', () => {
      it('CRITICAL Enterprise with a 20,000 contract paying for Scale reads the 30,000 it is granted, not the contract’s 20,000', async () => {
        const id = await account('enterprise', 'credits');
        await planOverride(sql(), id, { monthlyCredits: 20_000, reason: 'contract' });
        await payFor(id, 'api_scale');
        const body = await stateOf(id, 'enterprise');
        expect(body.billing).toBe('credits');
        expect(await windowLevelCredits(id), 'test setup: the grant took the Scale line').toBe(
          30_000,
        );
        expect(body.plan.monthly_included_credits).toBe(30_000);
        expect(body.balance.monthly?.granted_credits).toBe(30_000);
      });

      it('CRITICAL Team paying 5,000 with a 0-credit admin override reads the 5,000 it is granted, not 0', async () => {
        const id = await account('team_manual', 'credits');
        await planOverride(sql(), id, { monthlyCredits: 0, reason: 'admin_tier' });
        await payFor(id, 'team_manual');
        const body = await stateOf(id, 'team_manual');
        expect(body.plan.monthly_included_credits).toBe(5_000);
        expect(body.balance.monthly?.granted_credits).toBe(5_000);
      });

      it('a contract above the subscription is what the grant takes, and what the plan reads', async () => {
        const id = await account('enterprise', 'credits');
        await planOverride(sql(), id, { monthlyCredits: 40_000, reason: 'contract' });
        await payFor(id, 'api_scale');
        const body = await stateOf(id, 'enterprise');
        expect(await windowLevelCredits(id)).toBe(40_000);
        expect(body.plan.monthly_included_credits).toBe(40_000);
      });

      it('CRITICAL a LEGACY account with a window reads that window’s level too — the plan is a property of the account, not of how its AI is billed', async () => {
        const id = await account('enterprise', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 20_000, reason: 'contract' });
        await payFor(id, 'api_scale');
        await h().grants.refreshCredits(id);
        expect(await windowLevelCredits(id), 'test setup: a window over now()').toBe(30_000);
        const body = await stateOf(id, 'enterprise');
        expect(body.billing).toBe('legacy');
        expect(body.plan.monthly_included_credits).toBe(30_000);
      });
    });

    describe('with no window, the plan is the grant’s own choice between the tier and a live override', () => {
      it('CRITICAL a 0-credit admin override counts as no override: Team reads its own 5,000, not 0', async () => {
        const id = await account('team_manual', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 0, reason: 'admin_tier' });
        expect(await windowLevelCredits(id)).toBeNull();
        expect((await stateOf(id, 'team_manual')).plan.monthly_included_credits).toBe(5_000);
      });

      it('CRITICAL Enterprise whose only override is a 0-credit contract reads null — the plan has no figure of its own', async () => {
        const id = await account('enterprise', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 0, reason: 'contract' });
        expect((await stateOf(id, 'enterprise')).plan.monthly_included_credits).toBeNull();
      });

      it('CRITICAL the higher level wins, as the grant picks: a 3,000 override on Team reads the tier’s 5,000', async () => {
        const id = await account('team_manual', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 3_000, reason: 'admin_tier' });
        expect((await stateOf(id, 'team_manual')).plan.monthly_included_credits).toBe(5_000);
      });

      it('an override above the tier reads the override: 7,500 on Team', async () => {
        const id = await account('team_manual', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 7_500, reason: 'admin_tier' });
        expect((await stateOf(id, 'team_manual')).plan.monthly_included_credits).toBe(7_500);
      });

      it('Enterprise with a live contract and no window reads the contract', async () => {
        const id = await account('enterprise', 'legacy');
        await planOverride(sql(), id, { monthlyCredits: 12_000, reason: 'contract' });
        expect((await stateOf(id, 'enterprise')).plan.monthly_included_credits).toBe(12_000);
      });

      it('no override at all reads the tier’s own figure; Enterprise with none reads null', async () => {
        const team = await account('team_manual', 'legacy');
        expect((await stateOf(team, 'team_manual')).plan.monthly_included_credits).toBe(5_000);
        await fx?.cleanup();
        fx = null;
        const enterprise = await account('enterprise', 'legacy');
        expect((await stateOf(enterprise, 'enterprise')).plan.monthly_included_credits).toBeNull();
      });
    });
  },
);
