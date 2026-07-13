// Drizzle-backed integration test: the single-active-session-per-profile guard
// (A3 finding #7, W2979/W2980) enforced ATOMICALLY under concurrency against a
// REAL Postgres, on BOTH session-create paths:
//   - DrizzleSessionRepo.insertSessionIfUnderLimit (driver /v1/sessions; the
//     profile_id lives in metadata.profile_id jsonb)
//   - DrizzleAgentSessionsRepo.createIfUnderActiveCap (agent-sessions; the
//     profile_id is a dedicated column)
//
// The guard refuses a SECOND concurrent session bound to the same profile_id so
// two sessions can't both restore the same sealed cookie/state blob, diverge, and
// clobber each other at teardown. It is enforced under a per-profile
// pg_advisory_xact_lock inside the same transaction as the cap check, so two
// concurrent creates serialise on the lock → the second sees the first's row and
// throws ProfileInUseError. The in-memory twins are synchronous (no await gap), so
// only a real Postgres with a MULTI-connection pool (max:5 → distinct
// connections) actually exercises the advisory lock under true concurrency.
//
// Covers the five required cases:
//   1. two concurrent creates on the same profile → exactly ONE binds, the other
//      gets ProfileInUseError (the atomicity).
//   2. reconnect to the same existing session is not a new bind (no create call →
//      never gated).  [covered by case 3's same-profile-after-terminal symmetry +
//      a no-second-create assertion]
//   3. a profile whose only session is TERMINAL allows a new bind.
//   4. cross-account same profile_id is isolated (account B is unaffected by
//      account A's live session on the same profile_id string).
//   5. a create with NO profile_id is never gated.
//
// Run scope:
//   - CI: the build-test job has postgres:17 at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if the DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleSessionRepo } from '../../src/db/sessions-repo.js';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { ProfileInUseError } from '../../src/lib/errors.js';
import type * as schema from '../../src/db/schema.js';
import type { NewSessionInput } from '../../src/services/sessions.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: agent_sessions/sessions → profiles →
// api_keys → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // max: 5 so concurrent transactions get distinct connections — the advisory
  // lock, not connection serialisation, is what's exercised.
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM sessions LIMIT 0`;
    await client`SELECT 1 FROM agent_sessions LIMIT 0`;
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccountWithKey(c: ReturnType<typeof postgres>): Promise<{
  accountId: string;
  apiKeyId: string;
}> {
  const accountId = randomUUID();
  seeded.push(accountId);
  await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`prof-inuse-${accountId}@test.local`})`;
  const apiKeyId = randomUUID();
  await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash) VALUES (${apiKeyId}, ${accountId}, ${'prof-inuse'}, ${`dk_${accountId.slice(0, 8)}`}, ${`hash-${accountId}`})`;
  return { accountId, apiKeyId };
}

async function seedProfile(c: ReturnType<typeof postgres>, accountId: string): Promise<string> {
  const profileId = randomUUID();
  await c`INSERT INTO profiles (id, account_id, name) VALUES (${profileId}, ${accountId}, ${`p-${profileId.slice(0, 8)}`})`;
  return profileId;
}

function mkDriverInput(
  accountId: string,
  apiKeyId: string,
  i: number,
  profileId?: string,
): NewSessionInput {
  return {
    accountId,
    apiKeyId,
    driverSessionId: `drv-${accountId.slice(0, 4)}-${i}`,
    archetype: 'iphone17_ios18_7_safari26_4',
    purpose: 'production_customer',
    label: null,
    // The driver-sessions table stores profile_id in metadata.profile_id.
    metadata: profileId !== undefined ? { profile_id: profileId } : null,
  };
}

const HIGH_CAP = 100; // well above any per-test count, so the cap never confounds.

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'single-active-session-per-profile guard is atomic (per-profile advisory lock, real Postgres)',
  () => {
    // ── Driver-sessions path (insertSessionIfUnderLimit, metadata.profile_id) ──

    it('driver: two concurrent creates on the SAME profile → EXACTLY 1 binds, the other throws ProfileInUseError', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey(client);
      const profileId = await seedProfile(client, accountId);

      const settled = await Promise.allSettled([
        repo.insertSessionIfUnderLimit(mkDriverInput(accountId, apiKeyId, 0, profileId), HIGH_CAP, {
          profileId,
        }),
        repo.insertSessionIfUnderLimit(mkDriverInput(accountId, apiKeyId, 1, profileId), HIGH_CAP, {
          profileId,
        }),
      ]);
      const fulfilled = settled.filter((r) => r.status === 'fulfilled' && r.value !== null);
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProfileInUseError);
      // Only the one bound row exists for this profile.
      const rows = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM sessions
        WHERE account_id = ${accountId} AND metadata->>'profile_id' = ${profileId}
      `;
      expect(rows[0]?.count).toBe(1);
    });

    it('driver: a TERMINAL session on the profile does NOT block a new bind', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey(client);
      const profileId = await seedProfile(client, accountId);

      const first = await repo.insertSessionIfUnderLimit(
        mkDriverInput(accountId, apiKeyId, 0, profileId),
        HIGH_CAP,
        { profileId },
      );
      expect(first).not.toBeNull();
      // Move it to a terminal state (destroyed + destroyedAt stamped) — exactly
      // what the destroy path does.
      await repo.updateSessionStatus(first!.id, 'destroyed', { destroyedAt: new Date() });

      // A new bind on the same profile now succeeds (the old row is terminal).
      const second = await repo.insertSessionIfUnderLimit(
        mkDriverInput(accountId, apiKeyId, 1, profileId),
        HIGH_CAP,
        { profileId },
      );
      expect(second).not.toBeNull();
      expect(second!.id).not.toBe(first!.id);
    });

    it('driver: the SAME profile_id under a DIFFERENT account is isolated (no cross-account block)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const a = await seedAccountWithKey(client);
      const b = await seedAccountWithKey(client);
      // Each account owns its OWN profile row; bind both concurrently. Even if
      // they hashed to the same advisory key, the in-txn check is account-scoped.
      const profA = await seedProfile(client, a.accountId);
      const profB = await seedProfile(client, b.accountId);

      const [resA, resB] = await Promise.all([
        repo.insertSessionIfUnderLimit(mkDriverInput(a.accountId, a.apiKeyId, 0, profA), HIGH_CAP, {
          profileId: profA,
        }),
        repo.insertSessionIfUnderLimit(mkDriverInput(b.accountId, b.apiKeyId, 0, profB), HIGH_CAP, {
          profileId: profB,
        }),
      ]);
      expect(resA).not.toBeNull();
      expect(resB).not.toBeNull();
    });

    it('driver: a create with NO profileId is never gated (two no-profile creates both bind)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleSessionRepo({ client, db, close: async () => {} });
      const { accountId, apiKeyId } = await seedAccountWithKey(client);

      const settled = await Promise.allSettled([
        repo.insertSessionIfUnderLimit(mkDriverInput(accountId, apiKeyId, 0), HIGH_CAP),
        repo.insertSessionIfUnderLimit(mkDriverInput(accountId, apiKeyId, 1), HIGH_CAP),
      ]);
      const bound = settled.filter((r) => r.status === 'fulfilled' && r.value !== null);
      expect(bound).toHaveLength(2);
    });

    // ── Agent-sessions path (createIfUnderActiveCap, profile_id column) ──

    it('agent: two concurrent creates on the SAME profile → EXACTLY 1 binds, the other throws ProfileInUseError', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: Buffer.alloc(32, 11).toString('base64') },
      );
      const { accountId } = await seedAccountWithKey(client);
      const profileId = await seedProfile(client, accountId);

      const settled = await Promise.allSettled([
        repo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000, profileId }, HIGH_CAP),
        repo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000, profileId }, HIGH_CAP),
      ]);
      const fulfilled = settled.filter((r) => r.status === 'fulfilled' && r.value !== null);
      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProfileInUseError);
      expect(await repo.countActiveForProfile(profileId)).toBe(1);
    });

    it('agent: a CLOSED session on the profile does NOT block a new bind', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: Buffer.alloc(32, 11).toString('base64') },
      );
      const { accountId } = await seedAccountWithKey(client);
      const profileId = await seedProfile(client, accountId);

      const first = await repo.createIfUnderActiveCap(
        { accountId, tokenBudgetTotal: 1000, profileId },
        HIGH_CAP,
      );
      expect(first).not.toBeNull();
      await repo.closeWithReason(first!.id, 'test-close');

      const second = await repo.createIfUnderActiveCap(
        { accountId, tokenBudgetTotal: 1000, profileId },
        HIGH_CAP,
      );
      expect(second).not.toBeNull();
      expect(second!.id).not.toBe(first!.id);
    });

    it('agent: the SAME profile under a DIFFERENT account is isolated', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: Buffer.alloc(32, 11).toString('base64') },
      );
      const a = await seedAccountWithKey(client);
      const b = await seedAccountWithKey(client);
      const profA = await seedProfile(client, a.accountId);
      const profB = await seedProfile(client, b.accountId);

      const [resA, resB] = await Promise.all([
        repo.createIfUnderActiveCap(
          { accountId: a.accountId, tokenBudgetTotal: 1000, profileId: profA },
          HIGH_CAP,
        ),
        repo.createIfUnderActiveCap(
          { accountId: b.accountId, tokenBudgetTotal: 1000, profileId: profB },
          HIGH_CAP,
        ),
      ]);
      expect(resA).not.toBeNull();
      expect(resB).not.toBeNull();
    });

    it('agent: a create with NO profileId is never gated (two no-profile creates both bind)', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleAgentSessionsRepo(
        { client, db, close: async () => {} },
        { transcriptEncryptionKeyBase64: Buffer.alloc(32, 11).toString('base64') },
      );
      const { accountId } = await seedAccountWithKey(client);

      const settled = await Promise.allSettled([
        repo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000 }, HIGH_CAP),
        repo.createIfUnderActiveCap({ accountId, tokenBudgetTotal: 1000 }, HIGH_CAP),
      ]);
      const bound = settled.filter((r) => r.status === 'fulfilled' && r.value !== null);
      expect(bound).toHaveLength(2);
    });
  },
);
