// One webhook endpoint whose stored secret will not decrypt must not stop the
// cross-account sweeps for everybody else.
//
// `findEndpointsNeedingRotationReminder`, `findEndpointsNeedingForceRotation`
// and `findEndpointsNeedingGraceExpiringNotice` are timer-driven sweeps over
// EVERY account. Each decrypted every candidate row inline inside a single
// `rows.map(...)`, so one row it could not decrypt — a secret left under a
// rotated key, a partially-migrated row, a corrupt ciphertext — threw out of
// the whole batch. The blast radius was total: no account got its reminder, its
// force rotation, or its grace notice, and the failure was an opaque
// "Unsupported state or unable to authenticate data" from node's GCM decipher.
//
// How it surfaced: `db-webhook-rotation-reminder-repo-drizzle` and
// `db-webhooks-force-rotation-selection-drizzle` pass alone and failed 11 of 19
// when run together, because they seed rows under DIFFERENT keys into the same
// database. The force-rotation file's own header had already named the hazard —
// "the query is GLOBAL and decrypts every row it selects, so a foreign endpoint
// with a legacy secret would throw before any assertion ran" — and worked around
// it in the TEST with year-2000 timestamps. The production blast radius was
// never addressed.
//
// The fix skips the row and REPORTS it (`onUndecryptableSecret`), because a
// silent skip is the other way to lose a reminder.
//
// The distinction that matters, and the one this file pins: a MISSING KEY is a
// deployment fault affecting every row and must stay loud. The first version of
// the fix resolved the key inside the try, so a keyless repo returned `[]`
// instead of rejecting — turning a hard configuration failure into a silently
// empty sweep. The reminder file's "REFUSES rather than returning ciphertext"
// arm caught it. The key is now resolved OUTSIDE the try.
//
// Run scope: CI always (postgres:17, migrated). Local dev skips unless a
// reachable DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import * as schema from '../../src/db/schema.js';
import { DrizzleWebhookRotationReminderRepo } from '../../src/db/webhook-rotation-reminder-repo.js';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
let DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
// ⛔ Historical seed dates are NOT isolation once a second file adopts them. This
// file seeds 2001-01-01 / 2003-01-01 and calls three GLOBAL sweeps over `webhook_endpoints`, and it
// shares literal dates with the other adopters in that table — so on a shared
// database each file's rows enter the others' result sets. It is green today only
// because its arms assert MEMBERSHIP (`toContain`) under `limit: 500`: a foreign
// row is invisible until it pushes a row this file cares about past the limit.
// Adding an ordering assertion, or lowering the limit, would convert that silence
// into the failure `db-webhooks-force-rotation-selection` actually hit. A dedicated
// database removes the shared state instead of negotiating with it — one distinct
// name per file, per the helper's own caveat.
const ISOLATED_DB_NAME = 'driftstack_iso_webhook_sweeps_undecryptable';

/** The key the repos are built with. */
const GOOD_KEY = Buffer.alloc(32, 41).toString('base64');
/** A different key — a row written under this one cannot be read with GOOD_KEY. */
const FOREIGN_KEY = Buffer.alloc(32, 42).toString('base64');

// Same historical-window device the sibling files use, so rows seeded by other
// test files (real `now()`) fall outside the cutoff and only this file's two
// endpoints are selected.
const NOW = new Date('2003-01-01T00:00:00.000Z');
const THRESHOLD_DAYS = 91;
const OLD_SECRET = new Date('2001-01-01T00:00:00.000Z');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let accountId: string | null = null;
const seededEndpoints: string[] = [];
const seededAccounts: string[] = [];
const skipped: Array<{ endpointId: string; accountId: string }> = [];

// Deliberately un-annotated: an explicit return type erases drizzle's schema
// generic and the repos then reject the handle.
function handles() {
  if (!client) throw new Error('no client');
  return { client, db: drizzle(client, { schema }), close: async () => {} };
}

const repoOptions = {
  secretEncryptionKeyBase64: GOOD_KEY,
  onUndecryptableSecret: ({
    endpointId,
    accountId: acc,
  }: {
    endpointId: string;
    accountId: string;
  }) => {
    skipped.push({ endpointId, accountId: acc });
  },
};

async function seedEndpoint(key: string): Promise<string> {
  if (!client || accountId === null) throw new Error('no client');
  const endpointId = randomUUID();
  const secret = encryptWebhookSecret(`whsec_${'a'.repeat(32)}`, key, { accountId, endpointId });
  await client`
    INSERT INTO webhook_endpoints
      (id, account_id, url, secret, secret_prefix, secret_created_at,
       force_rotated_at, disabled_at, events, created_at, updated_at)
    VALUES
      (${endpointId}, ${accountId}, ${'https://hooks.example/undecryptable'}, ${secret},
       ${'whsec_aaaaaa'}, ${OLD_SECRET.toISOString()}::timestamptz,
       ${null}::timestamptz, ${null}::timestamptz,
       ARRAY['session.completed']::webhook_event_type[], now(), now())`;
  seededEndpoints.push(endpointId);
  return endpointId;
}

let goodEndpointId = '';
let poisonEndpointId = '';

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
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
  try {
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  accountId = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${accountId}, ${`whskip-${accountId.slice(0, 8)}@example.test`},
            ${'Webhook Undecryptable Fixture'}, 'free'::account_tier,
            'active'::account_status, now(), now())`;
  seededAccounts.push(accountId);

  goodEndpointId = await seedEndpoint(GOOD_KEY);
  poisonEndpointId = await seedEndpoint(FOREIGN_KEY);
});

afterAll(async () => {
  if (client) {
    for (const id of seededEndpoints) {
      await client`DELETE FROM webhook_endpoints WHERE id = ${id}`.catch(() => {});
    }
    for (const id of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 1 }).catch(() => {});
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a cross-account webhook sweep survives one undecryptable row',
  () => {
    it('CRITICAL the database is reachable, so nothing below can pass vacuously', () => {
      expect(dbReachable, 'postgres unreachable or unmigrated — the arms below never ran').toBe(
        true,
      );
      expect(poisonEndpointId, 'the poison row was not seeded').not.toBe('');
    });

    it('CRITICAL findEndpointsNeedingRotationReminder returns the readable row and skips the poison one', async () => {
      if (!dbReachable) return;
      skipped.length = 0;
      const repo = new DrizzleWebhookRotationReminderRepo(handles(), repoOptions);
      const rows = await repo.findEndpointsNeedingRotationReminder({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        cooldownDays: 1,
        limit: 500,
      });
      const ids = rows.map((r) => r.id);
      expect(ids, 'the readable endpoint still gets its reminder').toContain(goodEndpointId);
      expect(
        ids,
        'the undecryptable endpoint is skipped, not returned as ciphertext',
      ).not.toContain(poisonEndpointId);
      expect(
        skipped.map((s) => s.endpointId),
        'the skip must be reported — a silent skip is the other way to lose a reminder',
      ).toContain(poisonEndpointId);
    });

    it('CRITICAL findEndpointsNeedingForceRotation survives the same row', async () => {
      if (!dbReachable) return;
      skipped.length = 0;
      const repo = new DrizzleWebhooksRepo(handles(), repoOptions);
      const rows = await repo.findEndpointsNeedingForceRotation({
        now: NOW,
        thresholdDays: THRESHOLD_DAYS,
        limit: 500,
      });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(goodEndpointId);
      expect(ids).not.toContain(poisonEndpointId);
      expect(skipped.map((s) => s.endpointId)).toContain(poisonEndpointId);
    });

    it('CRITICAL a MISSING key still refuses loudly rather than sweeping empty', async () => {
      if (!dbReachable) return;
      // The distinction the first version of the fix got wrong. A key that is
      // absent is a deployment fault for every row; it must not be absorbed by
      // the per-row skip and reported as "nothing to do".
      const keyless = new DrizzleWebhookRotationReminderRepo(handles(), {});
      await expect(
        keyless.findEndpointsNeedingRotationReminder({
          now: NOW,
          thresholdDays: THRESHOLD_DAYS,
          cooldownDays: 1,
          limit: 500,
        }),
        'a keyless repo must reject, not return []',
      ).rejects.toThrow(/encryption key/i);
    });
  },
);
