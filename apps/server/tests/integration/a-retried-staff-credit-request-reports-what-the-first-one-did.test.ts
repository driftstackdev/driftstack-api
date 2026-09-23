// S15 audit fixes #4 and #9 — a retried staff credit request reports what the
// first one did, however much later it arrives and whatever has changed since.
//
// #4. A goodwill lot's `starts_at` comes from the clock (the start of the prior
// minute), and `insertLot` compared it: a retry of the same body in a later
// minute — the response was lost, staff try again — read as a different grant
// and got 409 "already used for a different goodwill grant", which invites a
// NEW key and a second grant. For an `adjustment` lot the comparison now
// ignores `starts_at`; amount, expiry, account and kind still decide.
//
// #9. A `forgive_debt` replay answered from the CURRENT debt: with a new debt
// of a different size it was a 409 (the ledger key's amount no longer matched),
// and at zero debt it reported 0 forgiven. A replay now reports the STORED
// entry's amount, writes nothing, and a different reason on the same key is
// still a 409.

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreditLotGrantKeyReusedError } from '../../src/db/credit-ledger-repo.js';
import { openLedgerDatabase, MICRO } from './_helpers/credit-ledger-fixtures.js';
import { debtMicroOf, newTaskAccount } from './_helpers/credit-reservation-fixtures.js';
import {
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_retry';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;
const DAY_MS = 24 * 3600 * 1000;

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
  vi.useRealTimers();
  if (fx) await fx.cleanup();
  fx = null;
});

async function app(): Promise<TestAppFixture> {
  fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
  return fx;
}

async function target(f: TestAppFixture): Promise<string> {
  const id = await newTaskAccount(sql(), 'team_manual');
  f.authRepo.upsertAccount({
    id,
    email: `retry-${id}@example.test`,
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
  return id;
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

function adjust(
  f: TestAppFixture,
  accountId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return f.app.inject({
    method: 'POST',
    url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
    headers: { authorization: `Bearer ${f.plaintext}` },
    payload,
  });
}

describe.skipIf(!RUN_DB_TESTS)(
  'a retried staff credit request reports what the first one did',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    describe('#4 — insertLot, for an adjustment lot, does not compare starts_at', () => {
      it('CRITICAL the same adjustment grant key with the same terms but a start two minutes later returns the first lot', async () => {
        const accountId = await newTaskAccount(sql(), 'team_manual');
        const grantKey = `adj-${randomUUID()}`;
        const startsAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
        const expiresAt = new Date(Date.now() + 30 * DAY_MS);
        const first = await h().base.ledger.insertLot({
          accountId,
          kind: 'adjustment',
          grantKey,
          grantedMicro: 25 * MICRO,
          startsAt,
          expiresAt,
        });
        const again = await h().base.ledger.insertLot({
          accountId,
          kind: 'adjustment',
          grantKey,
          grantedMicro: 25 * MICRO,
          startsAt: new Date(startsAt.getTime() + 2 * 60_000),
          expiresAt,
        });
        expect(first.inserted).toBe(true);
        expect(again).toEqual({ inserted: false, lot: first.lot });
      });

      it('CRITICAL the same adjustment grant key with a different AMOUNT is still refused', async () => {
        const accountId = await newTaskAccount(sql(), 'team_manual');
        const grantKey = `adj-${randomUUID()}`;
        const lot = {
          accountId,
          kind: 'adjustment' as const,
          grantKey,
          grantedMicro: 25 * MICRO,
          startsAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 30 * DAY_MS),
        };
        await h().base.ledger.insertLot(lot);
        await expect(
          h().base.ledger.insertLot({ ...lot, grantedMicro: 26 * MICRO }),
        ).rejects.toThrow(CreditLotGrantKeyReusedError);
      });

      it('CONTROL — any other kind of lot still compares starts_at: a top-up with a later start is a different grant', async () => {
        const accountId = await newTaskAccount(sql(), 'team_manual');
        const grantKey = `top-${randomUUID()}`;
        const lot = {
          accountId,
          kind: 'top_up' as const,
          grantKey,
          grantedMicro: 25 * MICRO,
          startsAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 30 * DAY_MS),
        };
        await h().base.ledger.insertLot(lot);
        await expect(
          h().base.ledger.insertLot({
            ...lot,
            startsAt: new Date(lot.startsAt.getTime() + 120_000),
          }),
        ).rejects.toThrow(CreditLotGrantKeyReusedError);
      });

      it('CRITICAL through the route: the same goodwill body retried two minutes later is 200 applied:false with one lot; the same key with a different amount is still 409', async () => {
        const f = await app();
        const accountId = await target(f);
        const payload = {
          kind: 'goodwill',
          credits: 40,
          expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          reason: 'lost response',
          idempotency_key: `retry-${randomUUID()}`,
        };
        const first = await adjust(f, accountId, payload);
        expect(first.statusCode, first.body).toBe(200);
        expect(first.json<{ applied: boolean }>().applied).toBe(true);

        // Only the process clock moves; the database's own now() does not.
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 60_000 + 5_000 });
        const retry = await adjust(f, accountId, payload);
        expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json<{ applied: boolean; lot: { id: string } }>()).toMatchObject({
          applied: false,
          lot: { id: first.json<{ lot: { id: string } }>().lot.id },
        });
        const different = await adjust(f, accountId, { ...payload, credits: 41 });
        expect(different.statusCode, different.body).toBe(409);
        vi.useRealTimers();

        const [row] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;
        expect(row?.n, 'granted once').toBe(1);
      });
    });

    describe('#9 — a forgive_debt replay reports the stored entry, not the current debt', () => {
      it('CRITICAL a replay while the account owes a DIFFERENT amount is 200 applied:false, reports the 10 first forgiven, and forgives nothing new', async () => {
        const f = await app();
        const accountId = await target(f);
        const key = `forgive-${randomUUID()}`;
        await owe(accountId, 10);
        const first = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        expect(first.json()).toMatchObject({
          applied: true,
          forgiven_credits: 10,
          debt_credits: 0,
        });

        await owe(accountId, 7);
        const replay = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toMatchObject({
          applied: false,
          forgiven_credits: 10,
          debt_credits: 7,
        });
        expect(await debtMicroOf(sql(), accountId), 'nothing new was forgiven').toBe(7 * MICRO);
      });

      it('CRITICAL a replay while the account owes the SAME amount again forgives nothing: the debt stays', async () => {
        const f = await app();
        const accountId = await target(f);
        const key = `forgive-${randomUUID()}`;
        await owe(accountId, 10);
        await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        await owe(accountId, 10);
        const replay = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        expect(replay.json()).toMatchObject({
          applied: false,
          forgiven_credits: 10,
          debt_credits: 10,
        });
        expect(await debtMicroOf(sql(), accountId)).toBe(10 * MICRO);
      });

      it('CRITICAL a replay at zero debt reports what the key forgave, not 0', async () => {
        const f = await app();
        const accountId = await target(f);
        const key = `forgive-${randomUUID()}`;
        await owe(accountId, 12);
        await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        const replay = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        expect(replay.json()).toMatchObject({
          applied: false,
          forgiven_credits: 12,
          debt_credits: 0,
        });
      });

      it('the same key with a different reason is still a 409', async () => {
        const f = await app();
        const accountId = await target(f);
        const key = `forgive-${randomUUID()}`;
        await owe(accountId, 5);
        await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: key,
        });
        const other = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'a different reason',
          idempotency_key: key,
        });
        expect(other.statusCode, other.body).toBe(409);
      });

      it('CONTROL — a new key at zero debt still reports 0 forgiven and writes nothing', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await adjust(f, accountId, {
          kind: 'forgive_debt',
          reason: 'goodwill',
          idempotency_key: `forgive-${randomUUID()}`,
        });
        expect(res.json()).toMatchObject({ applied: false, forgiven_credits: 0, debt_credits: 0 });
      });
    });
  },
);
