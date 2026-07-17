import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfileSnapshotsRepo } from '../../src/db/profile-snapshots-repo.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import {
  mintWrappedProfileDek,
  PROFILE_DEK_V2_PREFIX,
  unwrapProfileDek,
} from '../../src/lib/profile-key-hierarchy.js';
import { ProfileSnapshotsService } from '../../src/services/profile-snapshots.js';
import { ProfilesService } from '../../src/services/profiles.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const MASTER_KEY = Buffer.alloc(32, 37);
const TEST_SCHEMA = `profile_snapshot_restore_dek_${randomUUID().replaceAll('-', '')}`;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

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

  client = postgres(DB_URL, { max: 1 });
  await client.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  await client.unsafe(`
    CREATE TABLE "${TEST_SCHEMA}".accounts (
      id uuid PRIMARY KEY
    );

    CREATE TABLE "${TEST_SCHEMA}".profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES "${TEST_SCHEMA}".accounts(id) ON DELETE CASCADE,
      name text NOT NULL,
      archetype text NOT NULL,
      description text,
      folder text,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      icon text,
      note text,
      last_used_at timestamptz,
      size_bytes bigint,
      last_saved_at timestamptz,
      wrapped_dek text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE UNIQUE INDEX profiles_account_name_unique
      ON "${TEST_SCHEMA}".profiles (account_id, name)
      WHERE deleted_at IS NULL;

    CREATE TABLE "${TEST_SCHEMA}".profile_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES "${TEST_SCHEMA}".accounts(id) ON DELETE CASCADE,
      parent_profile_id uuid REFERENCES "${TEST_SCHEMA}".profiles(id) ON DELETE SET NULL,
      label text NOT NULL,
      description text,
      parent_archetype text NOT NULL,
      parent_name text NOT NULL,
      state_blob jsonb NOT NULL DEFAULT '{}'::jsonb,
      captured_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.unsafe(`SET search_path TO "${TEST_SCHEMA}"`);
});

afterAll(async () => {
  if (!client) return;
  await client.unsafe('SET search_path TO public').catch(() => {});
  await client.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ProfileSnapshotsService.restore profile-bound DEK (real PostgreSQL)',
  () => {
    it('atomically stores a fresh v2 wrapper bound to the returned account+profile identity', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG snapshot-restore DEK test: database unreachable in CI — vacuous pass is forbidden',
          );
        }
        return;
      }

      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const profilesRepo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const snapshotsRepo = new DrizzleProfileSnapshotsRepo({
        client,
        db,
        close: async () => {},
      });
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      const sourceProfileId = randomUUID();
      const sourceIdentity = mintWrappedProfileDek(MASTER_KEY, accountId, sourceProfileId);
      await client`INSERT INTO accounts (id) VALUES (${accountId})`;
      await client`
        INSERT INTO profiles (id, account_id, name, archetype, description, wrapped_dek)
        VALUES (
          ${sourceProfileId},
          ${accountId},
          'snapshot-source',
          'iphone16pro_ios18_7_safari26_4',
          'source description is not captured',
          ${sourceIdentity.wrappedDek}
        )
      `;
      const snapshot = await snapshotsRepo.insert({
        accountId,
        parentProfileId: sourceProfileId,
        label: 'metadata checkpoint',
        description: 'snapshot description',
        parentArchetype: 'iphone16pro_ios18_7_safari26_4',
        parentName: 'snapshot-source',
        stateBlob: {},
      });
      const snapshotsService = new ProfileSnapshotsService(
        snapshotsRepo,
        profilesRepo,
        null,
        MASTER_KEY,
      );

      const restored = await snapshotsService.restore({
        accountId,
        snapshotId: snapshot.id,
        tier: 'team_manual',
        name: 'snapshot-restore',
      });

      const [persisted] = await client<
        Array<{ id: string; wrapped_dek: string | null; description: string | null }>
      >`
        SELECT id::text, wrapped_dek, description
        FROM profiles
        WHERE account_id = ${accountId} AND name = 'snapshot-restore'
      `;
      expect(persisted?.id).toBe(restored.id);
      expect(persisted?.description).toBe('snapshot description');
      expect(persisted?.wrapped_dek?.startsWith(PROFILE_DEK_V2_PREFIX)).toBe(true);

      const wrappedDek = persisted?.wrapped_dek ?? '';
      const unwrapped = unwrapProfileDek(MASTER_KEY, accountId, restored.id, wrappedDek);
      expect(unwrapped).toHaveLength(32);
      expect(unwrapped.equals(sourceIdentity.dek)).toBe(false);
      expect(wrappedDek).not.toBe(sourceIdentity.wrappedDek);
      expect(() => unwrapProfileDek(MASTER_KEY, otherAccountId, restored.id, wrappedDek)).toThrow();
      expect(() => unwrapProfileDek(MASTER_KEY, accountId, randomUUID(), wrappedDek)).toThrow();

      const profilesService = new ProfilesService(profilesRepo, null, MASTER_KEY);
      const dispatchDek = await profilesService.getProfileDek({
        accountId,
        profileId: restored.id,
      });
      expect(dispatchDek?.equals(unwrapped)).toBe(true);

      const [count] = await client<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM profiles WHERE account_id = ${accountId}
      `;
      expect(count?.n).toBe(2);
    });
  },
);
