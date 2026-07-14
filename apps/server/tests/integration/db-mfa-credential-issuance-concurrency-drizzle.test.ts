// Real-Postgres proof that MFA plaintext credential issuance has one winner.
// The in-memory repository is synchronous, so it cannot prove that two pooled
// connections obey the per-account transaction lock and persisted revision CAS.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';
import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
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
  client = postgres(DB_URL, { max: 5 });
  try {
    await client`SELECT 1 FROM account_mfa LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const accountId of seeded) {
    await client`DELETE FROM account_mfa_recovery_codes WHERE account_id = ${accountId}`.catch(
      () => {},
    );
    await client`DELETE FROM account_mfa WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'MFA credential issuance concurrency (Drizzle path, real Postgres)',
  () => {
    it('allows exactly one completion and one replacement for each persisted revision', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`mfa-cas-${accountId}@test.local`})`;
      const currentWebSessionId = randomUUID();
      const predecessorWebSessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 60_000);
      await client`
        INSERT INTO web_sessions (id, account_id, token_hash, auth_epoch, expires_at)
        VALUES
          (${currentWebSessionId}, ${accountId}, ${`current-${accountId}`}, 0, ${expiresAt.toISOString()}::timestamptz),
          (${predecessorWebSessionId}, ${accountId}, ${`predecessor-${accountId}`}, 0, ${expiresAt.toISOString()}::timestamptz)
      `;

      const pending = await repo.startEnrollmentIfNotEnrolled({
        accountId,
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        now: new Date(),
      });
      expect(pending).not.toBeNull();

      const firstBatch = Array.from({ length: 10 }, (_, index) => `first-${index}`);
      const rivalBatch = Array.from({ length: 10 }, (_, index) => `rival-${index}`);
      const completionResults = await Promise.all([
        repo.completeEnrollmentIfPending({
          accountId,
          currentWebSessionId,
          expectedUpdatedAt: pending!.updatedAt,
          hashes: firstBatch,
          now: new Date(),
        }),
        repo.completeEnrollmentIfPending({
          accountId,
          currentWebSessionId,
          expectedUpdatedAt: pending!.updatedAt,
          hashes: rivalBatch,
          now: new Date(),
        }),
      ]);
      expect(completionResults.sort()).toEqual([false, true]);

      const enrolled = await repo.findByAccount(accountId);
      expect(enrolled?.enrolledAt).not.toBeNull();
      expect(await repo.listUnusedRecoveryCodes(accountId)).toHaveLength(10);
      const [authority] = await client`
        SELECT auth_epoch FROM accounts WHERE id = ${accountId}
      `;
      expect(authority?.auth_epoch).toBe(1);
      const [currentSession] = await client`
        SELECT auth_epoch, mfa_satisfied_at
        FROM web_sessions
        WHERE id = ${currentWebSessionId}
      `;
      expect(currentSession?.auth_epoch).toBe(1);
      expect(currentSession?.mfa_satisfied_at).not.toBeNull();
      const [predecessorSession] = await client`
        SELECT auth_epoch, mfa_satisfied_at
        FROM web_sessions
        WHERE id = ${predecessorWebSessionId}
      `;
      expect(predecessorSession?.auth_epoch).toBe(0);
      expect(predecessorSession?.mfa_satisfied_at).toBeNull();

      const replacementA = Array.from({ length: 10 }, (_, index) => `replacement-a-${index}`);
      const replacementB = Array.from({ length: 10 }, (_, index) => `replacement-b-${index}`);
      const replacementResults = await Promise.all([
        repo.replaceRecoveryCodesIfCurrent({
          accountId,
          expectedUpdatedAt: enrolled!.updatedAt,
          hashes: replacementA,
          now: new Date(),
        }),
        repo.replaceRecoveryCodesIfCurrent({
          accountId,
          expectedUpdatedAt: enrolled!.updatedAt,
          hashes: replacementB,
          now: new Date(),
        }),
      ]);
      expect(replacementResults.sort()).toEqual([false, true]);
      const unused = await repo.listUnusedRecoveryCodes(accountId);
      expect(unused).toHaveLength(10);
      const hashes = unused.map((row) => row.codeHash);
      expect(
        hashes.every((hash) => replacementA.includes(hash)) ||
          hashes.every((hash) => replacementB.includes(hash)),
      ).toBe(true);
    });

    it('persists a single-use TOTP counter and last-used timestamp through the real adapter', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleMfaRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`mfa-use-${accountId}@test.local`})`;
      const currentWebSessionId = randomUUID();
      await client`
        INSERT INTO web_sessions (id, account_id, token_hash, auth_epoch, expires_at)
        VALUES (${currentWebSessionId}, ${accountId}, ${`current-${accountId}`}, 0, ${new Date(Date.now() + 60_000).toISOString()}::timestamptz)
      `;

      const pending = await repo.startEnrollmentIfNotEnrolled({
        accountId,
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        now: new Date(),
      });
      expect(pending).not.toBeNull();
      expect(
        await repo.completeEnrollmentIfPending({
          accountId,
          currentWebSessionId,
          expectedUpdatedAt: pending!.updatedAt,
          hashes: [],
          now: new Date(),
        }),
      ).toBe(true);

      const counterUsedAt = new Date();
      await expect(
        repo.consumeTotpCounter({ accountId, counter: 123_456, now: counterUsedAt }),
      ).resolves.toBe(true);
      const touchedAt = new Date(counterUsedAt.getTime() + 10);
      await expect(repo.touchLastUsed(accountId, touchedAt)).resolves.toBeUndefined();

      const persisted = await repo.findByAccount(accountId);
      expect(persisted?.lastUsedTotpCounter).toBe(123_456);
      expect(persisted?.lastUsedAt?.getTime()).toBe(touchedAt.getTime());
    });

    it('retires a bearer minted before enrollment and refuses a stale mint after enrollment', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const database = { client, db, close: async () => {} };
      const mfaRepo = new DrizzleMfaRepo(database);
      const authRepo = new DrizzleAuthFlowsRepo(database);
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`mfa-epoch-${accountId}@test.local`})`;

      const currentWebSessionId = randomUUID();
      const currentTokenHash = `current-${accountId}`;
      const staleBeforeTokenHash = `stale-before-${accountId}`;
      const expiresAt = new Date(Date.now() + 60_000);
      await client`
        INSERT INTO web_sessions (id, account_id, token_hash, auth_epoch, expires_at)
        VALUES (${currentWebSessionId}, ${accountId}, ${currentTokenHash}, 0, ${expiresAt.toISOString()}::timestamptz)
      `;
      const staleBefore = await authRepo.insertWebSession({
        accountId,
        tokenHash: staleBeforeTokenHash,
        authEpoch: 0,
        expiresAt,
        issuedFromIp: null,
        userAgent: null,
      });
      expect(staleBefore).not.toBeNull();

      const pending = await mfaRepo.startEnrollmentIfNotEnrolled({
        accountId,
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        now: new Date(),
      });
      expect(pending).not.toBeNull();
      await expect(
        mfaRepo.completeEnrollmentIfPending({
          accountId,
          currentWebSessionId,
          expectedUpdatedAt: pending!.updatedAt,
          hashes: [],
          now: new Date(),
        }),
      ).resolves.toBe(true);

      await expect(
        authRepo.findActiveWebSession({ tokenHash: staleBeforeTokenHash, now: new Date() }),
      ).resolves.toBeNull();
      await expect(
        authRepo.findActiveWebSession({ tokenHash: currentTokenHash, now: new Date() }),
      ).resolves.toMatchObject({
        id: currentWebSessionId,
        authEpoch: 1,
        mfaSatisfiedAt: expect.any(Date),
      });

      await expect(
        authRepo.insertWebSession({
          accountId,
          tokenHash: `stale-after-${accountId}`,
          authEpoch: 0,
          expiresAt,
          issuedFromIp: null,
          userAgent: null,
        }),
      ).resolves.toBeNull();
    });
  },
);
