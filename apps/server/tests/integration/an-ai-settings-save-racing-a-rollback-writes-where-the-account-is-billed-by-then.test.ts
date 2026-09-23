// S13–S16 re-audit, round 1, findings 5 and 4 — an AI settings save and a
// rollback, on two real connections.
//
// #5. Both settings PATCHes — the old `PATCH /v1/account/me/bundled-llm-settings`
// and the new `PATCH /v1/account/me/ai-settings` — decided "is this account
// moved?" from an UNLOCKED read, and `setAiSource` never looked at
// `billing_mode` under its lock. S16 #11 closed the race in the cutover
// direction only. So a rollback that committed between the read and the write
// left the save writing `ai_source` onto an account that was legacy again —
// a column nothing reads there — and answering 200: the old route told the
// customer `consent: false` while the legacy consent their turns now run on was
// the `true` the rollback had just restored.
//
// Now `setAiSource` re-reads `billing_mode` UNDER the account lock it takes and
// writes nothing on an account that is no longer moved; each route then
// answers as its legacy path would. The old route runs its legacy save (which
// re-decides under the lock the cutover and rollback take first, and writes the
// legacy consent); the new one answers the 409 it gives any account not on
// credits.
//
// #4, end to end. A save that holds the account lock first commits before the
// rollback reads the row, so the rollback sees the customer's choice: a
// customer who turned the credits fallback ON while moved as `own_key` rolls
// back with consent true, not the `false` snapshot.
//
// The interleavings are forced step by step: the save is held just before its
// write (the rollback then commits in between), or held INSIDE its locked
// transaction (the rollback then waits on the lock, which the test observes in
// `pg_stat_activity` before letting the save go).

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountContext } from '../../src/services/auth.js';
import {
  DrizzleCreditLedgerRepo,
  type CreditAccountRecord,
  type CreditLedgerTx,
} from '../../src/db/credit-ledger-repo.js';
import { DrizzleBundledLlmRepo } from '../../src/db/bundled-llm-repo.js';
import { BundledLlmService } from '../../src/services/bundled-llm.js';
import { registerAccountBundledLlmRoutes } from '../../src/routes/account-bundled-llm.js';
import { registerAccountAiRoutes } from '../../src/routes/account-ai.js';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import type { AiSource, AiSourceSetBy } from '@driftstack/api-types';
import { gate, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s1316_round2_race';
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

type SetAiSourceArgs = { readonly aiSource: AiSource | null; readonly setBy: AiSourceSetBy };

/**
 * The real ledger's reads, with `setAiSource` held BEFORE it runs: the route
 * has made its unlocked moved-or-not read, and its write has not started.
 */
function heldBeforeTheWrite(release: Promise<void>): {
  accounts: AiCreditsRuntime['accounts'];
  reached: () => boolean;
} {
  const ledger = h().base.ledger;
  let reached = false;
  return {
    reached: () => reached,
    accounts: {
      ensureAccount: ledger.ensureAccount.bind(ledger),
      spendableMicro: ledger.spendableMicro.bind(ledger),
      otherLiveGrantedMicro: ledger.otherLiveGrantedMicro.bind(ledger),
      chargedInWindowMicro: ledger.chargedInWindowMicro.bind(ledger),
      setAiSource: async (accountId: string, args: SetAiSourceArgs) => {
        reached = true;
        await release;
        return ledger.setAiSource(accountId, args);
      },
    },
  };
}

/**
 * The real ledger, with the write held INSIDE `setAiSource`'s transaction —
 * after `lockAccount` has taken the account's credit row — until `release`.
 */
class HeldInsideTheLock extends DrizzleCreditLedgerRepo {
  inside = false;
  constructor(
    database: ConstructorParameters<typeof DrizzleCreditLedgerRepo>[0],
    private readonly release: Promise<void>,
  ) {
    super(database);
  }
  override async setAiSourceIn(
    tx: CreditLedgerTx,
    accountId: string,
    args: SetAiSourceArgs,
  ): Promise<CreditAccountRecord> {
    this.inside = true;
    await this.release;
    return super.setAiSourceIn(tx, accountId, args);
  }
}

/** Both settings routes on a minimal app acting as `accountId`, over the real repos. */
async function routesFor(
  accountId: string,
  accounts: AiCreditsRuntime['accounts'],
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
  const base = h().aiCredits;
  if (base.stateReads === undefined) throw new Error('the harness wires stateReads');
  const runtime: AiCreditsRuntime = {
    ...base,
    mode: 'enforce',
    accounts,
    stateReads: {
      ...base.stateReads,
      planOverride: h().overrides.get.bind(h().overrides),
      refreshCredits: h().grants.refreshCredits.bind(h().grants),
    },
  };
  registerAccountBundledLlmRoutes(a, {
    service: new BundledLlmService(new DrizzleBundledLlmRepo(h().base.database)),
    aiCredits: runtime,
  });
  registerAccountAiRoutes(a, {
    aiCredits: runtime,
    authRepo: { getAccount: () => Promise.resolve(null) },
  });
  await a.ready();
  app = a;
  return a;
}

/**
 * A Builder account already MOVED, as the cutover leaves one: `ai_source`
 * chosen by the cutover, and the legacy snapshot the rollback restores.
 */
async function movedAccount(opts: {
  readonly aiSource: AiSource | null;
  readonly snapshotConsent: boolean;
}): Promise<string> {
  const id = randomUUID();
  await sql()`
    INSERT INTO accounts (id, email, tier, bundled_llm_consent, bundled_llm_monthly_cap_usd_cents)
    VALUES (${id}::uuid, ${`race-${id}@driftstack.test`}, 'api_builder', ${opts.snapshotConsent}, 2000)`;
  await sql()`
    INSERT INTO credit_accounts
      (account_id, billing_mode, ai_source, ai_source_set_by, ai_source_set_at,
       legacy_consent_at_move, legacy_cap_cents_at_move, had_stored_key_at_move, moved_to_credits_at)
    VALUES (${id}::uuid, 'credits', ${opts.aiSource}, 'cutover', now(),
            ${opts.snapshotConsent}, 2000, true, now())`;
  return id;
}

async function rows(accountId: string): Promise<{
  billingMode: string;
  aiSource: string | null;
  aiSourceSetBy: string | null;
  legacyConsent: boolean;
  legacyCap: number;
}> {
  const [row] = await sql()<
    Array<{ m: string; s: string | null; b: string | null; c: boolean; cap: number }>
  >`
    SELECT ca.billing_mode AS m, ca.ai_source AS s, ca.ai_source_set_by AS b,
           a.bundled_llm_consent AS c, a.bundled_llm_monthly_cap_usd_cents AS cap
      FROM credit_accounts ca JOIN accounts a ON a.id = ca.account_id
     WHERE ca.account_id = ${accountId}::uuid`;
  if (row === undefined) throw new Error('no account row');
  return {
    billingMode: row.m,
    aiSource: row.s,
    aiSourceSetBy: row.b,
    legacyConsent: row.c,
    legacyCap: row.cap,
  };
}

async function until(what: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(done(), what).toBe(true);
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

function rollback(
  accountId: string,
): ReturnType<AdminCreditsHarness['cutover']['rollbackAccount']> {
  return h().cutover.rollbackAccount(accountId, { onRolledBack: () => Promise.resolve() });
}

describe.skipIf(!RUN_DB_TESTS)(
  'an AI settings save racing a rollback writes where the account is billed by then',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    describe('#5 — a rollback that commits between the save’s read and its write', () => {
      it('CRITICAL the old route: consent:false lands in the legacy consent the account now runs on, and the answer is the legacy one — never a 200 “off” over a legacy consent left on', async () => {
        const accountId = await movedAccount({ aiSource: 'credits', snapshotConsent: true });
        const release = gate();
        const held = heldBeforeTheWrite(release.opened);
        const route = await routesFor(accountId, held.accounts);

        // 1. The save reads "moved" with no lock, decides to write own_key, and is held.
        const saving = route.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          payload: { consent: false },
        });
        await until('the save made its unlocked read and reached its write', held.reached);

        // 2. The rollback runs to its commit: legacy again, consent true restored.
        expect((await rollback(accountId)).outcome).toBe('rolled_back');
        expect((await rows(accountId)).legacyConsent, 'test setup: restored consent').toBe(true);

        // 3. The save goes on.
        release.open();
        const res = await saving;
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json(), 'the legacy answer: the legacy cap, consent off').toEqual({
          consent: false,
          monthly_cap_usd_cents: 2000,
        });
        expect(await rows(accountId)).toEqual({
          billingMode: 'legacy',
          aiSource: null,
          aiSourceSetBy: null,
          legacyConsent: false,
          legacyCap: 2000,
        });
      });

      it('CRITICAL the new route: the save is answered as any legacy account is (409) and writes no ai_source onto the rolled-back account', async () => {
        const accountId = await movedAccount({ aiSource: 'credits', snapshotConsent: true });
        const release = gate();
        const held = heldBeforeTheWrite(release.opened);
        const route = await routesFor(accountId, held.accounts);

        const saving = route.inject({
          method: 'PATCH',
          url: '/v1/account/me/ai-settings',
          payload: { ai_source: 'own_key' },
        });
        await until('the save made its unlocked read and reached its write', held.reached);
        expect((await rollback(accountId)).outcome).toBe('rolled_back');
        release.open();

        const res = await saving;
        // The minimal app has no problem-details handler, so the 409's
        // `credits_not_active` extension is not serialized here; its sentence is.
        expect(res.statusCode, res.body).toBe(409);
        expect(res.body).toContain("AI credits aren't active on this account yet.");
        expect(await rows(accountId)).toEqual({
          billingMode: 'legacy',
          aiSource: null,
          aiSourceSetBy: null,
          legacyConsent: true,
          legacyCap: 2000,
        });
      });

      it('CONTROL — with no rollback in between, the same saves write ai_source and answer as a moved account', async () => {
        const oldRouteAccount = await movedAccount({ aiSource: 'credits', snapshotConsent: true });
        const opened = gate();
        opened.open();
        const oldRoute = await routesFor(
          oldRouteAccount,
          heldBeforeTheWrite(opened.opened).accounts,
        );
        const res = await oldRoute.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          payload: { consent: false },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<{ consent: boolean }>().consent).toBe(false);
        expect(await rows(oldRouteAccount)).toMatchObject({
          billingMode: 'credits',
          aiSource: 'own_key',
          aiSourceSetBy: 'customer',
          legacyConsent: true,
        });
        await oldRoute.close();
        app = null;

        const newRouteAccount = await movedAccount({ aiSource: 'credits', snapshotConsent: true });
        const newRoute = await routesFor(
          newRouteAccount,
          heldBeforeTheWrite(opened.opened).accounts,
        );
        const res2 = await newRoute.inject({
          method: 'PATCH',
          url: '/v1/account/me/ai-settings',
          payload: { ai_source: 'own_key' },
        });
        expect(res2.statusCode, res2.body).toBe(200);
        expect(await rows(newRouteAccount)).toMatchObject({
          billingMode: 'credits',
          aiSource: 'own_key',
          aiSourceSetBy: 'customer',
        });
      });
    });

    describe('#5 + #4 — a save that holds the account lock first commits before the rollback reads', () => {
      it('CRITICAL a customer who turns the credits fallback ON while moved as own_key rolls back with consent TRUE: the rollback waited for the save and read the customer’s choice', async () => {
        const accountId = await movedAccount({ aiSource: 'own_key', snapshotConsent: false });
        const release = gate();
        const ledger = new HeldInsideTheLock(h().base.database, release.opened);
        const accounts: AiCreditsRuntime['accounts'] = ledger;
        const route = await routesFor(accountId, accounts);

        // 1. The save takes the account lock, re-reads it moved, and is held before writing.
        const saving = route.inject({
          method: 'PATCH',
          url: '/v1/account/me/bundled-llm-settings',
          payload: { consent: true },
        });
        await until('the save is inside its locked transaction', () => ledger.inside);

        // 2. The rollback starts and must wait on the save's lock.
        const rollingBack = rollback(accountId);
        await untilSomeoneWaitsOnALock();

        // 3. The save commits; only then does the rollback read the row.
        release.open();
        const [res, back] = await Promise.all([saving, rollingBack]);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json<{ consent: boolean }>().consent).toBe(true);
        expect(back).toMatchObject({ outcome: 'rolled_back', restored: { consent: true } });
        expect(await rows(accountId)).toMatchObject({
          billingMode: 'legacy',
          legacyConsent: true,
        });
      });

      it('the mirror (S16 #10): a customer who chooses their own key while moved, under the same interleaving, rolls back with consent false', async () => {
        const accountId = await movedAccount({ aiSource: 'credits', snapshotConsent: true });
        const release = gate();
        const ledger = new HeldInsideTheLock(h().base.database, release.opened);
        const route = await routesFor(accountId, ledger);

        const saving = route.inject({
          method: 'PATCH',
          url: '/v1/account/me/ai-settings',
          payload: { ai_source: 'own_key' },
        });
        await until('the save is inside its locked transaction', () => ledger.inside);
        const rollingBack = rollback(accountId);
        await untilSomeoneWaitsOnALock();
        release.open();

        const [res, back] = await Promise.all([saving, rollingBack]);
        expect(res.statusCode, res.body).toBe(200);
        expect(back).toMatchObject({ outcome: 'rolled_back', restored: { consent: false } });
        expect(await rows(accountId)).toMatchObject({
          billingMode: 'legacy',
          legacyConsent: false,
        });
      });
    });
  },
);
