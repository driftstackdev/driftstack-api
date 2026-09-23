// S16 — the per-account cutover and rollback, end to end: `services/credit-
// cutover.ts` against a real, freshly-migrated Postgres database, and
// `POST /v1/admin/ai-credits/{cutover,rollback}` through the FULL app
// (`buildTestApp({ aiCredits, ... })`), the same wiring bootstrap.ts uses in
// production. Built on `adminCreditsHarness` (S15's own fixture, extended
// here with the cutover service) and `credit-grant-fixtures.ts`'s paid-
// coverage helpers (subscriptions, paid invoices) — the same fixtures S4/S5's
// own database tests already proved.
//
// §8.5's mapping table itself, and the pure refusal/eligibility decisions,
// are proved without a database in credit-cutover-decisions.test.ts; this
// file proves the WRITES — the transaction boundaries, the idempotency, the
// resumability, the snapshot round-trip through the S13 status route, and
// the HTTP shapes.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import type { CreditLedgerTx } from '../../src/db/credit-ledger-repo.js';
import { openLedgerDatabase, MICRO } from './_helpers/credit-ledger-fixtures.js';
import { subscription, paidLine } from './_helpers/credit-grant-fixtures.js';
import {
  adminAuditRowsFor,
  adminCreditsHarness,
  DEFAULT_STAFF_IDENTITY,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';
import { CreditCutoverService } from '../../src/services/credit-cutover.js';
import { aiCreditsAdminAuditIn } from '../../src/db/ai-credits-admin-audit-repo.js';
import { decideAiSource } from '../../src/services/ai-source.js';
import { aiEntitlementFor, type AccountTier } from '@driftstack/api-types';

const ISOLATED_DB_NAME = 'driftstack_iso_s16_cutover_routes';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

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
  // Audit rows are written inside each move's own transaction, and their
  // actor columns are foreign keys: the app's staff identity must exist.
  await seedStaffIdentity(opened.sql);
}, 60_000);

/** The audit hook every direct `runCutover` call here passes: the same
 *  in-transaction writer the route uses, as the default staff identity. */
const AUDIT_AS_STAFF = {
  onMoved: async (tx: CreditLedgerTx, d: { accountId: string; aiSource: string | null }) => {
    await aiCreditsAdminAuditIn(tx).record({
      adminAccountId: DEFAULT_STAFF_IDENTITY.accountId,
      adminKeyId: DEFAULT_STAFF_IDENTITY.apiKeyId,
      action: 'credits.cutover_moved',
      targetAccountId: d.accountId,
      inputPayload: { ai_source: d.aiSource, selector: 'test' },
      result: 'success',
    });
  },
};

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

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

const ADMIN_SCOPES = ['read', 'write', 'driftstack_internal_admin'] as const;

/** A legacy account row, with the given tier/consent/cap, and (opts.hasKey)
 *  a placeholder BYOK ciphertext — cutover and `getUsabilityFacts` both only
 *  ever ask whether one is PRESENT, never decrypt it (see
 *  `credit-cutover.ts`'s own comment on why "stored" beats "usable" here). */
async function seedAccount(
  fx: TestAppFixture,
  opts: {
    readonly tier: AccountTier;
    readonly consent?: boolean;
    readonly capCents?: number;
    readonly hasKey?: boolean;
    readonly keySetAt?: string;
    readonly email?: string;
    /** In C0 (default). Phase 1 moves nothing outside it, by id or cohort. */
    readonly internal?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const email = opts.email ?? `s16-${id}@example.test`;
  if (opts.internal !== false) h().internalEmails.add(email);
  await sql()`
    INSERT INTO accounts (id, email, tier, bundled_llm_consent, bundled_llm_monthly_cap_usd_cents)
    VALUES (${id}::uuid, ${email}, ${opts.tier}::account_tier, ${opts.consent ?? false},
            ${opts.capCents ?? 2000})`;
  if (opts.hasKey === true) {
    await sql().unsafe(
      `UPDATE accounts SET byok_anthropic_api_key_ciphertext = '\\x00', byok_anthropic_api_key_set_at = ${opts.keySetAt ?? 'now()'} WHERE id = $1`,
      [id],
    );
  }
  await sql()`INSERT INTO credit_accounts (account_id) VALUES (${id}::uuid)`;
  fx.authRepo.upsertAccount({
    id,
    email,
    name: null,
    tier: opts.tier,
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

/** A paid Stripe subscription + invoice covering now(), the same shape
 *  `credit-grant-fixtures.ts`'s `payingCustomer` builds, attached to an
 *  ALREADY-CREATED account (so its tier/consent/cap/key can be chosen
 *  first). */
async function givePaidCoverage(accountId: string, tier: AccountTier): Promise<void> {
  const subscriptionId = await subscription(sql(), accountId, { tier });
  await paidLine(sql(), accountId, { subscriptionId, tier });
}

/** The monthly lot's granted_micro for an account's current window. */
async function monthlyLotGrantedMicro(accountId: string): Promise<number | null> {
  const [row] = await sql()<Array<{ n: string }>>`
    SELECT granted_micro::text AS n FROM credit_lots
     WHERE account_id = ${accountId}::uuid AND kind = 'monthly'
     ORDER BY created_at DESC LIMIT 1`;
  return row === undefined ? null : Number(row.n);
}

async function creditAccountRow(
  accountId: string,
): Promise<{ billingMode: string; aiSource: string | null } | undefined> {
  const [row] = await sql()<Array<{ billing_mode: string; ai_source: string | null }>>`
    SELECT billing_mode, ai_source FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return row === undefined ? undefined : { billingMode: row.billing_mode, aiSource: row.ai_source };
}

async function legacySettingsRow(
  accountId: string,
): Promise<{ consent: boolean; cap: number } | undefined> {
  const [row] = await sql()<Array<{ consent: boolean; cap: number }>>`
    SELECT bundled_llm_consent AS consent, bundled_llm_monthly_cap_usd_cents AS cap
      FROM accounts WHERE id = ${accountId}::uuid`;
  return row;
}

describe.skipIf(!RUN_DB_TESTS)('S16 — the per-account cutover and rollback', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(database).not.toBeNull();
    expect(harness).not.toBeNull();
  });

  describe('the dry run (planCutover) writes nothing', () => {
    it('CRITICAL a row-count control: credit_accounts.billing_mode and credit_lots are unchanged after a dry run', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
      });
      const accountId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(accountId, 'team_manual');
      const [before] = await sql()<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM credit_lots`;

      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits', dry_run: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        dry_run: boolean;
        decisions: Array<{ outcome: string; account_id: string }>;
        summary: { moved: number };
      }>();
      expect(body.dry_run).toBe(true);
      expect(body.decisions).toEqual([
        { outcome: 'move', account_id: `acc_${accountId}`, ai_source: 'credits' },
      ]);
      expect(body.summary.moved).toBe(1);

      const row = await creditAccountRow(accountId);
      expect(row?.billingMode, 'still legacy — the dry run wrote nothing').toBe('legacy');
      const [after] = await sql()<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM credit_lots`;
      expect(after?.n, 'no lot was created by the dry run').toBe(before?.n);
    });

    it('lists a paid account with no paid coverage and no override as refused, kept legacy', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'api_scale' });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits', dry_run: true },
      });
      expect(res.json()).toMatchObject({
        decisions: [
          { outcome: 'refuse', reason: 'no_paid_coverage', account_id: `acc_${accountId}` },
        ],
      });
    });

    it('lists Enterprise without a contract as refused no_contract (M7) — never granted a default figure', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'enterprise' });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits', dry_run: true },
      });
      expect(res.json()).toMatchObject({
        decisions: [{ outcome: 'refuse', reason: 'no_contract', account_id: `acc_${accountId}` }],
      });
    });

    it('Free is not_eligible and never listed as refused', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'free' });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits', dry_run: true },
      });
      expect(res.json()).toMatchObject({
        decisions: [
          { outcome: 'not_eligible', reason: 'free_plan', account_id: `acc_${accountId}` },
        ],
      });
    });

    it('a Phase-2 cohort is refused by the route with a clear 400, not silently accepted', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { cohort: 'C3', to: 'credits', dry_run: true },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/Phase 2|C3/);
    });

    it('CRITICAL a cutover request in shadow mode is refused with a clear error, and writes nothing', async () => {
      fx = await buildTestApp({
        aiCredits: { ...h().aiCredits, mode: 'shadow' },
        scopes: [...ADMIN_SCOPES],
      });
      const accountId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(accountId, 'team_manual');
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      expect(res.statusCode).toBe(409);
      const row = await creditAccountRow(accountId);
      expect(row?.billingMode ?? 'legacy').toBe('legacy');
    });
  });

  describe('runCutover', () => {
    it('CRITICAL moves an account and grants the CURRENT window in full before its next task — no bridge lot, no proration', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
      });
      const accountId = await seedAccount(fx, { tier: 'team_manual', consent: false });
      await givePaidCoverage(accountId, 'team_manual');

      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        dry_run: false,
        summary: { moved: 1, already_moved: 0, not_eligible: 0, refused: 0 },
      });

      const row = await creditAccountRow(accountId);
      expect(row?.billingMode).toBe('credits');
      // team_manual's plan-wide allowance is 5,000 credits (AI_PLAN_ENTITLEMENTS) —
      // granted IN FULL, matching the plan's own line ("the current window is
      // granted in full, and there are no bridge lots"), not prorated to the
      // days remaining in the paid period.
      expect(await monthlyLotGrantedMicro(accountId)).toBe(5_000 * MICRO);
    });

    it('CRITICAL running the cutover twice moves each account once — the second run reports already_moved and grants nothing new', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'api_starter' });
      await givePaidCoverage(accountId, 'api_starter');
      const selector = { account_ids: [`acc_${accountId}`], to: 'credits' as const };

      const first = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: selector,
      });
      expect(first.json<{ summary: { moved: number } }>().summary.moved).toBe(1);
      const grantedAfterFirst = await monthlyLotGrantedMicro(accountId);

      const second = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: selector,
      });
      expect(second.json()).toMatchObject({
        summary: { moved: 0, already_moved: 1, not_eligible: 0, refused: 0 },
      });
      expect(await monthlyLotGrantedMicro(accountId), 'no second lot was granted').toBe(
        grantedAfterFirst,
      );
      const [lotCount] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM credit_lots WHERE account_id = ${accountId}::uuid AND kind = 'monthly'`;
      expect(lotCount?.n, 'exactly one monthly lot exists, not one per cutover call').toBe('1');
    });

    it('CRITICAL is resumable: an error after N accounts leaves those N moved and the rest legacy, and a second call finishes the rest — never re-snapshotting or re-granting the N', async () => {
      const a1 = await (async () => {
        fx = fx ?? (await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] }));
        return fx;
      })();
      const accountIds = [
        await seedAccount(a1, {
          tier: 'api_starter',
          email: `resume-1-${randomUUID()}@example.test`,
        }),
        await seedAccount(a1, {
          tier: 'api_starter',
          email: `resume-2-${randomUUID()}@example.test`,
        }),
        await seedAccount(a1, {
          tier: 'api_starter',
          email: `resume-3-${randomUUID()}@example.test`,
        }),
      ];
      for (const id of accountIds) await givePaidCoverage(id, 'api_starter');

      // A throwaway service over the SAME real repos, whose refreshCreditsIn
      // throws on the third account — simulating a crash mid-list.
      let calls = 0;
      const faulty = new CreditCutoverService({
        ledger: h().base.ledger,
        cutoverRepo: h().cutoverRepo,
        creditGrants: {
          refreshCreditsIn: (tx: CreditLedgerTx, accountId: string) => {
            calls += 1;
            if (calls > 2) throw new Error('simulated crash mid-cutover');
            return h().grants.refreshCreditsIn(tx, accountId);
          },
        },
        pool: h().base.database.db,
        internalEmails: h().internalEmails,
      });

      await expect(
        faulty.runCutover({ kind: 'account_ids', accountIds }, AUDIT_AS_STAFF),
      ).rejects.toThrow('simulated crash mid-cutover');

      const rows = await Promise.all(accountIds.map((id) => creditAccountRow(id)));
      expect(rows[0]?.billingMode, 'account 1 committed before the crash').toBe('credits');
      expect(rows[1]?.billingMode, 'account 2 committed before the crash').toBe('credits');
      expect(rows[2]?.billingMode ?? 'legacy', 'account 3 was never committed').toBe('legacy');
      const grantedBeforeResume = await monthlyLotGrantedMicro(accountIds[0] as string);

      // A fresh call over the same selector, with the real (non-throwing)
      // service, finishes the rest.
      const decisions = await h().cutover.runCutover(
        { kind: 'account_ids', accountIds },
        AUDIT_AS_STAFF,
      );
      expect(decisions.map((d) => d.outcome)).toEqual(['already_moved', 'already_moved', 'move']);
      const audited = await Promise.all(
        accountIds.map((id) => adminAuditRowsFor(sql(), { targetAccountId: id })),
      );
      expect(
        audited.map((rows) => rows.length),
        'each account audited exactly once, inside its own move — the two committed before the crash included',
      ).toEqual([1, 1, 1]);
      const rowsAfter = await Promise.all(accountIds.map((id) => creditAccountRow(id)));
      expect(rowsAfter.every((r) => r?.billingMode === 'credits')).toBe(true);
      expect(
        await monthlyLotGrantedMicro(accountIds[0] as string),
        'the already-moved accounts were never re-granted',
      ).toBe(grantedBeforeResume);
    });

    it('the §8.5 key-and-consent mapping, through the real database: stored key + consent off → own_key; stored key + consent → automatic; no key → credits', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const ownKeyId = await seedAccount(fx, {
        tier: 'api_builder',
        consent: false,
        hasKey: true,
      });
      const automaticId = await seedAccount(fx, {
        tier: 'api_builder',
        consent: true,
        hasKey: true,
      });
      const creditsId = await seedAccount(fx, {
        tier: 'api_builder',
        consent: true,
        hasKey: false,
      });
      for (const id of [ownKeyId, automaticId, creditsId])
        await givePaidCoverage(id, 'api_builder');

      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {
          account_ids: [`acc_${ownKeyId}`, `acc_${automaticId}`, `acc_${creditsId}`],
          to: 'credits',
        },
      });
      const byAccount = new Map(
        res
          .json<{ decisions: Array<{ account_id: string; ai_source: string | null }> }>()
          .decisions.map((d) => [d.account_id, d.ai_source]),
      );
      expect(byAccount.get(`acc_${ownKeyId}`)).toBe('own_key');
      expect(byAccount.get(`acc_${automaticId}`)).toBe(null);
      expect(byAccount.get(`acc_${creditsId}`)).toBe('credits');
    });

    it('CRITICAL a moved account keeps its key-only choice after the key expires — ai_source stays own_key, and the per-turn resolver refuses rather than falling back to credits', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, {
        tier: 'api_builder',
        consent: false,
        hasKey: true,
        keySetAt: "now() - interval '200 days'",
      });
      await givePaidCoverage(accountId, 'api_builder');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });

      const row = await creditAccountRow(accountId);
      expect(row?.aiSource, 'the cutover chose own_key (a stored key, consent off)').toBe(
        'own_key',
      );

      // The key was stored 200 days ago — well past the 90-day TTL
      // (BYOK_ANTHROPIC_KEY_TTL_MS) — so it is no longer usable. Feeding the
      // PERSISTED ai_source into the real per-turn resolver proves the choice
      // itself never changed and never silently falls back.
      const decision = decideAiSource({
        entitlement: aiEntitlementFor('api_builder'),
        aiSource: row?.aiSource === 'own_key' ? 'own_key' : null,
        headerKeyPresent: false,
        storedKeyUsable: false,
      });
      expect(decision).toEqual({ outcome: 'refuse', kind: 'own_key_missing' });
    });

    it('C0 moves every internal account not already moved, and none outside it', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const internalEmail = `internal-${randomUUID()}@driftstack.test`;
      const internalId = await seedAccount(fx, { tier: 'team_manual', email: internalEmail });
      const outsideId = await seedAccount(fx, { tier: 'team_manual', internal: false });
      await givePaidCoverage(internalId, 'team_manual');
      await givePaidCoverage(outsideId, 'team_manual');

      const scopedCutover = new CreditCutoverService({
        ledger: h().base.ledger,
        cutoverRepo: h().cutoverRepo,
        creditGrants: h().grants,
        pool: h().base.database.db,
        internalEmails: new Set([internalEmail]),
      });
      const decisions = await scopedCutover.runCutover(
        { kind: 'cohort', cohort: 'C0' },
        AUDIT_AS_STAFF,
      );
      expect(decisions.map((d) => d.accountId)).toContain(internalId);
      expect(decisions.map((d) => d.accountId)).not.toContain(outsideId);
      expect((await creditAccountRow(internalId))?.billingMode).toBe('credits');
      expect((await creditAccountRow(outsideId))?.billingMode ?? 'legacy').toBe('legacy');
    });

    it('CRITICAL every move leaves an audit row with the actor and the chosen source', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(accountId, 'team_manual');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      const rows = await adminAuditRowsFor(sql(), { targetAccountId: accountId });
      expect(rows.map((r) => r.action)).toEqual(['credits.cutover_moved']);
      expect(rows[0]?.admin_account_id).toBe(DEFAULT_STAFF_IDENTITY.accountId);
      expect(rows[0]?.input_payload).toMatchObject({ ai_source: 'credits' });

      // Idempotency: a repeat cutover writes no second audit row.
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      expect(
        (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).map((r) => r.action),
      ).toEqual(['credits.cutover_moved']);
    });
  });

  describe('rollback', () => {
    it('CRITICAL restores the old limit with this month’s spend intact — proved through the S13 bundled-llm-status route for the MOVED view, and directly against accounts/usage_records for the restored LEGACY view (buildTestApp’s bundled-llm-settings double is in-memory and never reads the accounts row a real deployment’s DrizzleBundledLlmRepo would — see credit-cutover-repo.ts’s restoreLegacySettings, which writes that exact row)', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, {
        tier: 'team_manual',
        consent: true,
        capCents: 4321,
      });
      await givePaidCoverage(accountId, 'team_manual');
      // This month's legacy bundled-LLM spend — untouched by the cutover OR
      // the rollback, because neither touches usage_records.
      await sql()`
        INSERT INTO usage_records (account_id, record_type, quantity, metadata)
        VALUES (${accountId}::uuid, 'agent_decomposer_bundled', 1, ${sql().json({ cost_usd_cents: 777 })})`;

      const owner = await seedAdditionalAccount(fx, {
        accountId,
        tier: 'team_manual',
        scopes: ['read'],
      });
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      const moved = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/me/bundled-llm-status',
        headers: { authorization: `Bearer ${owner.plaintext}` },
      });
      // The MOVED view IS backed by the real database (`aiCredits.accounts`/
      // `.windows`), so this is a genuine round-trip through the route: a
      // different cap now (the window's credits level), not the legacy 4321.
      expect(moved.json(), 'moved — the credits view, a different cap').not.toMatchObject({
        cap_cents: 4321,
      });

      const rollback = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${accountId}` },
      });
      expect(rollback.statusCode).toBe(200);
      expect(rollback.json()).toMatchObject({
        outcome: 'rolled_back',
        restored: { consent: true, monthly_cap_usd_cents: 4321 },
      });

      // The restored LEGACY row itself — exactly what a real deployment's
      // `GET .../bundled-llm-status` reads once `resolveMovedAccount` again
      // returns null (billing_mode back to 'legacy').
      expect(await legacySettingsRow(accountId)).toEqual({ consent: true, cap: 4321 });
      const [spend] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM usage_records
         WHERE account_id = ${accountId}::uuid AND record_type = 'agent_decomposer_bundled'`;
      expect(spend?.n, 'this month’s legacy spend row was never touched').toBe('1');
      expect(
        (await adminAuditRowsFor(sql(), { targetAccountId: accountId })).map((r) => r.action),
      ).toEqual(['credits.cutover_moved', 'credits.cutover_rolled_back']);
    });

    it('touches no ledger row, lot or window — a rollback is a credit_accounts + accounts write only', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(accountId, 'team_manual');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      const [ledgerBefore] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM credit_ledger WHERE account_id = ${accountId}::uuid`;
      const [lotsBefore] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;

      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${accountId}` },
      });

      const [ledgerAfter] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM credit_ledger WHERE account_id = ${accountId}::uuid`;
      const [lotsAfter] = await sql()<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM credit_lots WHERE account_id = ${accountId}::uuid`;
      expect(ledgerAfter?.n).toBe(ledgerBefore?.n);
      expect(lotsAfter?.n).toBe(lotsBefore?.n);
      const row = await creditAccountRow(accountId);
      expect(row?.billingMode).toBe('legacy');
      expect(row?.aiSource).toBeNull();
    });

    it('a legacy account rolls back to not_moved and writes nothing', async () => {
      fx = await buildTestApp({
        aiCredits: h().aiCredits,
        scopes: [...ADMIN_SCOPES],
      });
      const accountId = await seedAccount(fx, {
        tier: 'team_manual',
        consent: true,
        capCents: 999,
      });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${accountId}` },
      });
      expect(res.json()).toMatchObject({ outcome: 'not_moved', restored: null });
      const settings = await legacySettingsRow(accountId);
      expect(settings).toMatchObject({ consent: true, cap: 999 });
    });

    it('dry_run previews the rollback and writes nothing', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, {
        tier: 'team_manual',
        consent: true,
        capCents: 1234,
      });
      await givePaidCoverage(accountId, 'team_manual');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });

      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${accountId}`, dry_run: true },
      });
      expect(res.json()).toMatchObject({
        dry_run: true,
        outcome: 'would_roll_back',
        restored: { consent: true, monthly_cap_usd_cents: 1234 },
      });
      const row = await creditAccountRow(accountId);
      expect(row?.billingMode, 'the dry run wrote nothing — still on credits').toBe('credits');
    });

    it('CRITICAL every rollback leaves an audit row, and a rollback of a legacy account leaves none', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const movedId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(movedId, 'team_manual');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${movedId}`], to: 'credits' },
      });
      const legacyId = await seedAccount(fx, { tier: 'team_manual' });

      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${movedId}` },
      });
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${legacyId}` },
      });

      expect(
        (await adminAuditRowsFor(sql(), { targetAccountId: movedId })).map((r) => r.action),
      ).toEqual(['credits.cutover_moved', 'credits.cutover_rolled_back']);
      expect(await adminAuditRowsFor(sql(), { targetAccountId: legacyId })).toEqual([]);
    });

    it('CRITICAL a rollback in shadow mode is refused with a clear error, and writes nothing', async () => {
      fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
      const accountId = await seedAccount(fx, { tier: 'team_manual' });
      await givePaidCoverage(accountId, 'team_manual');
      await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/cutover',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
      });
      await fx.cleanup();

      fx = await buildTestApp({
        aiCredits: { ...h().aiCredits, mode: 'shadow' },
        scopes: [...ADMIN_SCOPES],
      });
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/admin/ai-credits/rollback',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { account_id: `acc_${accountId}` },
      });
      expect(res.statusCode).toBe(409);
      const row = await creditAccountRow(accountId);
      expect(row?.billingMode, 'still on credits — the shadow-mode refusal wrote nothing').toBe(
        'credits',
      );
    });
  });
});
