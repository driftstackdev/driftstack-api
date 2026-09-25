// S15 — the AI-credits ADMIN tools, end to end: contract credits (plan
// override), goodwill grants and debt forgiveness, and rate-card publishing.
//
// Driven through the FULL app (`buildTestApp({ aiCredits, ... })`) over a
// real, freshly-migrated Postgres database — the same wiring bootstrap.ts
// uses in production (`adminCreditsHarness`, built on the reservations
// fixtures S12/S13's own DB tests already proved). The database-level
// immutability of a published rate card (no edit, no second withdrawal, the
// 30-day notice, "before" judged at COMMIT) is already exhaustively proved
// against raw SQL in
// a-published-credit-rate-card-can-only-be-withdrawn-before-it-takes-effect.test.ts;
// this file proves the ROUTE and SERVICE layer on top of it — the HTTP
// shapes, the owner-only gate, the idempotency and audit contract, and that
// forgiving debt actually unblocks `reserve()`.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleAiCreditsAdminAuditRepo } from '../../src/db/ai-credits-admin-audit-repo.js';
import { openLedgerDatabase, MICRO } from './_helpers/credit-ledger-fixtures.js';
import {
  newTaskAccount,
  debtMicroOf,
  fundedTaskLot,
} from './_helpers/credit-reservation-fixtures.js';
import {
  adminAuditRowsFor,
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signInTheFixtureAccount } from './_helpers/sign-in-the-fixture-account.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15_admin_credits_routes';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

const OWNER_EMAIL = 'owner-s15@driftstack.test';

let client: postgres.Sql | null = null;
let database: Database | null = null;
let harness: AdminCreditsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 6 });
  harness = adminCreditsHarness(opened.url);
  // Every admin mutation writes its audit row inside its own transaction, and
  // the row's actor columns are foreign keys: the app's staff identity must exist.
  await seedStaffIdentity(opened.sql);
}, 60_000);

afterAll(async () => {
  await database?.close().catch(() => {});
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

/** Seed an account in the isolated Postgres DB (for the credit tables' own FK
 *  and for `reserve()`), and mirror the SAME id into the app's in-memory auth
 *  store (for `routes/admin-ai-credits.ts`'s `requireAccountExists`, which
 *  reads `deps.authRepo` — a different store than the credit tables). */
async function seedTargetAccount(fx: TestAppFixture, tier = 'team_manual'): Promise<string> {
  const id = await newTaskAccount(sql(), tier);
  fx.authRepo.upsertAccount({
    id,
    email: `target-${id}@example.test`,
    name: null,
    tier: tier as never,
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

/** Fast-forward a card past its `effective_at` for a "withdraw after it took
 *  effect" test, the same trigger-disable trick
 *  `a-published-credit-rate-card-can-only-be-withdrawn-before-it-takes-effect.test.ts`
 *  uses, so this file does not need to actually wait 30 days. */
/**
 * No model rows: `credit_rate_card_models_guard` only accepts an insert whose
 * card has `announced_at = now()` (the SAME transaction that created it), and
 * this helper deliberately backdates `announced_at` to defeat the 30-day
 * notice CHECK — so a model-row insert here would always be refused by that
 * OTHER trigger, on a table this helper never disables triggers on. Nothing
 * under test (a withdraw already-in-effect refusal) needs a priced model.
 */
async function commitCardAlreadyInEffect(version: number): Promise<void> {
  await sql().begin(async (tx) => {
    await tx`ALTER TABLE credit_rate_cards DISABLE TRIGGER USER`;
    await tx`
      INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, note)
      VALUES (${version}, 20000, now() - interval '800 hours', now() - interval '1 hour', 'already in effect')`;
    await tx`ALTER TABLE credit_rate_cards ENABLE TRIGGER USER`;
  });
}

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;

describe.skipIf(!RUN_DB_TESTS)('the AI-credits admin routes', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(database).not.toBeNull();
    expect(harness).not.toBeNull();
  });

  describe('every admin-credits route is absent when the mode is off', () => {
    const routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }> = [
      { method: 'GET', url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000000/credits' },
      {
        method: 'POST',
        url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000000/credits/adjustments',
      },
      {
        method: 'PUT',
        url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000000/ai-plan-override',
      },
      {
        method: 'DELETE',
        url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000000/ai-plan-override',
      },
      { method: 'GET', url: '/v1/admin/credit-rate-cards' },
      { method: 'POST', url: '/v1/admin/credit-rate-cards' },
      { method: 'POST', url: '/v1/admin/credit-rate-cards/1/withdraw' },
      // S16
      { method: 'POST', url: '/v1/admin/ai-credits/cutover' },
      { method: 'POST', url: '/v1/admin/ai-credits/rollback' },
    ];
    for (const route of routes) {
      it(`CRITICAL ${route.method} ${route.url} does not exist with credits off — a 404, not a 403 that would announce the surface`, async () => {
        fx = await buildTestApp({ scopes: [...ADMIN_SCOPES] });
        const res = await fx.app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: `Bearer ${fx.plaintext}` },
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
        });
        expect(res.statusCode).toBe(404);
      });
    }
  });

  it('CRITICAL a contract sets its own monthly credits — PUT .../ai-plan-override with reason "contract"', async () => {
    fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
    const accountId = await seedTargetAccount(fx);
    const res = await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_credits: 5000, reason: 'contract' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ monthly_credits: number; reason: string }>();
    expect(body.monthly_credits).toBe(5000);
    expect(body.reason).toBe('contract');

    // The override actually drives the next window level (§6.6): a monthly
    // lot for this account's current window is granted at the new figure.
    const [lot] = await sql()<Array<{ n: string }>>`
      SELECT granted_micro::text AS n FROM credit_lots
       WHERE account_id = ${accountId}::uuid AND kind = 'monthly'
       ORDER BY created_at DESC LIMIT 1`;
    expect(lot?.n, 'the current window was granted from the new override').toBe(
      String(5000 * MICRO),
    );

    expect(
      (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).map((r) => r.action),
    ).toEqual(['credits.plan_override_set']);
  });

  it('CRITICAL DELETE .../ai-plan-override ends a live override and is idempotent (no audit row the second time)', async () => {
    fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
    const accountId = await seedTargetAccount(fx);
    await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_credits: 1000, reason: 'admin_tier' },
    });

    const first = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ removed: boolean }>().removed).toBe(true);

    const second = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ removed: boolean }>().removed).toBe(false);

    expect(
      (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).filter(
        (r) => r.action === 'credits.plan_override_cleared',
      ),
      'only the first DELETE actually ended a live override',
    ).toHaveLength(1);
  });

  describe('a goodwill grant is idempotent and audited', () => {
    it('CRITICAL two calls with the same idempotency_key produce one lot, and the second is not audited', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedTargetAccount(fx);
      const key = `goodwill-${randomUUID()}`;
      const payload = {
        kind: 'goodwill',
        credits: 25,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        reason: 'apology credit',
        idempotency_key: key,
      };

      const first = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json<{
        applied: boolean;
        lot: { id: string; remaining_credits: number };
      }>();
      expect(firstBody.applied).toBe(true);
      expect(firstBody.lot.remaining_credits).toBe(25);

      const second = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload,
      });
      expect(second.statusCode).toBe(200);
      const secondBody = second.json<{ applied: boolean; lot: { id: string } }>();
      expect(secondBody.applied, 'a repeat writes nothing new').toBe(false);
      expect(secondBody.lot.id, 'the repeat reports the same lot').toBe(firstBody.lot.id);

      const [row] = await sql()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;
      expect(row?.n, 'exactly one lot exists, not two').toBe(1);

      expect(
        (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).filter(
          (r) => r.action === 'credits.goodwill_granted',
        ),
        'audits nothing new on the repeat',
      ).toHaveLength(1);
    });

    it('a goodwill grant to an account already in debt pays the debt down from it (the database refuses debt beside free credit)', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedTargetAccount(fx);
      await h().base.ledger.transaction(async (tx) => {
        await h().base.ledger.lockAccount(tx, accountId);
        await h().base.ledger.append(
          {
            accountId,
            kind: 'debt_incurred',
            amountMicro: 10 * MICRO,
            reason: 'payment_reversed',
            idempotencyKey: `debt:${accountId}`,
          },
          tx,
        );
      });
      expect(await debtMicroOf(sql(), accountId)).toBe(10 * MICRO);

      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {
          kind: 'goodwill',
          credits: 15,
          expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          reason: 'cover the debt',
          idempotency_key: `goodwill-debt-${randomUUID()}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ debt_credits: number }>();
      expect(body.debt_credits, 'the debt was settled from the new free credit').toBe(0);
      expect(await debtMicroOf(sql(), accountId)).toBe(0);
    });
  });

  it('CRITICAL forgiving debt lets the account start tasks again — proved through the real reserve() path', async () => {
    fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
    const accountId = await seedTargetAccount(fx);
    await h().base.ledger.transaction(async (tx) => {
      await h().base.ledger.lockAccount(tx, accountId);
      await h().base.ledger.append(
        {
          accountId,
          kind: 'debt_incurred',
          amountMicro: 5 * MICRO,
          reason: 'plan_change',
          idempotencyKey: `debt:${accountId}`,
        },
        tx,
      );
    });

    const refused = await h().base.service.reserve({
      accountId,
      reservationId: randomUUID(),
      agentSessionId: randomUUID(),
      idempotencyKey: null,
      model: 'claude-sonnet-5',
      mode: 'enforce',
      bootId: h().aiCredits.bootId,
    });
    expect(refused.outcome, 'refused for debt before forgiveness').toBe('refused');
    if (refused.outcome === 'refused') expect(refused.reason).toBe('debt');

    const forgive = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        kind: 'forgive_debt',
        reason: 'goodwill',
        idempotency_key: `forgive-${randomUUID()}`,
      },
    });
    expect(forgive.statusCode).toBe(200);
    const forgiveBody = forgive.json<{
      applied: boolean;
      forgiven_credits: number;
      debt_credits: number;
    }>();
    expect(forgiveBody.applied).toBe(true);
    expect(forgiveBody.forgiven_credits).toBe(5);
    expect(forgiveBody.debt_credits).toBe(0);
    expect(await debtMicroOf(sql(), accountId)).toBe(0);

    // A repeat is a no-op: nothing to forgive.
    const again = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${accountId}/credits/adjustments`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        kind: 'forgive_debt',
        reason: 'goodwill',
        idempotency_key: `forgive-again-${randomUUID()}`,
      },
    });
    expect(again.json<{ applied: boolean }>().applied).toBe(false);

    // Debt blocks a task even at zero balance; clearing it is necessary but
    // not sufficient — the account also needs credit to spend. Fund it
    // separately (the DB refuses debt beside free credit, so this could not
    // have been done before the forgiveness above).
    await fundedTaskLot(sql(), accountId, { credits: 20 });

    const admitted = await h().base.service.reserve({
      accountId,
      reservationId: randomUUID(),
      agentSessionId: randomUUID(),
      idempotencyKey: null,
      model: 'claude-sonnet-5',
      mode: 'enforce',
      bootId: h().aiCredits.bootId,
    });
    expect(admitted.outcome, 'the debt is gone, so the task is admitted').toBe('reserved');
  });

  describe('rate-card publishing is owner-only', () => {
    it('CRITICAL an ordinary staff key (driftstack_internal_admin, not the owner) is refused with 403', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: 'staff-not-owner@driftstack.test',
        ownerEmail: OWNER_EMAIL,
      });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {
          markup_bp: 20000,
          effective_at: new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString(),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('CRITICAL the owner account publishes a card, derived from the model registry with nothing hand-typed', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
      });
      // The rate-card tools need a signed-in session (security sweep #17).
      const owner = { authorization: `Bearer ${await signInTheFixtureAccount(fx)}` };
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards',
        headers: owner,
        payload: {
          markup_bp: 20000,
          effective_at: new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString(),
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ version: number; status: string; model_count: number }>();
      expect(body.status).toBe('announced');
      expect(body.model_count).toBeGreaterThanOrEqual(3);

      const listed = await fx.app.inject({
        method: 'GET',
        url: '/v1/admin/credit-rate-cards',
        headers: owner,
      });
      expect(listed.statusCode).toBe(200);
      const cards = listed.json<{ data: Array<{ version: number; status: string }> }>().data;
      expect(cards.some((c) => c.version === body.version && c.status === 'announced')).toBe(true);
    });

    it('CRITICAL a card whose effective_at is inside the 30-day notice window is refused with 400', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
      });
      // The rate-card tools need a signed-in session (security sweep #17).
      const owner = { authorization: `Bearer ${await signInTheFixtureAccount(fx)}` };
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards',
        headers: owner,
        payload: {
          markup_bp: 20000,
          effective_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/30 days|720 hours/);
    });
  });

  describe('a card can be withdrawn only before it takes effect', () => {
    it('CRITICAL an ordinary staff key cannot withdraw a card (owner-only)', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: 'staff-not-owner-2@driftstack.test',
        ownerEmail: OWNER_EMAIL,
      });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards/1/withdraw',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('CRITICAL a non-existent card version 404s', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
      });
      // The rate-card tools need a signed-in session (security sweep #17).
      const owner = { authorization: `Bearer ${await signInTheFixtureAccount(fx)}` };
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards/999999/withdraw',
        headers: owner,
      });
      expect(res.statusCode).toBe(404);
    });

    it('CRITICAL a card that has not taken effect can be withdrawn once; a second withdrawal is 409', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
      });
      // The rate-card tools need a signed-in session (security sweep #17).
      const owner = { authorization: `Bearer ${await signInTheFixtureAccount(fx)}` };
      const publish = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/credit-rate-cards',
        headers: owner,
        payload: {
          // 20000 (2.0x, the launch card's own markup): every on-credits
          // model's prices are known to divide into whole microcredits at
          // this value. Not every markup does — 25000 (2.5x) refuses two of
          // the three models on `cacheWrite5mMicroPerToken` alone, which is
          // `deriveRateCardRows`' own `price_not_whole` rule working as
          // designed, not something this test is about.
          markup_bp: 20000,
          effective_at: new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString(),
        },
      });
      expect(publish.statusCode, publish.body).toBe(200);
      const version = publish.json<{ version: number }>().version;

      const withdrawn = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/credit-rate-cards/${String(version)}/withdraw`,
        headers: owner,
      });
      expect(withdrawn.statusCode).toBe(200);
      expect(withdrawn.json<{ status: string }>().status).toBe('withdrawn');

      const again = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/credit-rate-cards/${String(version)}/withdraw`,
        headers: owner,
      });
      expect(again.statusCode).toBe(409);
    });

    it('CRITICAL a card already in effect cannot be withdrawn — 409, not the immutability 500 the trigger itself raises', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
      });
      // The rate-card tools need a signed-in session (security sweep #17).
      const owner = { authorization: `Bearer ${await signInTheFixtureAccount(fx)}` };
      const [nextRow] = await sql()<Array<{ next: number }>>`
        SELECT (coalesce(max(version), 0) + 1)::int AS next FROM credit_rate_cards`;
      const next = nextRow?.next;
      if (next === undefined) throw new Error('could not compute the next rate card version');
      await commitCardAlreadyInEffect(next);

      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/admin/credit-rate-cards/${String(next)}/withdraw`,
        headers: owner,
      });
      expect(res.statusCode).toBe(409);
    });
  });

  it('GET .../credits reads billing mode, source, lots, debt and the last ledger entries for one account', async () => {
    fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
    const accountId = await seedTargetAccount(fx);
    await fx.app.inject({
      method: 'PUT',
      url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { monthly_credits: 2000, reason: 'contract' },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/admin/accounts/acc_${accountId}/credits`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      account_id: string;
      billing: string;
      plan_override: { monthly_credits: number; reason: string } | null;
      ledger: unknown[];
      debt_credits: number;
    }>();
    expect(body.account_id).toBe(`acc_${accountId}`);
    expect(body.plan_override).toEqual(
      expect.objectContaining({ monthly_credits: 2000, reason: 'contract' }),
    );
    expect(body.debt_credits).toBe(0);
    expect(Array.isArray(body.ledger)).toBe(true);
    expect(body.ledger.length).toBeGreaterThan(0);
  });

  it('an unknown account id 404s rather than reaching the credit tables', async () => {
    fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000000/credits',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('DrizzleAiCreditsAdminAuditRepo (migration 0134) against the real table', () => {
    it('CRITICAL records and lists a row, and the database itself refuses an action outside the six published here', async () => {
      if (database === null) throw new Error('isolated database unreachable');
      const repo = new DrizzleAiCreditsAdminAuditRepo(database);
      const adminAccountId = await newTaskAccount(sql());
      const targetAccountId = await newTaskAccount(sql());
      const [apiKeyRow] = await sql()<Array<{ id: string }>>`
        INSERT INTO api_keys (account_id, name, key_prefix, key_hash, scopes)
        VALUES (${adminAccountId}::uuid, 'test', ${`test_${randomUUID().slice(0, 8)}`}, 'x', '{}')
        RETURNING id`;
      const adminKeyId = apiKeyRow?.id;
      if (adminKeyId === undefined) throw new Error('api_keys insert returned nothing');

      const written = await repo.record({
        adminAccountId,
        adminKeyId,
        action: 'credits.goodwill_granted',
        targetAccountId,
        targetResourceId: null,
        inputPayload: { credits: 10 },
        result: 'success',
        ipAddress: '127.0.0.1',
      });
      expect(written.action).toBe('credits.goodwill_granted');

      const page = await repo.list({ targetAccountId, limit: 10 });
      expect(page.items.map((r) => r.id)).toContain(written.id);

      await expect(
        sql().unsafe(
          `INSERT INTO ai_credits_admin_audit_log (admin_account_id, admin_key_id, action, result)
           VALUES ('${adminAccountId}', '${adminKeyId}', 'not_a_real_action', 'success')`,
        ),
      ).rejects.toThrow(/ai_credits_admin_audit_log_action_check/);
    });
  });
});
