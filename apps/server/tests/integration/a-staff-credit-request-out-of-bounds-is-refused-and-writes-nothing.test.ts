// S15 audit fix #8 — a staff credit request that is out of bounds is refused
// with a 400 (or a 409 for a clash), and writes nothing.
//
// Each of these used to reach the database or `creditsToMicro` and come back as
// a 500: fractional credits (the schema allowed 0.001 steps, the conversion
// needs whole credits), an unbounded credit figure, a goodwill `expires_at`
// already past (or before the lot's own start), an override PUT whose
// `expires_at` is past, and a second rate card on an `effective_at` a live card
// already has (23505 on `credit_rate_cards_live_effective_unique`).
//
// Each credit bound is ONE constant in api-types: a goodwill grant's
// `ADMIN_CREDITS_MAX_PER_REQUEST` (1,000,000 credits a request), and a monthly
// figure's `ADMIN_MONTHLY_CREDITS_MAX` (10,000,000 a month, the storage bound),
// which the override PUT shares with the Enterprise tier change (S13–S16
// re-audit #7: the PUT used to read the goodwill bound, so it refused a contract
// the tier change had written).

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CREDITS_MAX_PER_REQUEST, ADMIN_MONTHLY_CREDITS_MAX } from '@driftstack/api-types';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { newTaskAccount } from './_helpers/credit-reservation-fixtures.js';
import {
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signInTheFixtureAccount } from './_helpers/sign-in-the-fixture-account.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_inputs';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;
const OWNER_EMAIL = 'owner-inputs-fix@driftstack.test';
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
  if (fx) await fx.cleanup();
  fx = null;
});

async function app(opts: { readonly owner?: boolean } = {}): Promise<TestAppFixture> {
  fx = await buildTestApp({
    aiCredits: h().aiCredits,
    scopes: [...ADMIN_SCOPES],
    ...(opts.owner === true ? { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL } : {}),
  });
  return fx;
}

async function target(f: TestAppFixture): Promise<string> {
  const id = await newTaskAccount(sql(), 'team_manual');
  f.authRepo.upsertAccount({
    id,
    email: `inputs-${id}@example.test`,
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

async function lots(accountId: string): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;
  return row?.n ?? -1;
}

async function overrides(accountId: string): Promise<number> {
  const [row] = await sql()<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
  return row?.n ?? -1;
}

async function goodwill(
  f: TestAppFixture,
  accountId: string,
  body: { credits: number; expires_at: string },
): Promise<LightMyRequestResponse> {
  return f.app.inject({
    method: 'POST',
    url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
    headers: { authorization: `Bearer ${f.plaintext}` },
    payload: {
      kind: 'goodwill',
      reason: 'bounds',
      idempotency_key: `bounds-${randomUUID()}`,
      ...body,
    },
  });
}

async function putOverride(
  f: TestAppFixture,
  accountId: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return f.app.inject({
    method: 'PUT',
    url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
    headers: { authorization: `Bearer ${f.plaintext}` },
    payload: body,
  });
}

describe.skipIf(!RUN_DB_TESTS)(
  'a staff credit request out of bounds is refused and writes nothing',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    it('the bounds are one million credits a goodwill request and ten million a month', () => {
      expect(ADMIN_CREDITS_MAX_PER_REQUEST).toBe(1_000_000);
      expect(ADMIN_MONTHLY_CREDITS_MAX).toBe(10_000_000);
    });

    describe('goodwill credits', () => {
      for (const credits of [1.5, 0.001, 1e13, ADMIN_CREDITS_MAX_PER_REQUEST + 1]) {
        it(`CRITICAL credits ${String(credits)} is a 400 and grants nothing`, async () => {
          const f = await app();
          const accountId = await target(f);
          const res = await goodwill(f, accountId, {
            credits,
            expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          });
          expect(res.statusCode, res.body).toBe(400);
          expect(await lots(accountId)).toBe(0);
        });
      }

      it('BOUNDARY CONTROL — exactly the bound is granted', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await goodwill(f, accountId, {
          credits: ADMIN_CREDITS_MAX_PER_REQUEST,
          expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(await lots(accountId)).toBe(1);
      });
    });

    describe('goodwill expiry', () => {
      it('CRITICAL an expires_at already past (yesterday) is a 400 and grants nothing', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await goodwill(f, accountId, {
          credits: 10,
          expires_at: new Date(Date.now() - DAY_MS).toISOString(),
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.body).toMatch(/expires_at/);
        expect(await lots(accountId)).toBe(0);
      });

      it('CRITICAL an expires_at a few seconds ago — after the lot’s own start, but not after now — is a 400: a grant must not arrive already expired', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await goodwill(f, accountId, {
          credits: 10,
          expires_at: new Date(Date.now() - 5_000).toISOString(),
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(await lots(accountId)).toBe(0);
      });
    });

    describe('plan override', () => {
      it('CRITICAL an override PUT with a past expires_at is a 400 and writes no override', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await putOverride(f, accountId, {
          monthly_credits: 5000,
          reason: 'contract',
          expires_at: new Date(Date.now() - DAY_MS).toISOString(),
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.body).toMatch(/expires_at/);
        expect(await overrides(accountId)).toBe(0);
      });

      it('CRITICAL monthly_credits past the monthly bound is a 400 and writes no override', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await putOverride(f, accountId, {
          monthly_credits: ADMIN_MONTHLY_CREDITS_MAX + 1,
          reason: 'contract',
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(await overrides(accountId)).toBe(0);
      });

      it('CRITICAL a 2,000,000-credit contract — past a goodwill grant’s bound, within the monthly one the tier change also accepts — is written (re-audit #7)', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await putOverride(f, accountId, {
          monthly_credits: 2_000_000,
          reason: 'contract',
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<{ monthly_credits: number }>().monthly_credits).toBe(2_000_000);
        expect(await overrides(accountId)).toBe(1);
      });

      it('CONTROL — a future expires_at is accepted', async () => {
        const f = await app();
        const accountId = await target(f);
        const res = await putOverride(f, accountId, {
          monthly_credits: 5000,
          reason: 'contract',
          expires_at: new Date(Date.now() + 60 * DAY_MS).toISOString(),
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(await overrides(accountId)).toBe(1);
      });
    });

    describe('rate cards', () => {
      it('CRITICAL a second card on an effective_at a live card already has is a 409, and only the first card exists', async () => {
        const f = await app({ owner: true });
        // The rate-card tools need a signed-in session (security sweep #17).
        const session = await signInTheFixtureAccount(f);
        // Whole seconds, so the value the database stores equals the one sent.
        const effectiveAt = new Date(
          Math.floor((Date.now() + (60 + Math.random() * 30) * DAY_MS) / 1000) * 1000,
        ).toISOString();
        const publish = (): Promise<LightMyRequestResponse> =>
          f.app.inject({
            method: 'POST',
            url: '/v1/admin/credit-rate-cards',
            headers: { authorization: `Bearer ${session}` },
            payload: { markup_bp: 20000, effective_at: effectiveAt },
          });
        const first = await publish();
        expect(first.statusCode, first.body).toBe(200);
        const second = await publish();
        expect(second.statusCode, second.body).toBe(409);
        const [row] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_rate_cards WHERE effective_at = ${effectiveAt}::timestamptz`;
        expect(row?.n, 'nothing was written by the refused second publish').toBe(1);
      });
    });
  },
);
