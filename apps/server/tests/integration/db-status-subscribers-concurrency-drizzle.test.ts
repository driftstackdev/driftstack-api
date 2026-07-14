// Real-Postgres proof for the status-subscriber mailbox-authority boundary.
// Pending re-subscriptions must preserve the current subscription state, and
// token-driven transitions must compare-and-swap the exact presented hash so
// pooled API processes cannot both claim one credential.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleStatusSubscribersRepo } from '../../src/db/status-subscribers-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seededEmails: string[] = [];

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
    await client`SELECT 1 FROM status_subscribers LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const email of seededEmails) {
    await client`DELETE FROM status_subscribers WHERE email = ${email}`.catch(() => {});
  }
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'status-subscriber authority transitions (Drizzle path, real Postgres)',
  () => {
    it('preserves active state during pending re-subscribe and lets exactly one confirm win', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleStatusSubscribersRepo({ client, db, close: async () => {} });
      const email = `status-cas-${randomUUID()}@test.local`;
      seededEmails.push(email);
      const firstHash = `confirm-first-${randomUUID()}`;
      const firstUnsubscribeHash = `unsubscribe-first-${randomUUID()}`;
      const confirmedAt = new Date();

      const pending = await repo.upsertPending({
        email,
        confirmTokenHash: firstHash,
        confirmExpiresAt: new Date(confirmedAt.getTime() + 60_000),
      });
      const firstConfirmation = await repo.markConfirmed({
        id: pending.id,
        expectedConfirmTokenHash: firstHash,
        confirmedAt,
        unsubscribeTokenHash: firstUnsubscribeHash,
      });
      expect(firstConfirmation).not.toBeNull();

      const secondHash = `confirm-second-${randomUUID()}`;
      const refreshed = await repo.upsertPending({
        email,
        confirmTokenHash: secondHash,
        confirmExpiresAt: new Date(confirmedAt.getTime() + 120_000),
      });
      expect(refreshed.confirmedAt?.getTime()).toBe(confirmedAt.getTime());
      expect(refreshed.unsubscribedAt).toBeNull();
      expect(refreshed.unsubscribeTokenHash).toBe(firstUnsubscribeHash);
      expect((await repo.listConfirmed()).some((row) => row.id === pending.id)).toBe(true);

      const results = await Promise.all([
        repo.markConfirmed({
          id: pending.id,
          expectedConfirmTokenHash: secondHash,
          confirmedAt: new Date(confirmedAt.getTime() + 1),
          unsubscribeTokenHash: `unsubscribe-a-${randomUUID()}`,
        }),
        repo.markConfirmed({
          id: pending.id,
          expectedConfirmTokenHash: secondHash,
          confirmedAt: new Date(confirmedAt.getTime() + 1),
          unsubscribeTokenHash: `unsubscribe-b-${randomUUID()}`,
        }),
      ]);
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      expect(results.filter((row) => row === null)).toHaveLength(1);
    });

    it('rejects a stale confirmation hash and a rotated unsubscribe hash', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleStatusSubscribersRepo({ client, db, close: async () => {} });
      const email = `status-stale-${randomUUID()}@test.local`;
      seededEmails.push(email);
      const staleConfirmHash = `confirm-stale-${randomUUID()}`;
      const currentConfirmHash = `confirm-current-${randomUUID()}`;
      const now = new Date();

      const pending = await repo.upsertPending({
        email,
        confirmTokenHash: staleConfirmHash,
        confirmExpiresAt: new Date(now.getTime() + 60_000),
      });
      await repo.upsertPending({
        email,
        confirmTokenHash: currentConfirmHash,
        confirmExpiresAt: new Date(now.getTime() + 60_000),
      });
      await expect(
        repo.markConfirmed({
          id: pending.id,
          expectedConfirmTokenHash: staleConfirmHash,
          confirmedAt: now,
          unsubscribeTokenHash: 'must-not-land',
        }),
      ).resolves.toBeNull();

      const unsubscribeHash = `unsubscribe-current-${randomUUID()}`;
      expect(
        await repo.markConfirmed({
          id: pending.id,
          expectedConfirmTokenHash: currentConfirmHash,
          confirmedAt: now,
          unsubscribeTokenHash: unsubscribeHash,
        }),
      ).not.toBeNull();
      const rotatedHash = `unsubscribe-rotated-${randomUUID()}`;
      await repo.rotateUnsubscribeTokenHash({ id: pending.id, hash: rotatedHash });
      await expect(
        repo.markUnsubscribed({
          id: pending.id,
          expectedUnsubscribeTokenHash: unsubscribeHash,
          unsubscribedAt: now,
        }),
      ).resolves.toBeNull();
      await expect(
        repo.markUnsubscribed({
          id: pending.id,
          expectedUnsubscribeTokenHash: rotatedHash,
          unsubscribedAt: now,
        }),
      ).resolves.not.toBeNull();
    });
  },
);
