// S16 audit fix #10 — a rollback keeps an own-key choice the customer made while
// the account was on credits.
//
// A rollback put back the consent SNAPSHOT the cutover took, whatever the
// customer had chosen since. A customer who, while moved, turned AI credits off
// (`PATCH bundled-llm-settings {consent:false}` → `ai_source = 'own_key'`, set
// by the customer) was rolled back to `bundled_llm_consent = true`: the legacy
// fallback they had just refused was switched back on for them.
//
// Now, when `ai_source_set_by` is the customer, the legacy consent is derived
// from the current `ai_source`: `own_key` → consent false. Since the S13–S16
// re-audit (#4, the mirror of this fix) the other direction holds too: a
// customer who turned the fallback ON while moved (automatic, or credits) rolls
// back with consent true, whatever the snapshot said. A source the cutover set
// keeps the snapshot. The dry run previews exactly what the rollback writes.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { paidLine, subscription } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_rollback';
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

interface Moved {
  readonly f: TestAppFixture;
  readonly accountId: string;
  /** A key on the moved account itself, for the customer's own PATCH. */
  readonly customerKey: string;
}

/** A paying C0 Team account with a stored key, cut over through the route. */
async function movedAccount(opts: { readonly consent: boolean }): Promise<Moved> {
  const tier: AccountTier = 'team_manual';
  fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
  const accountId = randomUUID();
  const email = `rollback-${accountId}@driftstack.test`;
  await sql()`
    INSERT INTO accounts (id, email, tier, bundled_llm_consent, bundled_llm_monthly_cap_usd_cents,
                          byok_anthropic_api_key_ciphertext, byok_anthropic_api_key_set_at)
    VALUES (${accountId}::uuid, ${email}, ${tier}::account_tier, ${opts.consent}, 1500,
            '\\x00'::bytea, now())`;
  h().internalEmails.add(email);
  const subscriptionId = await subscription(sql(), accountId, { tier });
  await paidLine(sql(), accountId, { subscriptionId, tier });
  const customer = await seedAdditionalAccount(fx, {
    accountId,
    apiKeyId: randomUUID(),
    email,
    tier,
    scopes: ['read', 'account_owner'],
  });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/admin/ai-credits/cutover',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { account_ids: [`acc_${accountId}`], to: 'credits' },
  });
  expect(res.json<{ summary: { moved: number } }>().summary.moved, res.body).toBe(1);
  return { f: fx, accountId, customerKey: customer.plaintext };
}

async function customerPatch(m: Moved, consent: boolean): Promise<void> {
  const res = await m.f.app.inject({
    method: 'PATCH',
    url: '/v1/account/me/bundled-llm-settings',
    headers: { authorization: `Bearer ${m.customerKey}` },
    payload: { consent },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function rollback(
  m: Moved,
  dryRun: boolean,
): Promise<{ outcome: string; restored: { consent: boolean; monthly_cap_usd_cents: number } }> {
  const res = await m.f.app.inject({
    method: 'POST',
    url: '/v1/admin/ai-credits/rollback',
    headers: { authorization: `Bearer ${m.f.plaintext}` },
    payload: { account_id: `acc_${m.accountId}`, dry_run: dryRun },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function legacy(accountId: string): Promise<{ consent: boolean; cap: number }> {
  const [row] = await sql()<Array<{ consent: boolean; cap: number }>>`
    SELECT bundled_llm_consent AS consent, bundled_llm_monthly_cap_usd_cents AS cap
      FROM accounts WHERE id = ${accountId}::uuid`;
  if (row === undefined) throw new Error('no account row');
  return row;
}

async function source(
  accountId: string,
): Promise<{ aiSource: string | null; setBy: string | null }> {
  const [row] = await sql()<Array<{ s: string | null; b: string | null }>>`
    SELECT ai_source AS s, ai_source_set_by AS b FROM credit_accounts WHERE account_id = ${accountId}::uuid`;
  return { aiSource: row?.s ?? null, setBy: row?.b ?? null };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a rollback keeps the own-key choice the customer made while moved',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client).not.toBeNull();
      expect(harness).not.toBeNull();
    });

    it('CRITICAL consented before the move, turned credits OFF while moved → rolled back with consent false (dry run and real run agree)', async () => {
      const m = await movedAccount({ consent: true });
      expect(await source(m.accountId), 'the cutover chose automatic').toEqual({
        aiSource: null,
        setBy: 'cutover',
      });
      await customerPatch(m, false);
      expect(await source(m.accountId)).toEqual({ aiSource: 'own_key', setBy: 'customer' });

      const preview = await rollback(m, true);
      expect(preview).toMatchObject({
        outcome: 'would_roll_back',
        restored: { consent: false, monthly_cap_usd_cents: 1500 },
      });
      const done = await rollback(m, false);
      expect(done).toMatchObject({
        outcome: 'rolled_back',
        restored: { consent: false, monthly_cap_usd_cents: 1500 },
      });
      expect(await legacy(m.accountId)).toEqual({ consent: false, cap: 1500 });
    });

    it('CONTROL — a customer who changed nothing while moved gets the snapshot back exactly', async () => {
      const m = await movedAccount({ consent: true });
      const done = await rollback(m, false);
      expect(done.restored.consent).toBe(true);
      expect(await legacy(m.accountId)).toEqual({ consent: true, cap: 1500 });
    });

    it('CRITICAL a customer who turned credits ON while moved rolls back with consent TRUE, over a false snapshot (S13–S16 re-audit #4, the mirror of #10)', async () => {
      const m = await movedAccount({ consent: false });
      expect(await source(m.accountId), 'a stored key, consent off → own_key').toEqual({
        aiSource: 'own_key',
        setBy: 'cutover',
      });
      await customerPatch(m, true);
      expect(await source(m.accountId)).toEqual({ aiSource: null, setBy: 'customer' });
      const done = await rollback(m, false);
      expect(done.restored.consent).toBe(true);
      expect(await legacy(m.accountId)).toEqual({ consent: true, cap: 1500 });
    });
  },
);
