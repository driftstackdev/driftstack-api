// S15/S16 audit fix #2 — a staff credit mutation and its audit row commit
// together, or neither does.
//
// The cutover wrote its audit rows only after the WHOLE batch returned, outside
// every account's transaction: a batch that failed part-way left the accounts
// it had already committed with no audit row, and a resumed run reported them
// `already_moved`, which is never audited — so they never got one. Goodwill,
// forgive, override set/clear, publish, withdraw and rollback had the same
// shape: mutation committed, THEN audited, so a failed audit write left a
// mutation a retry reports as `applied:false` and never audits.
//
// Each audit row is now written in the mutation's own transaction. Two proofs:
//   · the cutover batch that fails on its third account leaves EXACTLY two
//     audit rows (the two committed moves), and the resume adds exactly one;
//   · a mutation whose audit write fails leaves NOTHING behind. The failing
//     writer is a staff identity absent from the database (the audit row's
//     actor columns are foreign keys) and, for the code before this fix, an
//     audit sink that throws — whichever path the route takes, the audit
//     write fails, and the test reads the table the mutation would have written.

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import type { CreditLedgerTx } from '../../src/db/credit-ledger-repo.js';
import { CreditCutoverService } from '../../src/services/credit-cutover.js';
import { openLedgerDatabase, MICRO } from './_helpers/credit-ledger-fixtures.js';
import { paidLine, planOverride, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminAuditRowsFor,
  adminCreditsHarness,
  DEFAULT_STAFF_IDENTITY,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_audit';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;
const OWNER_EMAIL = 'owner-audit-fix@driftstack.test';

/** A staff identity that exists in the app's auth store and NOT in the database. */
const GHOST = {
  accountId: '00000000-0000-4000-8000-00000000dead',
  apiKeyId: '00000000-0000-4000-8000-00000000beef',
} as const;

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

const open: TestAppFixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.cleanup();
});

/** The ordinary staff app (identity seeded in the database). */
async function staffApp(opts: { readonly owner?: boolean } = {}): Promise<TestAppFixture> {
  const f = await buildTestApp({
    aiCredits: h().aiCredits,
    scopes: [...ADMIN_SCOPES],
    ...(opts.owner === true ? { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL } : {}),
  });
  open.push(f);
  return f;
}

/** A staff app whose every audit write fails. */
async function failingAuditApp(opts: { readonly owner?: boolean } = {}): Promise<TestAppFixture> {
  const f = await buildTestApp({
    aiCredits: h().aiCredits,
    scopes: [...ADMIN_SCOPES],
    accountId: GHOST.accountId,
    apiKeyId: GHOST.apiKeyId,
    ...(opts.owner === true ? { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL } : {}),
  });
  open.push(f);
  return f;
}

async function seedAccount(
  apps: readonly TestAppFixture[],
  tier: AccountTier = 'team_manual',
): Promise<string> {
  const id = randomUUID();
  const email = `s15audit-${id}@driftstack.test`;
  await sql()`
    INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${email}, ${tier}::account_tier)`;
  h().internalEmails.add(email);
  for (const f of apps) {
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
  }
  return id;
}

async function payFor(accountId: string, tier: AccountTier = 'team_manual'): Promise<void> {
  const subscriptionId = await subscription(sql(), accountId, { tier });
  await paidLine(sql(), accountId, { subscriptionId, tier });
}

async function billingMode(accountId: string): Promise<string> {
  const [row] = await sql()<Array<{ m: string }>>`
    SELECT billing_mode AS m FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return row?.m ?? 'legacy';
}

async function count(query: postgres.PendingQuery<Array<{ n: number }>>): Promise<number> {
  const [row] = await query;
  return row?.n ?? -1;
}

function post(
  f: TestAppFixture,
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return f.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${f.plaintext}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function owe(accountId: string, credits: number): Promise<void> {
  await h().base.ledger.transaction(async (tx) => {
    await h().base.ledger.lockAccount(tx, accountId);
    await h().base.ledger.append(
      {
        accountId,
        kind: 'debt_incurred',
        amountMicro: credits * MICRO,
        reason: 'plan_change',
        idempotencyKey: `debt:${randomUUID()}`,
      },
      tx,
    );
  });
}

const in31Days = (): string => new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();

describe.skipIf(!RUN_DB_TESTS)(
  'every staff credit mutation commits together with its audit row',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    describe('the cutover audits each account inside that account’s own move', () => {
      it('CRITICAL a batch failing on its third account leaves exactly two audit rows — one per committed move — and the resume audits only the third', async () => {
        const f = await staffApp();
        const ids = [await seedAccount([f]), await seedAccount([f]), await seedAccount([f])];
        for (const id of ids) await payFor(id);

        let refreshes = 0;
        const faulty = new CreditCutoverService({
          ledger: h().base.ledger,
          cutoverRepo: h().cutoverRepo,
          creditGrants: {
            refreshCreditsIn: (tx: CreditLedgerTx, accountId: string) => {
              refreshes += 1;
              if (refreshes > 2) throw new Error('simulated crash on the third account');
              return h().grants.refreshCreditsIn(tx, accountId);
            },
          },
          pool: h().base.database.db,
          internalEmails: h().internalEmails,
        });
        const crashing = await buildTestApp({
          aiCredits: {
            ...h().aiCredits,
            cutover: {
              planCutover: faulty.planCutover.bind(faulty),
              runCutover: faulty.runCutover.bind(faulty),
              previewRollback: faulty.previewRollback.bind(faulty),
              rollbackAccount: faulty.rollbackAccount.bind(faulty),
            },
          },
          scopes: [...ADMIN_SCOPES],
        });
        open.push(crashing);
        for (const id of ids) {
          crashing.authRepo.upsertAccount({
            id,
            email: `x-${id}@driftstack.test`,
            name: null,
            tier: 'team_manual',
            status: 'active',
            timezone: null,
            avatarR2Key: null,
            slug: null,
            region: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          });
        }

        const first = await post(crashing, '/v1/admin/ai-credits/cutover', {
          account_ids: ids.map((id) => `acc_${id}`),
          to: 'credits',
        });
        expect(first.statusCode).toBe(500);
        expect(await Promise.all(ids.map(billingMode))).toEqual(['credits', 'credits', 'legacy']);
        const afterCrash = await Promise.all(
          ids.map((id) => adminAuditRowsFor(sql(), { targetAccountId: id })),
        );
        expect(
          afterCrash.map((rows) => rows.map((r) => r.action)),
          'each committed move has its audit row; the uncommitted third has none',
        ).toEqual([['credits.cutover_moved'], ['credits.cutover_moved'], []]);
        expect(afterCrash[0]?.[0]?.admin_account_id).toBe(DEFAULT_STAFF_IDENTITY.accountId);

        const resumed = await post(f, '/v1/admin/ai-credits/cutover', {
          account_ids: ids.map((id) => `acc_${id}`),
          to: 'credits',
        });
        expect(resumed.statusCode, resumed.body).toBe(200);
        expect(resumed.json<{ decisions: Array<{ outcome: string }> }>().decisions).toEqual([
          expect.objectContaining({ outcome: 'already_moved' }),
          expect.objectContaining({ outcome: 'already_moved' }),
          expect.objectContaining({ outcome: 'move' }),
        ]);
        const afterResume = await Promise.all(
          ids.map((id) => adminAuditRowsFor(sql(), { targetAccountId: id })),
        );
        expect(
          afterResume.map((rows) => rows.length),
          'exactly one audit row per moved account — nothing audited twice',
        ).toEqual([1, 1, 1]);
      });

      it('CRITICAL a cutover whose audit write fails leaves the account on legacy with nothing granted', async () => {
        const f = await failingAuditApp();
        const accountId = await seedAccount([f]);
        await payFor(accountId);
        const res = await post(f, '/v1/admin/ai-credits/cutover', {
          account_ids: [`acc_${accountId}`],
          to: 'credits',
        });
        expect(res.statusCode).toBe(500);
        expect(await billingMode(accountId)).toBe('legacy');
        expect(
          await count(
            sql()`SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`,
          ),
        ).toBe(0);
      });

      it('CRITICAL a rollback whose audit write fails leaves the account on credits', async () => {
        const good = await staffApp();
        const bad = await failingAuditApp();
        const accountId = await seedAccount([good, bad]);
        await payFor(accountId);
        expect(
          (
            await post(good, '/v1/admin/ai-credits/cutover', {
              account_ids: [`acc_${accountId}`],
              to: 'credits',
            })
          ).statusCode,
        ).toBe(200);
        const res = await post(bad, '/v1/admin/ai-credits/rollback', {
          account_id: `acc_${accountId}`,
        });
        expect(res.statusCode).toBe(500);
        expect(await billingMode(accountId)).toBe('credits');
        expect(
          (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).map((r) => r.action),
        ).toEqual(['credits.cutover_moved']);
      });
    });

    describe('goodwill and forgiveness', () => {
      it('CRITICAL a committed goodwill grant has exactly one audit row, naming the staff member; the repeat adds none', async () => {
        const f = await staffApp();
        const accountId = await seedAccount([f]);
        const payload = {
          kind: 'goodwill',
          credits: 25,
          expires_at: in31Days(),
          reason: 'apology',
          idempotency_key: `gw-${randomUUID()}`,
        };
        const url = `/v1/admin/accounts/acc_${accountId}/credits/adjustments`;
        expect((await post(f, url, payload)).statusCode).toBe(200);
        expect((await post(f, url, payload)).json<{ applied: boolean }>().applied).toBe(false);
        const rows = await adminAuditRowsFor(sql(), { targetAccountId: accountId });
        expect(rows.map((r) => r.action)).toEqual(['credits.goodwill_granted']);
        expect(rows[0]?.admin_account_id).toBe(DEFAULT_STAFF_IDENTITY.accountId);
      });

      it('CRITICAL a goodwill grant whose audit write fails grants nothing — no lot, no ledger row', async () => {
        const f = await failingAuditApp();
        const accountId = await seedAccount([f]);
        const res = await post(f, `/v1/admin/accounts/acc_${accountId}/credits/adjustments`, {
          kind: 'goodwill',
          credits: 25,
          expires_at: in31Days(),
          reason: 'apology',
          idempotency_key: `gw-${randomUUID()}`,
        });
        expect(res.statusCode).toBe(500);
        expect(
          await count(
            sql()`SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`,
          ),
        ).toBe(0);
        expect(
          await count(
            sql()`SELECT count(*)::int AS n FROM credit_ledger WHERE account_id = ${accountId}::uuid`,
          ),
        ).toBe(0);
      });

      it('CRITICAL a forgiveness whose audit write fails forgives nothing — the debt stands', async () => {
        const f = await failingAuditApp();
        const accountId = await seedAccount([f]);
        await owe(accountId, 7);
        const res = await post(f, `/v1/admin/accounts/acc_${accountId}/credits/adjustments`, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: `fg-${randomUUID()}`,
        });
        expect(res.statusCode).toBe(500);
        const [row] = await sql()<Array<{ debt: string }>>`
        SELECT debt_micro::text AS debt FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
        expect(Number(row?.debt)).toBe(7 * MICRO);
      });
    });

    describe('plan overrides', () => {
      it('CRITICAL an override PUT whose audit write fails writes no override', async () => {
        const f = await failingAuditApp();
        const accountId = await seedAccount([f]);
        const res = await f.app.inject({
          method: 'PUT',
          url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
          headers: { authorization: `Bearer ${f.plaintext}` },
          payload: { monthly_credits: 4000, reason: 'contract' },
        });
        expect(res.statusCode).toBe(500);
        expect(
          await count(
            sql()`SELECT count(*)::int AS n FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`,
          ),
        ).toBe(0);
      });

      it('CRITICAL an override DELETE whose audit write fails leaves the override live', async () => {
        const f = await failingAuditApp();
        const accountId = await seedAccount([f]);
        await planOverride(sql(), accountId, { monthlyCredits: 4000 });
        const res = await f.app.inject({
          method: 'DELETE',
          url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
          headers: { authorization: `Bearer ${f.plaintext}` },
        });
        expect(res.statusCode).toBe(500);
        const [row] = await sql()<Array<{ ends: Date | null }>>`
        SELECT ends_at AS ends FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
        expect(row?.ends ?? null, 'still open-ended').toBeNull();
      });
    });

    describe('rate cards', () => {
      it('CRITICAL a publish whose audit write fails publishes no card', async () => {
        const f = await failingAuditApp({ owner: true });
        const before = await count(sql()`SELECT count(*)::int AS n FROM credit_rate_cards`);
        const res = await post(f, '/v1/admin/credit-rate-cards', {
          markup_bp: 20000,
          effective_at: new Date(
            Date.now() + (40 * 24 + Math.random() * 24) * 3600 * 1000,
          ).toISOString(),
        });
        expect(res.statusCode).toBe(500);
        expect(await count(sql()`SELECT count(*)::int AS n FROM credit_rate_cards`)).toBe(before);
      });

      it('CRITICAL a withdrawal whose audit write fails leaves the card announced', async () => {
        const good = await staffApp({ owner: true });
        const published = await post(good, '/v1/admin/credit-rate-cards', {
          markup_bp: 20000,
          effective_at: new Date(
            Date.now() + (50 * 24 + Math.random() * 24) * 3600 * 1000,
          ).toISOString(),
        });
        expect(published.statusCode, published.body).toBe(200);
        const version = published.json<{ version: number }>().version;
        expect(
          (
            await adminAuditRowsFor(sql(), { targetResourceId: `rate_card_${String(version)}` })
          ).map((r) => r.action),
        ).toEqual(['rate_card.published']);

        const bad = await failingAuditApp({ owner: true });
        const res = await post(bad, `/v1/admin/credit-rate-cards/${String(version)}/withdraw`);
        expect(res.statusCode).toBe(500);
        const [row] = await sql()<Array<{ w: Date | null }>>`
        SELECT withdrawn_at AS w FROM credit_rate_cards WHERE version = ${version}`;
        expect(row?.w ?? null, 'the card was not withdrawn').toBeNull();
      });
    });
  },
);
