// Owner item T-13 — "this Get set up keeps coming even if a customer already
// launched a session and then removed it. It should be for first time customers
// only."
//
// The fix makes completion a fact about the ACCOUNT, not one install: the
// desktop client PATCHes /v1/account/me {onboarding_completed:true} the first
// time it sees every step done, and seeds its first-run gate from the account's
// onboarding_completed_at on load. This file pins the server side those two
// calls stand on.
//
// The MECHANISM under test is a write-only-when-NULL latch:
//   • setOnboardingCompleted writes the instant only when the column is NULL, so
//     a second completion never moves the first and a customer who set up long
//     ago keeps their original timestamp;
//   • the route reaches the setter ONLY for the literal `true`, so a false or
//     absent value can neither set nor clear it;
//   • the write is CALLER-scoped (like the identity edits) — a member with the
//     acting-for-owner header marks THEIR OWN account, never the owner's; onboarding
//     is a per-user flag and the header does not redirect it.
//
// Two blocks, because the two failure modes live in two layers. The route block
// (in-memory) proves the PATCH/GET contract and the caller-scoping the effective-
// account resolver adds; the DB-backed block drives the real Drizzle setter
// against Postgres with hand-picked instants, which is the only place the
// "second completion does not move the first" idempotence can be proved without
// racing the wall clock. Each arm names the mutation it alone would catch, and a
// fresh account reading null is the vacuity control that keeps "non-null after a
// PATCH" from meaning nothing.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';

interface MeResponse {
  onboarding_completed_at: string | null;
}

const bearer = (plaintext: string): { authorization: string } => ({
  authorization: `Bearer ${plaintext}`,
});

async function getMe(fx: TestAppFixture, plaintext: string): Promise<MeResponse> {
  const res = await fx.app.inject({
    method: 'GET',
    url: '/v1/account/me',
    headers: bearer(plaintext),
  });
  expect(res.statusCode).toBe(200);
  return res.json<MeResponse>();
}

// ───────────────────────────────────────────────────────────────────────────
// Block 1 — the PATCH/GET contract and caller-scoping (full route, in-memory).
// ───────────────────────────────────────────────────────────────────────────

describe('T-13 onboarding completion is remembered on the account (route)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.useRealTimers();
    if (fx) await fx.cleanup();
  });

  it('a fresh account has never completed onboarding — GET returns null (VACUITY CONTROL)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const me = await getMe(fx, fx.plaintext);
    expect(
      me.onboarding_completed_at,
      'a first-time customer must read null, or "non-null after a PATCH" proves nothing',
    ).toBeNull();
  });

  it('PATCH {onboarding_completed:true} is remembered — GET returns a non-null ISO timestamp', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { onboarding_completed: true },
    });
    expect(res.statusCode).toBe(200);

    const at = (await getMe(fx, fx.plaintext)).onboarding_completed_at;
    expect(at, 'completion was not persisted to the account').not.toBeNull();
    // A real ISO instant, not some truthy placeholder.
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);
    expect(new Date(at as string).toISOString()).toBe(at);
  });

  it('a SECOND completion does NOT move the timestamp (idempotent — never overwrites the first)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // Fake only Date so the two completions land on distinguishable instants; a
    // setter that overwrote unconditionally would move the value to the second.
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = new Date('2026-03-01T10:00:00.000Z');
    vi.setSystemTime(first);
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { onboarding_completed: true },
    });

    vi.setSystemTime(new Date('2026-06-15T12:34:56.000Z'));
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { onboarding_completed: true },
    });

    expect(
      (await getMe(fx, fx.plaintext)).onboarding_completed_at,
      'a later completion overwrote the first — a long-standing customer would look freshly onboarded',
    ).toBe(first.toISOString());
  });

  it('a basics-only PATCH (onboarding_completed ABSENT) never sets onboarding — no-op', async () => {
    // This is the arm that reds if the route sets onboarding on anything but the
    // literal true: a name edit must not mark a first-time customer as done.
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { name: 'Ada' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await getMe(fx, fx.plaintext)).onboarding_completed_at,
      'an unrelated edit set onboarding — the flag must respond only to onboarding_completed:true',
    ).toBeNull();
  });

  it('PATCH {onboarding_completed:false} and PATCH {} never clear an existing completion', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { onboarding_completed: true },
    });
    const before = (await getMe(fx, fx.plaintext)).onboarding_completed_at;
    expect(before).not.toBeNull();

    // false is not the literal-true latch value → rejected, and never a clear.
    const falseRes = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: { onboarding_completed: false },
    });
    expect(falseRes.statusCode).toBe(400);
    // An empty body carries no field to update → rejected, and never a clear.
    const emptyRes = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      headers: bearer(fx.plaintext),
      payload: {},
    });
    expect(emptyRes.statusCode).toBe(400);

    expect(
      (await getMe(fx, fx.plaintext)).onboarding_completed_at,
      'a false/empty PATCH cleared the completion — there is no un-complete path',
    ).toBe(before);
  });

  it("CRITICAL onboarding is CALLER-scoped: a member with the acting-for-owner header marks THEIR OWN account, never the owner's — the header does not redirect a per-user getting-started flag, and this write never reaches another account", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const member = fx.plaintext;
    const owner = await seedAdditionalAccount(fx, { tier: 'api_scale' });
    fx.authRepo.setTeamMemberships(fx.accountId, [
      {
        membershipId: randomUUID(),
        ownerAccountId: owner.accountId,
        role: 'member',
      },
    ]);

    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/account/me',
      // The acting-for-owner header is present, and onboarding must IGNORE it.
      headers: { ...bearer(member), 'x-driftstack-account': `acc_${owner.accountId}` },
      payload: { onboarding_completed: true },
    });
    expect(res.statusCode).toBe(200);

    expect(
      (await getMe(fx, member)).onboarding_completed_at,
      'the caller who completed onboarding marks their own account',
    ).not.toBeNull();
    expect(
      (await getMe(fx, owner.plaintext)).onboarding_completed_at,
      'the owner the member acted for was NOT marked — onboarding never redirects to another account via the header',
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Block 2 — the Drizzle setter against real Postgres. The idempotence latch is
// SQL (`... WHERE onboarding_completed_at IS NULL`), so it only means anything
// against a real round-trip with instants we control.
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

describe('T-13 onboarding completion is remembered on the account (DB-backed)', () => {
  let sql: ReturnType<typeof postgres> | null = null;
  let repo: DrizzleAccountAuthRepo | null = null;
  let dbReachable = false;
  const seeded: string[] = [];

  beforeAll(async () => {
    const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
    try {
      await probe`SELECT 1`;
      await probe.end({ timeout: 1 });
    } catch {
      await probe.end({ timeout: 1 }).catch(() => {});
      return;
    }
    sql = postgres(DB_URL, { max: 2 });
    try {
      // The column this feature adds must exist, or the arms below assert nothing.
      await sql`SELECT onboarding_completed_at FROM accounts LIMIT 0`;
      dbReachable = true;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      sql = null;
      return;
    }
    repo = new DrizzleAccountAuthRepo({ db: drizzle(sql) } as unknown as never);
  });

  afterAll(async () => {
    if (sql && seeded.length > 0) {
      await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
        () => undefined,
      );
    }
    await sql?.end({ timeout: 2 }).catch(() => undefined);
  });

  async function seedAccount(): Promise<string> {
    const id = randomUUID();
    await sql!`
      INSERT INTO accounts (id, email, status)
      VALUES (${id}, ${`onboarding-${id}@test.local`}, 'active')`;
    seeded.push(id);
    return id;
  }

  it('CRITICAL the database was reachable with the onboarding column, so a green here is not "no database"', () => {
    expect(
      dbReachable,
      `no Postgres with accounts.onboarding_completed_at at ${DB_URL} — these arms assert nothing without it`,
    ).toBe(true);
  });

  it('CRITICAL a fresh account reads null (VACUITY CONTROL)', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    expect(await repo.getOnboardingCompletedAt(id)).toBeNull();
  });

  it('CRITICAL setOnboardingCompleted writes the instant, and getOnboardingCompletedAt reads it back', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    const at = new Date('2026-04-10T08:15:30.000Z');
    await repo.setOnboardingCompleted(id, at);
    const read = await repo.getOnboardingCompletedAt(id);
    expect(read).not.toBeNull();
    expect((read as Date).toISOString()).toBe(at.toISOString());
  });

  it('CRITICAL a second completion with a LATER instant does NOT move the first (idempotent, never overwrites)', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    const first = new Date('2026-04-10T08:15:30.000Z');
    const later = new Date('2026-09-01T00:00:00.000Z');
    await repo.setOnboardingCompleted(id, first);
    await repo.setOnboardingCompleted(id, later);
    const read = await repo.getOnboardingCompletedAt(id);
    expect(
      (read as Date).toISOString(),
      'a later completion overwrote the first — the write-only-when-NULL guard was lost',
    ).toBe(first.toISOString());
  });

  it('CRITICAL the write targets exactly the given account — a second account stays null', async () => {
    if (!dbReachable || !repo) return;
    const target = await seedAccount();
    const other = await seedAccount();
    await repo.setOnboardingCompleted(target, new Date('2026-04-10T08:15:30.000Z'));
    expect(await repo.getOnboardingCompletedAt(target)).not.toBeNull();
    expect(
      await repo.getOnboardingCompletedAt(other),
      'marking one account completed also touched another row',
    ).toBeNull();
  });
});
