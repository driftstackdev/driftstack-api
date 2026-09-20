// A plan an admin set by hand is one per account, replaced whole, and ends when
// told to.
//
// `credit_plan_overrides` holds the monthly AI credits an admin gave one account
// outside any payment: a contract's figure, or the credits of a plan that was
// assigned by hand. It is one of the three kinds of coverage monthly credits are
// granted from, so what it says, and from when, is money. The repository is
// driven here against Postgres, and the last arm shows the grants reading what
// it wrote.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleCreditPlanOverridesRepo } from '../../src/db/credit-plan-overrides-repo.js';
import { openLedgerDatabase, repoRefusal } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  grantsHarness,
  newAccountOn,
  windowsOf,
  type GrantsHarness,
} from './_helpers/credit-grant-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_plan_overrides';
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

function repo(): DrizzleCreditPlanOverridesRepo {
  return new DrizzleCreditPlanOverridesRepo(h().database);
}

describe.skipIf(!RUN_DB_TESTS)(
  'a plan an admin set is one per account and ends when told to',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('an account has no override until one is set; setting one writes every field, anchored and effective on the database’s clock when no anchor is given', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      expect(await repo().get(accountId)).toBeNull();

      const before = Date.now();
      const written = await repo().upsert({
        accountId,
        monthlyCredits: 120_000,
        reason: 'contract',
        note: 'signed order form',
      });
      expect(written).toMatchObject({
        accountId,
        monthlyCredits: 120_000,
        ownKeyAllowed: true,
        endsAt: null,
        reason: 'contract',
        setByKeyId: null,
        note: 'signed order form',
      });
      expect(written.anchorAt.getTime()).toBe(written.effectiveSince.getTime());
      expect(Math.abs(written.anchorAt.getTime() - before)).toBeLessThan(60_000);
      expect(await repo().get(accountId)).toEqual(written);
    });

    it('CRITICAL setting it again REPLACES it — one row per account — and the new figure is effective from NOW, not from when the first one was set', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      const anchor = new Date('2026-01-31T00:00:00.000Z');
      const first = await repo().upsert({
        accountId,
        monthlyCredits: 1_000,
        reason: 'contract',
        anchorAt: anchor,
      });
      await db()`
      UPDATE credit_plan_overrides SET effective_since = now() - interval '10 days'
       WHERE account_id = ${accountId}::uuid`;

      const second = await repo().upsert({
        accountId,
        monthlyCredits: 2_000,
        reason: 'admin_tier',
        anchorAt: anchor,
        ownKeyAllowed: false,
      });
      expect(second).toMatchObject({
        monthlyCredits: 2_000,
        reason: 'admin_tier',
        ownKeyAllowed: false,
      });
      expect(second.anchorAt.toISOString()).toBe(anchor.toISOString());
      expect(second.effectiveSince.getTime()).toBeGreaterThanOrEqual(
        first.effectiveSince.getTime(),
      );
      expect(Date.now() - second.effectiveSince.getTime()).toBeLessThan(60_000);
      const [row] = await db()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
      expect(row?.n).toBe(1);
    });

    it('a figure out of range, or a reason that is not one of the two, is refused before it reaches the database — and the database refuses it too', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      for (const monthlyCredits of [-1, 1.5, 10_000_001, Number.NaN]) {
        await expect(
          repo().upsert({ accountId, monthlyCredits, reason: 'contract' }),
          String(monthlyCredits),
        ).rejects.toThrow(RangeError);
      }
      await expect(
        repo().upsert({ accountId, monthlyCredits: 5, reason: 'goodwill' as 'contract' }),
      ).rejects.toThrow(RangeError);

      const ends = await repoRefusal(() =>
        repo().upsert({
          accountId,
          monthlyCredits: 5,
          reason: 'contract',
          anchorAt: new Date('2026-06-01T00:00:00Z'),
          endsAt: new Date('2026-05-01T00:00:00Z'),
        }),
      );
      expect(ends.code).toBe('23514');
      expect(ends.constraint).toBe('credit_plan_overrides_ends_after_anchor');
      expect(await repo().get(accountId), 'a refused write left a row behind').toBeNull();
    });

    it('ending a live override stops it now, once: a second end, an account with none, and one anchored in the future all report that nothing was ended', async () => {
      const live = await newAccountOn(db(), 'enterprise');
      await repo().upsert({
        accountId: live,
        monthlyCredits: 9_000,
        reason: 'contract',
        anchorAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      });
      expect(await repo().end(live)).toBe(true);
      const ended = await repo().get(live);
      expect(ended?.endsAt).not.toBeNull();
      expect(Date.now() - (ended?.endsAt?.getTime() ?? 0)).toBeLessThan(60_000);
      expect(await repo().end(live), 'ended twice').toBe(false);

      expect(await repo().end(await newAccountOn(db())), 'an account with none').toBe(false);

      const future = await newAccountOn(db(), 'enterprise');
      await repo().upsert({
        accountId: future,
        monthlyCredits: 9_000,
        reason: 'contract',
        anchorAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      });
      expect(await repo().end(future), 'it cannot end before it is anchored').toBe(false);
      expect((await repo().get(future))?.endsAt).toBeNull();
    });

    it('CRITICAL the grants read what this repository wrote: an override set here grants its figure, and once ended it grants nothing more', async () => {
      const accountId = await newAccountOn(db(), 'enterprise');
      await repo().upsert({
        accountId,
        monthlyCredits: 25_000,
        reason: 'contract',
        anchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });
      expect((await h().grants.refreshCredits(accountId)).window).toMatchObject({
        outcome: 'created',
        source: 'plan_override',
        grantedMicro: 25_000 * MICRO,
      });

      const ended = await newAccountOn(db(), 'enterprise');
      await repo().upsert({
        accountId: ended,
        monthlyCredits: 25_000,
        reason: 'contract',
        anchorAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });
      expect(await repo().end(ended)).toBe(true);
      expect((await h().grants.refreshCredits(ended)).window).toEqual({ outcome: 'none' });
      expect(await windowsOf(db(), ended)).toEqual([]);
    });
  },
);
