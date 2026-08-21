// V-1226 — one contract for web-session authority, against BOTH implementations of `AuthFlowsRepo`.
//
// The sixteenth of the twenty-nine, and the one on the hot auth path: `findActiveWebSession` is
// what turns a session cookie into an authenticated request. Three separate things can stop it, and
// only two of them look like stopping it.
//
//   Drizzle  INNER JOIN accounts ON accounts.id = web_sessions.account_id
//                              AND accounts.auth_epoch = web_sessions.auth_epoch
//            WHERE token_hash = $1 AND expires_at > $now AND revoked_at IS NULL
//
//   double   token match, revoked_at null, expires_at > now,
//            and account.authEpoch !== row.authEpoch -> skip
//
// EXPIRY AND REVOCATION ARE THE OBVIOUS TWO. V-1193 found an expired web session authenticating,
// which is why they are pinned here rather than assumed.
//
// THE AUTH EPOCH IS THE THIRD, AND IT IS INVISIBLE. `setPassword` bumps `accounts.auth_epoch`, and
// every session carrying the old epoch stops matching the join — without any of them being revoked,
// and with `revoked_at` still NULL on every row. That is how a password change signs out every
// other device. An implementation that checked only expiry and revocation would keep authenticating
// every session issued before the password change, which is the exact scenario a customer performs
// a password reset FOR: they believe someone else has their session.
//
// So the epoch arm asserts BOTH halves — the session stops resolving AND `revoked_at` is still null
// — because "the session no longer authenticates" is equally satisfied by an implementation that
// revokes everything, and that implementation would be a different (also defensible) design whose
// behaviour differs everywhere else revocation is observable.
//
// A NOTE ON THE OTHER DOUBLE, recorded because it is a live trap rather than a defect.
// `InMemoryAuthRepo` exposes its own `findActiveWebSession` fallback which checks expiry and
// revocation and knows nothing about auth epochs. It is unreachable today: `buildTestApp` wires
// `setWebSessionFinder` so every fixture delegates here, and its local seeding seam
// (`upsertWebSession`) has zero callers. But a future test that seeds through that seam gets a
// session which survives a password change, and nothing would say so. Left in place rather than
// deleted — it is another agent's helper and the removal is theirs to make — and documented at the
// seam so the next person to reach for it sees the limitation first.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AuthFlowsRepo } from '../../src/services/auth-flows.js';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 3_600_000);
const PAST = new Date(NOW.getTime() - 1_000);

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM web_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM web_sessions WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: AuthFlowsRepo;
  account: () => Promise<{ id: string; authEpoch: number }>;
}

async function makeAccount(repo: AuthFlowsRepo): Promise<{ id: string; authEpoch: number }> {
  const row = await repo.createAccount({
    email: `websess-${randomUUID()}@test.local`,
    name: null,
    passwordHash: 'hash-initial',
    initialTier: 'free',
  });
  return { id: row.id, authEpoch: row.authEpoch };
}

function inMemorySubject(): Subject {
  const repo = new InMemoryAuthFlowsRepo();
  return { repo, account: () => makeAccount(repo) };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  const repo = new DrizzleAuthFlowsRepo({ client: c, db, close: async () => {} });
  return {
    repo,
    account: async () => {
      const acct = await makeAccount(repo);
      seeded.push(acct.id);
      return acct;
    },
  };
}

async function issueSession(
  s: Subject,
  acct: { id: string; authEpoch: number },
  expiresAt: Date,
): Promise<{ id: string; hash: string }> {
  const hash = `sess-${randomUUID()}`;
  const row = await s.repo.insertWebSession({
    accountId: acct.id,
    tokenHash: hash,
    authEpoch: acct.authEpoch,
    expiresAt,
    issuedFromIp: null,
    userAgent: null,
  });
  // insertWebSession returns `WebSessionRow | null` — null when the account is not insertable.
  // vitest accepted `row.id` because esbuild strips types without checking them; strict tsc did not.
  if (row === null) throw new Error('web-session fixture did not insert a row');
  return { id: row.id, hash };
}

function webSessionContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`AuthFlowsRepo web-session authority contract — ${label}`, () => {
    it('CRITICAL a live session resolves, in both. Without this the three refusal arms below are satisfied by an implementation that authenticates nobody, which fails closed but is still broken.', async () => {
      if (!enabled()) return;
      const s = make();
      const acct = await s.account();
      const sess = await issueSession(s, acct, FUTURE);

      const found = await s.repo.findActiveWebSession({ tokenHash: sess.hash, now: NOW });
      expect(found?.id, 'a live session did not authenticate').toBe(sess.id);
    });

    it('CRITICAL an EXPIRED session does not resolve, in both. V-1193 found exactly this authenticating, which is why it is pinned rather than assumed.', async () => {
      if (!enabled()) return;
      const s = make();
      const acct = await s.account();
      const sess = await issueSession(s, acct, PAST);

      expect(
        await s.repo.findActiveWebSession({ tokenHash: sess.hash, now: NOW }),
        'an expired session authenticated',
      ).toBeNull();
    });

    it('CRITICAL a REVOKED session does not resolve, in both. Revocation is what "sign out this device" writes, so a session surviving it stays usable by whoever the customer was signing out.', async () => {
      if (!enabled()) return;
      const s = make();
      const acct = await s.account();
      const sess = await issueSession(s, acct, FUTURE);
      await s.repo.revokeWebSession(sess.id, NOW);

      expect(
        await s.repo.findActiveWebSession({ tokenHash: sess.hash, now: NOW }),
        'a revoked session authenticated',
      ).toBeNull();
    });

    it('CRITICAL changing the password invalidates existing sessions through the AUTH EPOCH, without revoking them, in both. This is how a password change signs out every other device, and it is invisible: revoked_at stays NULL on every row, so an implementation checking only expiry and revocation keeps authenticating precisely the sessions a customer resets their password to kill.', async () => {
      if (!enabled()) return;
      const s = make();
      const acct = await s.account();
      const sess = await issueSession(s, acct, FUTURE);
      expect(
        (await s.repo.findActiveWebSession({ tokenHash: sess.hash, now: NOW }))?.id,
        'the session was not live before the password change, so this arm would prove nothing',
      ).toBe(sess.id);

      await s.repo.setPassword(acct.id, 'hash-rotated');

      expect(
        await s.repo.findActiveWebSession({ tokenHash: sess.hash, now: NOW }),
        'a session issued before the password change still authenticates',
      ).toBeNull();

      // Both halves: it stopped resolving AND nothing revoked it. An implementation that revoked
      // every session would satisfy the line above while being a different design.
      const stored = await s.repo.findWebSessionByIdForAccount(sess.id, acct.id);
      expect(
        stored?.revokedAt ?? null,
        'the session was revoked rather than invalidated by the epoch',
      ).toBeNull();
    });
  });
}

webSessionContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AuthFlowsRepo web-session authority contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    webSessionContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
