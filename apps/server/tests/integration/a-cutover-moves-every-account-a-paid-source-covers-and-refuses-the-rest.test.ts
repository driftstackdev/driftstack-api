// S16 audit fixes #1, #3 and #6 — who the cutover moves.
//
// #1 (HIGH). "Has paid coverage" used to be read from the window-GRANTING query,
// which by design returns nothing once the account already has a window over
// now(). So every account whose month had already been granted — every paying
// account once shadow mode's grants had run, every Enterprise account right
// after its contract override was set (the PUT grants at once), every account
// rolled back and cut over again in the same month — was refused as
// `no_paid_coverage`. The decision now asks only whether a paid source covers
// now(), in both the dry run and the locked run.
//
// #3. A plan whose allowance is a contract (Enterprise) moves only with a live
// plan override — a `contract`, or (since the S13–S16 re-audit, #8, following
// M7's text) an `admin_tier` plan; a paid Stripe line alone is refused
// `no_contract`.
//
// #6. Phase 1 moves C0 only — by cohort OR by id. An id outside C0 is refused
// per account, `not_in_phase_1_cohort`, and the dry run says so too.
//
// Every arm goes through `POST /v1/admin/ai-credits/cutover` on the full app
// over a freshly migrated database, dry run AND real run, and reads the result
// back from the tables.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  cryptoEntitlement,
  paidLine,
  planOverride,
  subscription,
} from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_cover';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;

let client: postgres.Sql | null = null;
let harness: AdminCreditsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = adminCreditsHarness(opened.url);
  await seedStaffIdentity(opened.sql);
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

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

async function app(): Promise<TestAppFixture> {
  fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
  return fx;
}

/** A legacy account in C0 unless `internal: false`, mirrored into the app's auth store. */
async function seedAccount(
  f: TestAppFixture,
  tier: AccountTier,
  opts: { readonly internal?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const email = `s16fix-${id}@driftstack.test`;
  await sql()`
    INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${email}, ${tier}::account_tier)`;
  if (opts.internal !== false) h().internalEmails.add(email);
  f.authRepo.upsertAccount({
    id,
    email,
    name: null,
    tier,
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  return id;
}

async function payFor(accountId: string, tier: AccountTier): Promise<void> {
  const subscriptionId = await subscription(sql(), accountId, { tier });
  await paidLine(sql(), accountId, { subscriptionId, tier });
}

interface Decision {
  readonly outcome: string;
  readonly account_id: string;
  readonly reason?: string;
}

async function cutover(
  f: TestAppFixture,
  accountIds: readonly string[],
  dryRun: boolean,
): Promise<Decision[]> {
  const res = await f.app.inject({
    method: 'POST',
    url: '/v1/admin/ai-credits/cutover',
    headers: { authorization: `Bearer ${f.plaintext}` },
    payload: { account_ids: accountIds.map((id) => `acc_${id}`), to: 'credits', dry_run: dryRun },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ decisions: Decision[] }>().decisions;
}

async function billingMode(accountId: string): Promise<string> {
  const [row] = await sql()<Array<{ m: string }>>`
    SELECT billing_mode AS m FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return row?.m ?? 'legacy';
}

async function lotCount(accountId: string): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;
  return row?.n ?? 0;
}

/** Both runs agree on one decision, and the real run did (or did not) move the account. */
async function expectBothRuns(
  f: TestAppFixture,
  accountId: string,
  expected: { readonly outcome: string; readonly reason?: string },
): Promise<void> {
  const dry = await cutover(f, [accountId], true);
  expect(dry, 'the dry run').toEqual([
    expect.objectContaining({ account_id: `acc_${accountId}`, ...expected }),
  ]);
  const real = await cutover(f, [accountId], false);
  expect(real, 'the real run').toEqual([
    expect.objectContaining({ account_id: `acc_${accountId}`, ...expected }),
  ]);
  expect(await billingMode(accountId)).toBe(expected.outcome === 'move' ? 'credits' : 'legacy');
}

describe.skipIf(!RUN_DB_TESTS)(
  'the cutover moves every covered account and refuses the rest',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    describe('#1 — an account whose current month was already granted still has paid coverage', () => {
      it('CRITICAL after a refresh has granted the window (every paying account in shadow or enforce mode), the account moves', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'team_manual');
        await payFor(accountId, 'team_manual');
        await h().grants.refreshCredits(accountId);
        const [w] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_windows WHERE account_id = ${accountId}::uuid`;
        expect(w?.n, 'precondition: the refresh granted the window over now()').toBe(1);

        await expectBothRuns(f, accountId, { outcome: 'move' });
        expect(await lotCount(accountId), 'the window was not granted a second time').toBe(1);
      });

      it("CRITICAL §11 decision 4's own steps for Enterprise: set a contract override (which grants the window at once), then cut over — the account moves", async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'enterprise');
        const put = await f.app.inject({
          method: 'PUT',
          url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
          headers: { authorization: `Bearer ${f.plaintext}` },
          payload: { monthly_credits: 5000, reason: 'contract' },
        });
        expect(put.statusCode, put.body).toBe(200);
        expect(await lotCount(accountId), 'precondition: the PUT granted the window').toBe(1);

        await expectBothRuns(f, accountId, { outcome: 'move' });
      });

      it('CRITICAL an account rolled back and cut over again in the same month moves again', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'api_starter');
        await payFor(accountId, 'api_starter');
        expect(await cutover(f, [accountId], false)).toEqual([
          expect.objectContaining({ outcome: 'move' }),
        ]);
        const back = await f.app.inject({
          method: 'POST',
          url: '/v1/admin/ai-credits/rollback',
          headers: { authorization: `Bearer ${f.plaintext}` },
          payload: { account_id: `acc_${accountId}` },
        });
        expect(back.json<{ outcome: string }>().outcome).toBe('rolled_back');

        await expectBothRuns(f, accountId, { outcome: 'move' });
      });

      it('a crypto term and an override each count as paid coverage, with or without a window already granted', async () => {
        const f = await app();
        const crypto = await seedAccount(f, 'team_manual');
        await cryptoEntitlement(sql(), crypto, { tier: 'team_manual' });
        await h().grants.refreshCredits(crypto);
        const override = await seedAccount(f, 'team_manual');
        await planOverride(sql(), override, { monthlyCredits: 700, reason: 'admin_tier' });
        await expectBothRuns(f, crypto, { outcome: 'move' });
        await expectBothRuns(f, override, { outcome: 'move' });
      });

      it('CRITICAL NEGATIVE CONTROL — a paid tier with no paid source at all is still refused no_paid_coverage, and nothing is granted', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'api_scale');
        await expectBothRuns(f, accountId, { outcome: 'refuse', reason: 'no_paid_coverage' });
        expect(await lotCount(accountId)).toBe(0);
      });

      it('a source that covered the month and has since stopped is not coverage: a window left behind by an ended override does not move the account', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'team_manual');
        await planOverride(sql(), accountId, { monthlyCredits: 900, reason: 'admin_tier' });
        await h().grants.refreshCredits(accountId);
        await sql()`UPDATE credit_plan_overrides SET ends_at = now() WHERE account_id = ${accountId}::uuid`;
        await expectBothRuns(f, accountId, { outcome: 'refuse', reason: 'no_paid_coverage' });
      });

      it('unpaid, trialing and fully refunded lines are still not coverage', async () => {
        const f = await app();
        const trialing = await seedAccount(f, 'team_manual');
        const sub = await subscription(sql(), trialing, {
          tier: 'team_manual',
          status: 'trialing',
        });
        await paidLine(sql(), trialing, { subscriptionId: sub, tier: 'team_manual' });
        const refunded = await seedAccount(f, 'team_manual');
        const sub2 = await subscription(sql(), refunded, { tier: 'team_manual' });
        await paidLine(sql(), refunded, {
          subscriptionId: sub2,
          tier: 'team_manual',
          amountPaid: 4900,
          refunded: 4900,
        });
        await expectBothRuns(f, trialing, { outcome: 'refuse', reason: 'no_paid_coverage' });
        await expectBothRuns(f, refunded, { outcome: 'refuse', reason: 'no_paid_coverage' });
      });
    });

    describe('#3 — a contract plan moves only with a live plan override (a contract or an admin_tier plan)', () => {
      it('CRITICAL Enterprise paying for a Scale subscription, with no contract, is refused no_contract — no lot, no override, still legacy', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'enterprise');
        await payFor(accountId, 'api_scale');
        await expectBothRuns(f, accountId, { outcome: 'refuse', reason: 'no_contract' });
        expect(await lotCount(accountId), 'no credits were granted').toBe(0);
        const [o] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
        expect(o?.n, 'the cutover never creates an override (M7)').toBe(0);
      });

      it('Enterprise with only an admin_tier override (not a contract) moves — M7 names both (re-audit #8)', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'enterprise');
        await planOverride(sql(), accountId, { monthlyCredits: 3000, reason: 'admin_tier' });
        await expectBothRuns(f, accountId, { outcome: 'move' });
      });

      it('Enterprise whose contract has ended is refused no_contract', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'enterprise');
        await planOverride(sql(), accountId, {
          monthlyCredits: 3000,
          reason: 'contract',
          ends: "now() - interval '1 day'",
        });
        await expectBothRuns(f, accountId, { outcome: 'refuse', reason: 'no_contract' });
      });

      it('a non-contract plan does not need one: Team with a paid line and no override moves', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'team_manual');
        await payFor(accountId, 'team_manual');
        await expectBothRuns(f, accountId, { outcome: 'move' });
      });
    });

    describe('#6 — Phase 1 moves C0 only, by id as well as by cohort', () => {
      it('CRITICAL an id outside C0 is refused not_in_phase_1_cohort in the dry run and the real run, and stays legacy, while a C0 id in the same request moves', async () => {
        const f = await app();
        const outside = await seedAccount(f, 'team_manual', { internal: false });
        const inside = await seedAccount(f, 'team_manual');
        await payFor(outside, 'team_manual');
        await payFor(inside, 'team_manual');

        for (const dryRun of [true, false]) {
          const decisions = await cutover(f, [outside, inside], dryRun);
          expect(decisions, dryRun ? 'the dry run' : 'the real run').toEqual([
            { outcome: 'refuse', account_id: `acc_${outside}`, reason: 'not_in_phase_1_cohort' },
            expect.objectContaining({ outcome: 'move', account_id: `acc_${inside}` }),
          ]);
        }
        expect(await billingMode(outside)).toBe('legacy');
        expect(await lotCount(outside), 'nothing granted to the account outside C0').toBe(0);
        expect(await billingMode(inside)).toBe('credits');
      });

      it('C0 membership is the census predicate: case-insensitive on the e-mail', async () => {
        const f = await app();
        const accountId = await seedAccount(f, 'team_manual', { internal: false });
        await payFor(accountId, 'team_manual');
        h().internalEmails.add(`S16FIX-${accountId}@DRIFTSTACK.TEST`);
        await expectBothRuns(f, accountId, { outcome: 'move' });
      });
    });

    describe('the coverage read agrees with the window-granting query it was split from', () => {
      const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/db');

      it('CRITICAL the cutover applies the grants\' own "still paid for" rule, not a copy — a refund rule changed in one and not the other would move accounts the grants never cover', () => {
        const cutover = readFileSync(resolve(SRC, 'credit-cutover-repo.ts'), 'utf8');
        const windows = readFileSync(resolve(SRC, 'credit-windows-repo.ts'), 'utf8');
        expect(windows).toMatch(/^export const STILL_PAID_FOR = sql`/m);
        expect(cutover).toMatch(
          /import \{[^}]*\bSTILL_PAID_FOR\b[^}]*\} from '\.\/credit-windows-repo\.js'/,
        );
        expect(cutover).toContain('AND ${STILL_PAID_FOR}');
        // No second definition to drift from the first.
        expect(cutover).not.toMatch(/const STILL_PAID_FOR\b/);
      });

      it('CRITICAL on accounts with NO window yet, "a paid source covers now()" is exactly "a window is owed now()", source by source', async () => {
        const f = await app();
        const cases: Array<[string, (id: string) => Promise<void>]> = [
          ['nothing', () => Promise.resolve()],
          ['a paid Team line', (id) => payFor(id, 'team_manual')],
          [
            'a trialing subscription',
            async (id) => {
              const sub = await subscription(sql(), id, {
                tier: 'team_manual',
                status: 'trialing',
              });
              await paidLine(sql(), id, { subscriptionId: sub, tier: 'team_manual' });
            },
          ],
          [
            'a wholly refunded line',
            async (id) => {
              const sub = await subscription(sql(), id, { tier: 'team_manual' });
              await paidLine(sql(), id, {
                subscriptionId: sub,
                tier: 'team_manual',
                refunded: 4900,
              });
            },
          ],
          [
            'a half-refunded line',
            async (id) => {
              const sub = await subscription(sql(), id, { tier: 'team_manual' });
              await paidLine(sql(), id, {
                subscriptionId: sub,
                tier: 'team_manual',
                refunded: 2450,
              });
            },
          ],
          [
            'a line on a plan with no allowance (Enterprise)',
            async (id) => {
              const sub = await subscription(sql(), id, { tier: 'enterprise' });
              await paidLine(sql(), id, { subscriptionId: sub, tier: 'enterprise' });
            },
          ],
          [
            'a yearly line',
            async (id) => {
              const sub = await subscription(sql(), id, { tier: 'api_builder' });
              await paidLine(sql(), id, {
                subscriptionId: sub,
                tier: 'api_builder',
                interval: 'year',
                start: "date_trunc('second', now()) - interval '40 days'",
                end: "date_trunc('second', now()) + interval '300 days'",
              });
            },
          ],
          [
            'a live crypto term',
            (id) => cryptoEntitlement(sql(), id, { tier: 'team_manual' }).then(() => undefined),
          ],
          [
            'an expired crypto term',
            (id) =>
              cryptoEntitlement(sql(), id, {
                tier: 'team_manual',
                starts: "now() - interval '60 days'",
                expires: "now() - interval '29 days'",
              }).then(() => undefined),
          ],
          ['a live override', (id) => planOverride(sql(), id, { monthlyCredits: 100 })],
          ['a zero-credit override', (id) => planOverride(sql(), id, { monthlyCredits: 0 })],
          [
            'an ended override',
            (id) =>
              planOverride(sql(), id, { monthlyCredits: 100, ends: "now() - interval '1 hour'" }),
          ],
          [
            'a future-anchored override',
            (id) =>
              planOverride(sql(), id, { monthlyCredits: 100, anchor: "now() + interval '2 days'" }),
          ],
        ];
        let covered = 0;
        for (const [label, arrange] of cases) {
          const id = await seedAccount(f, 'team_manual');
          await arrange(id);
          const owed =
            (await h().base.windows.coverageCandidates(h().base.database.db, id)).length > 0;
          const facts = await h().cutoverRepo.coverageFacts(id);
          expect(facts.hasPaidCoverage, label).toBe(owed);
          if (owed) covered += 1;
        }
        expect(covered, 'the table exercises both answers').toBeGreaterThanOrEqual(4);
      });
    });
  },
);
