// S15 audit fix #7 — changing a live plan override keeps the account's reset day.
//
// `anchor_at` is the instant an override's months are counted from: the day the
// credits reset. Every `PUT .../ai-plan-override` used to re-anchor at now(),
// so amending a live override (same figure plus an end date, say) moved the
// reset day and the next window became a stub. The S6 tier change already
// carries the anchor forward for exactly this reason. Now the PUT does too:
// a LIVE override keeps its anchor; only a brand-new override (none, or one that
// has ended) anchors at now().

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { newTaskAccount } from './_helpers/credit-reservation-fixtures.js';
import { planOverride } from './_helpers/credit-grant-fixtures.js';
import {
  adminCreditsHarness,
  seedStaffIdentity,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s15s16_fixes_anchor';
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

async function setup(): Promise<{ f: TestAppFixture; accountId: string }> {
  fx = await buildTestApp({ aiCredits: h().aiCredits, scopes: [...ADMIN_SCOPES] });
  const accountId = await newTaskAccount(sql(), 'team_manual');
  fx.authRepo.upsertAccount({
    id: accountId,
    email: `anchor-${randomUUID()}@example.test`,
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
  return { f: fx, accountId };
}

/** The stored anchor as exact text, and how far it sits before the database's now(). */
async function anchorOf(accountId: string): Promise<{ text: string; secondsAgo: number }> {
  const [row] = await sql()<Array<{ text: string; ago: number }>>`
    SELECT anchor_at::text AS text, extract(epoch FROM now() - anchor_at)::float8 AS ago
      FROM credit_plan_overrides WHERE account_id = ${accountId}::uuid`;
  if (row === undefined) throw new Error('no override row');
  return { text: row.text, secondsAgo: row.ago };
}

function put(
  f: TestAppFixture,
  accountId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return f.app.inject({
    method: 'PUT',
    url: `/v1/admin/accounts/acc_${accountId}/ai-plan-override`,
    headers: { authorization: `Bearer ${f.plaintext}` },
    payload,
  });
}

const in60Days = (): string => new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

describe.skipIf(!RUN_DB_TESTS)('an override change keeps the account’s reset day', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client).not.toBeNull();
    expect(harness).not.toBeNull();
  });

  it('CRITICAL amending a LIVE override (same figure, now with an end date) keeps its anchor exactly', async () => {
    const { f, accountId } = await setup();
    await planOverride(sql(), accountId, {
      monthlyCredits: 5000,
      reason: 'contract',
      anchor: "date_trunc('second', now()) - interval '20 days'",
    });
    const before = await anchorOf(accountId);

    const res = await put(f, accountId, {
      monthly_credits: 5000,
      reason: 'contract',
      expires_at: in60Days(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await anchorOf(accountId)).text, 'the reset day did not move').toBe(before.text);
    expect(new Date(res.json<{ anchor_at: string }>().anchor_at).getTime()).toBe(
      new Date(before.text).getTime(),
    );
  });

  it('CRITICAL changing a live override’s figure keeps its anchor too', async () => {
    const { f, accountId } = await setup();
    await planOverride(sql(), accountId, {
      monthlyCredits: 5000,
      reason: 'admin_tier',
      anchor: "date_trunc('second', now()) - interval '9 days'",
    });
    const before = await anchorOf(accountId);
    expect(
      (await put(f, accountId, { monthly_credits: 8000, reason: 'contract' })).statusCode,
    ).toBe(200);
    expect((await anchorOf(accountId)).text).toBe(before.text);
  });

  it('a brand-new override (none before) anchors at now()', async () => {
    const { f, accountId } = await setup();
    expect(
      (await put(f, accountId, { monthly_credits: 5000, reason: 'contract' })).statusCode,
    ).toBe(200);
    expect((await anchorOf(accountId)).secondsAgo).toBeLessThan(60);
  });

  it('an override that has ENDED is replaced as a brand-new one: anchored at now()', async () => {
    const { f, accountId } = await setup();
    await planOverride(sql(), accountId, {
      monthlyCredits: 5000,
      reason: 'contract',
      anchor: "date_trunc('second', now()) - interval '40 days'",
      ends: "now() - interval '1 day'",
    });
    expect(
      (await put(f, accountId, { monthly_credits: 5000, reason: 'contract' })).statusCode,
    ).toBe(200);
    expect((await anchorOf(accountId)).secondsAgo).toBeLessThan(60);
  });
});
