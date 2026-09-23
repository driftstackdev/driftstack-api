// S16 audit fix #11 — the old bundled-LLM PATCH and a cutover cannot interleave.
//
// The legacy `PATCH /v1/account/me/bundled-llm-settings` decided "moved or not"
// from an UNLOCKED read, then wrote the legacy columns. A cutover that locked
// the account between the two made the PATCH's UPDATE wait, and land AFTER the
// move: into `accounts.bundled_llm_consent`, a column a moved account never
// reads, behind a 200 the customer was told meant something — and a later
// rollback's snapshot then overwrote it.
//
// Now the legacy write TAKES THE LOCK THE CUTOVER TAKES FIRST (`accounts`,
// FOR NO KEY UPDATE) and only then reads `billing_mode`. Either it holds the
// lock first and commits before the move (so the cutover's snapshot has it), or
// it waits for the cutover and then sees the account moved, and answers as the
// moved-account route does.
//
// Two real connections, through the real route over the real
// `DrizzleBundledLlmRepo` (the shared test app's bundled-LLM service is in
// memory, so the route is registered here on a minimal Fastify app whose auth
// preHandlers only set the caller). The audit's interleaving, forced step by
// step with two gates:
//   1. the PATCH makes its unlocked "is this account moved?" read — legacy —
//      and is held just after it (its `findSettings`, the next statement);
//   2. the cutover starts, locks the account and is held mid-move (its
//      `refreshCreditsIn`), before it commits;
//   3. the PATCH is released and reaches its write, which must wait for the
//      cutover's lock;
//   4. the cutover is released and commits.
// Before the fix the PATCH's UPDATE then landed in the legacy columns of an
// account that had just moved. Now its write re-reads `billing_mode` under the
// lock and answers as a moved account.

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountContext } from '../../src/services/auth.js';
import type { CreditLedgerTx } from '../../src/db/credit-ledger-repo.js';
import { DrizzleBundledLlmRepo } from '../../src/db/bundled-llm-repo.js';
import { BundledLlmService } from '../../src/services/bundled-llm.js';
import { CreditCutoverService } from '../../src/services/credit-cutover.js';
import { registerAccountBundledLlmRoutes } from '../../src/routes/account-bundled-llm.js';
import { gate, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { paidLine, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp } from './_helpers/build-test-app.js';
import type {
  AiCreditsRuntime,
  CreditAccountRecord,
} from '../../src/services/ai-credits-runtime.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_race';
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

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/**
 * The real repository, except that its FIRST `findSettings` — the read the
 * legacy PATCH makes right after deciding the account is not moved — reports
 * that it has been reached and then waits for `release`.
 */
class HeldAfterTheMovedCheck extends DrizzleBundledLlmRepo {
  reached = false;
  private held = true;
  constructor(
    database: ConstructorParameters<typeof DrizzleBundledLlmRepo>[0],
    private readonly release: Promise<void>,
  ) {
    super(database);
  }
  override async findSettings(
    accountId: string,
  ): ReturnType<DrizzleBundledLlmRepo['findSettings']> {
    if (this.held) {
      this.held = false;
      this.reached = true;
      await this.release;
    }
    return super.findSettings(accountId);
  }
}

/** The real route on a minimal app, acting as `accountId`, in `mode`. */
async function routeFor(
  accountId: string,
  mode: 'enforce' | 'shadow',
  repo: DrizzleBundledLlmRepo = new DrizzleBundledLlmRepo(h().base.database),
): Promise<FastifyInstance> {
  const ctx = {
    account: { id: accountId, tier: 'api_builder', email: `race-${accountId}@driftstack.test` },
    apiKey: { id: randomUUID(), scopes: ['read', 'account_owner'] },
    rateLimitOverrides: {},
    teams: [],
    webSession: null,
  } as unknown as AccountContext;
  const a = Fastify();
  a.decorateRequest('account', null);
  const authenticate = (request: FastifyRequest): Promise<void> => {
    request.account = ctx;
    return Promise.resolve();
  };
  a.decorate('requireAuth', authenticate);
  a.decorate('requireScope', () => authenticate);
  a.decorate('rateLimit', () => () => Promise.resolve());
  registerAccountBundledLlmRoutes(a, {
    service: new BundledLlmService(repo),
    aiCredits: { mode, accounts: h().base.ledger, windows: h().base.windows },
  });
  await a.ready();
  app = a;
  return a;
}

/** A paying legacy Builder account in C0 with consent OFF, and its credit row already present. */
async function legacyAccount(): Promise<string> {
  const id = randomUUID();
  const email = `race-${id}@driftstack.test`;
  await sql()`
    INSERT INTO accounts (id, email, tier, bundled_llm_consent, bundled_llm_monthly_cap_usd_cents)
    VALUES (${id}::uuid, ${email}, 'api_builder', false, 2000)`;
  // Every account an enforce-mode route has looked at already has this row; a
  // missing one would make the PATCH wait on the cutover's own INSERT instead.
  await sql()`INSERT INTO credit_accounts (account_id) VALUES (${id}::uuid)`;
  h().internalEmails.add(email);
  const subscriptionId = await subscription(sql(), id, { tier: 'api_builder' });
  await paidLine(sql(), id, { subscriptionId, tier: 'api_builder' });
  return id;
}

/** Wait until some backend on this database is blocked on a row lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const [row] = await sql()<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no backend ever blocked on a lock');
}

async function legacyColumns(accountId: string): Promise<{ consent: boolean; cap: number }> {
  const [row] = await sql()<Array<{ consent: boolean; cap: number }>>`
    SELECT bundled_llm_consent AS consent, bundled_llm_monthly_cap_usd_cents AS cap
      FROM accounts WHERE id = ${accountId}::uuid`;
  if (row === undefined) throw new Error('no account row');
  return row;
}

async function creditRow(
  accountId: string,
): Promise<{ billingMode: string; snapshotConsent: boolean | null }> {
  const [row] = await sql()<Array<{ m: string; c: boolean | null }>>`
    SELECT billing_mode AS m, legacy_consent_at_move AS c
      FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  if (row === undefined) throw new Error('no credit row');
  return { billingMode: row.m, snapshotConsent: row.c };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a legacy AI settings save cannot land after the cutover that moved the account',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    it('CRITICAL a PATCH that read "not moved" just before a cutover took the account waits for the cutover, then sees the account moved: the legacy consent column is never written, and the move’s snapshot is the value before the PATCH', async () => {
      const accountId = await legacyAccount();
      const patchHeld = gate();
      const repo = new HeldAfterTheMovedCheck(h().base.database, patchHeld.opened);
      const route = await routeFor(accountId, 'enforce', repo);

      // 1. The PATCH reads "legacy" with no lock, and is held right after.
      const patching = route.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        payload: { consent: true },
      });
      for (let i = 0; i < 500 && !repo.reached; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(repo.reached, 'the PATCH made its moved-or-not read and is held after it').toBe(true);

      // 2. The cutover locks the account and is held mid-move.
      const cutoverHeld = gate();
      let cutoverInside = false;
      const cutover = new CreditCutoverService({
        ledger: h().base.ledger,
        windows: h().base.windows,
        cutoverRepo: h().cutoverRepo,
        creditGrants: {
          refreshCreditsIn: async (tx: CreditLedgerTx, id: string) => {
            cutoverInside = true;
            await cutoverHeld.opened;
            return h().grants.refreshCreditsIn(tx, id);
          },
        },
        pool: h().base.database.db,
        internalEmails: h().internalEmails,
      });
      const moving = cutover.runCutover(
        { kind: 'account_ids', accountIds: [accountId] },
        { onMoved: () => Promise.resolve() },
      );
      for (let i = 0; i < 500 && !cutoverInside; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(cutoverInside, 'the cutover is inside its transaction, holding the account').toBe(
        true,
      );

      // 3. The PATCH goes on to its write, which must wait for the cutover.
      patchHeld.open();
      await untilSomeoneWaitsOnALock();

      // 4. The cutover commits.
      cutoverHeld.open();

      const [decisions, res] = await Promise.all([moving, patching]);
      expect(decisions.map((d) => d.outcome)).toEqual(['move']);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json(), 'answered as a moved account: credits are on').toMatchObject({
        consent: true,
      });

      expect(await creditRow(accountId)).toEqual({
        billingMode: 'credits',
        snapshotConsent: false,
      });
      expect(
        await legacyColumns(accountId),
        'the PATCH did not land in the legacy columns after the move',
      ).toEqual({ consent: false, cap: 2000 });
    });

    it('CONTROL — a PATCH that commits before the cutover is in the cutover’s snapshot', async () => {
      const accountId = await legacyAccount();
      const route = await routeFor(accountId, 'enforce');
      const res = await route.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        payload: { consent: true },
      });
      expect(res.json()).toEqual({ consent: true, monthly_cap_usd_cents: 2000 });
      const decisions = await h().cutover.runCutover(
        { kind: 'account_ids', accountIds: [accountId] },
        { onMoved: () => Promise.resolve() },
      );
      expect(decisions.map((d) => d.outcome)).toEqual(['move']);
      expect(await creditRow(accountId)).toEqual({ billingMode: 'credits', snapshotConsent: true });
    });

    it('CONTROL — in shadow mode a credits-billed account is still legacy to this route (rollback-everyone), so the PATCH writes the legacy columns', async () => {
      const accountId = await legacyAccount();
      await sql()`
      UPDATE credit_accounts
         SET billing_mode = 'credits', legacy_consent_at_move = false,
             legacy_cap_cents_at_move = 2000, had_stored_key_at_move = false,
             moved_to_credits_at = now()
       WHERE account_id = ${accountId}::uuid`;
      const route = await routeFor(accountId, 'shadow');
      const res = await route.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        payload: { consent: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await legacyColumns(accountId)).toEqual({ consent: true, cap: 2000 });
    });
  },
);

describe('the route answers as a moved account when its locked write finds one (no database)', () => {
  it('CRITICAL an unlocked read of "legacy", then a write that finds the account moved: the legacy row is untouched and the moved-account answer is returned', async () => {
    const unreachable = (): Promise<never> => Promise.reject(new Error('no AI turn here'));
    let reads = 0;
    const record = (billingMode: 'legacy' | 'credits'): Omit<CreditAccountRecord, 'accountId'> => ({
      billingMode,
      aiSource: billingMode === 'credits' ? 'credits' : null,
      aiSourceSetBy: billingMode === 'credits' ? 'cutover' : null,
      aiSourceSetAt: null,
      debtMicro: 0,
      autoTopUpEnabled: false,
      legacyConsentAtMove: billingMode === 'credits' ? false : null,
      legacyCapCentsAtMove: billingMode === 'credits' ? 2000 : null,
      hadStoredKeyAtMove: billingMode === 'credits' ? false : null,
      movedToCreditsAt: null,
      movedBackAt: null,
    });
    const setAiSourceCalls: unknown[] = [];
    const runtime: AiCreditsRuntime = {
      mode: 'enforce',
      bootId: 'boot-race-double',
      reservations: {
        reserve: unreachable,
        settle: unreachable,
        planCall: unreachable,
        admitCall: unreachable,
        markSent: unreachable,
        settleCall: unreachable,
      },
      leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
      report: { shadowReport: unreachable, census: unreachable },
      accounts: {
        // The first read is the route's unlocked one, before the cutover
        // commits; every later read sees the move.
        ensureAccount: (accountId: string) => {
          reads += 1;
          return Promise.resolve({ ...record(reads === 1 ? 'legacy' : 'credits'), accountId });
        },
        setAiSource: (accountId: string, args: unknown) => {
          setAiSourceCalls.push(args);
          return Promise.resolve({ ...record('credits'), accountId });
        },
        spendableMicro: () => Promise.resolve(3_000_000_000),
        otherLiveGrantedMicro: () => Promise.resolve(0),
        chargedInWindowMicro: () => Promise.resolve(0),
      },
      windows: {
        currentWindow: () =>
          Promise.resolve({
            id: 'w1',
            windowStart: '2026-09-01T00:00:00.000000Z',
            windowEnd: '2026-10-01T00:00:00.000000Z',
            levelMicro: 3_000_000_000,
          }),
      },
    };
    const fx = await buildTestApp({
      tier: 'api_builder',
      aiCredits: runtime,
      enableBundledLlm: { consent: false, monthlyCapUsdCents: 2_000 },
    });
    try {
      fx.bundledLlmRepo.markMoved(fx.accountId);
      const res = await fx.app.inject({
        method: 'PATCH',
        url: '/v1/account/me/bundled-llm-settings',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { consent: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json(), 'the moved-account answer: credits on, the window’s cap').toEqual({
        consent: true,
        monthly_cap_usd_cents: 3_000,
      });
      expect(await fx.bundledLlmRepo.findSettings(fx.accountId), 'legacy row untouched').toEqual({
        consent: false,
        monthlyCapUsdCents: 2_000,
      });
      expect(setAiSourceCalls, "consent:true on 'credits' changes no source").toEqual([]);
      expect(reads, 'the route re-read the account after the write refused').toBeGreaterThanOrEqual(
        2,
      );
    } finally {
      await fx.cleanup();
    }
  });
});
