// `DrizzleWebhooksRepo.findEndpointsNeedingForceRotation` against real Postgres.
//
// This query decides WHOSE webhook signing secret the server rotates out from
// under them. `WebhookSecretForceRotationService` is built and not yet wired
// (readiness item 2), and the recommendation attached to it says to decide the
// policy first because turning it on breaks any integration that ignores the
// grace window. That makes the selection query the highest-consequence piece of
// the whole subsystem, and it is the piece a policy decision cannot fix: if the
// predicates are wrong, the day someone wires the tick every endpoint rotates at
// once regardless of what the policy says.
//
// It had NO behavioural coverage. Every test naming it uses an in-memory fake
// that returns `[]`, plus a content-parity pin over the source text. Measured by
// mutation at full unit scope: widening the age threshold until every endpoint
// is due, and dropping the already-force-rotated exclusion so endpoints re-rotate
// on every tick, each left all 22,428 tests green.
//
// Its sibling `findEndpointsNeedingRotationReminder` has a thorough file
// (`db-webhook-rotation-reminder-repo-drizzle.test.ts`) covering both directions
// of every predicate. This mirrors that discipline for the destructive twin —
// the reminder only sends an email; this one changes the secret.
//
// Run scope: CI always (postgres:17, migrated). Local dev skips unless a
// reachable DATABASE_URL is set.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleWebhooksRepo } from '../../src/db/webhooks-repo.js';
import { encryptWebhookSecret } from '../../src/lib/webhook-secret-encryption.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const WEBHOOK_KEY = Buffer.alloc(32, 29).toString('base64');

// Deliberately historical, the same isolation device the reminder file uses: the
// query is GLOBAL and decrypts every row it selects, so a foreign endpoint with a
// legacy secret would throw before any assertion ran. Rows seeded by other files
// default `secret_created_at` to the real now() and fall outside a cutoff in the
// year 2000.
const NOW = new Date('2001-01-01T00:00:00.000Z');
const THRESHOLD_DAYS = 91; // cutoff 2000-10-02

const OLD_SECRET = new Date('1999-01-01T00:00:00.000Z'); // well past the threshold
const OLDER_SECRET = new Date('1998-01-01T00:00:00.000Z');
const FRESH_SECRET = new Date('2000-12-15T00:00:00.000Z'); // comfortably inside it

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleWebhooksRepo | null = null;
let accountId: string | null = null;
const seededEndpoints: string[] = [];
const seededAccounts: string[] = [];

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`whforce-${id.slice(0, 8)}@example.test`}, ${'Webhook Force Rotation Fixture'},
            'free'::account_tier, 'active'::account_status, now(), now())`;
  seededAccounts.push(id);
  return id;
}

async function seedEndpoint(opts: {
  secretCreatedAt: Date;
  forceRotatedAt?: Date | null;
  disabledAt?: Date | null;
}): Promise<string> {
  if (!client || accountId === null) throw new Error('no client');
  const endpointId = randomUUID();
  const secret = encryptWebhookSecret(`whsec_${'a'.repeat(32)}`, WEBHOOK_KEY, {
    accountId,
    endpointId,
  });
  await client`
    INSERT INTO webhook_endpoints
      (id, account_id, url, secret, secret_prefix, secret_created_at,
       force_rotated_at, disabled_at, events, created_at, updated_at)
    VALUES
      (${endpointId}, ${accountId}, ${'https://hooks.example/force'}, ${secret},
       ${'whsec_aaaaaa'},
       ${opts.secretCreatedAt.toISOString()}::timestamptz,
       ${opts.forceRotatedAt?.toISOString() ?? null}::timestamptz,
       ${opts.disabledAt?.toISOString() ?? null}::timestamptz,
       ARRAY['session.completed']::webhook_event_type[], now(), now())`;
  seededEndpoints.push(endpointId);
  return endpointId;
}

async function dueIds(limit = 500): Promise<string[]> {
  if (!repo) throw new Error('no repo');
  const rows = await repo.findEndpointsNeedingForceRotation({
    now: NOW,
    thresholdDays: THRESHOLD_DAYS,
    limit,
  });
  return rows.map((r) => r.id);
}

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
  try {
    await client`SELECT 1 FROM webhook_endpoints LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleWebhooksRepo(
    { client, db: drizzle(client, { schema }), close: async () => {} },
    { secretEncryptionKeyBase64: WEBHOOK_KEY },
  );
  accountId = await seedAccount();
});

afterAll(async () => {
  if (client) {
    for (const id of seededEndpoints) {
      await client`DELETE FROM webhook_endpoints WHERE id = ${id}`.catch(() => {});
    }
    for (const id of seededAccounts) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'findEndpointsNeedingForceRotation (real Postgres) — who the server rotates out from under',
  () => {
    it('CRITICAL the database is reachable and migrated, so the arms below cannot pass vacuously', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
      expect(accountId, 'fixture account seeded').not.toBeNull();
    });

    it('CRITICAL an aged secret IS selected, and nothing this file did not seed comes with it. Every exclusion arm below would also pass against a query returning nothing, so this is what keeps them honest.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const ids = await dueIds();
      expect(ids, 'an aged, never-force-rotated, enabled endpoint is due').toContain(id);
      expect(
        ids.every((seen) => seededEndpoints.includes(seen)),
        'the historical cutoff keeps every other file’s rows out of this result',
      ).toBe(true);
    });

    it('CRITICAL a secret INSIDE the threshold is not selected. Without the age gate the first tick would force-rotate every endpoint in the table at once, which is exactly the outcome the unwired service is waiting on a policy decision to avoid.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({ secretCreatedAt: FRESH_SECRET });
      expect(await dueIds(), 'a fresh secret is not due for forced rotation').not.toContain(id);
    });

    it('CRITICAL an endpoint already force-rotated is never selected again. Without this the sweep re-rotates the same endpoint every tick, opening a new grace window and re-mailing the customer each time, and the secret they are mid-way through deploying moves again underneath them.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({
        secretCreatedAt: OLDER_SECRET,
        forceRotatedAt: new Date('2000-12-01T00:00:00.000Z'),
      });
      expect(await dueIds(), 'a prior force rotation excludes the endpoint').not.toContain(id);
    });

    it('CRITICAL a disabled endpoint is never selected, however old its secret. A disabled row is a tombstone the customer has already withdrawn; rotating its secret does no good and the notification is noise about an endpoint they retired.', async () => {
      if (!dbReachable || !repo) return;
      const id = await seedEndpoint({
        secretCreatedAt: OLDER_SECRET,
        disabledAt: new Date('2000-11-01T00:00:00.000Z'),
      });
      expect(await dueIds(), 'disabled excludes regardless of age').not.toContain(id);
    });

    it('CRITICAL the due set is ordered oldest-secret-first and the limit is honoured. The sweep takes only `limit` rows, so ordering decides who is dropped when more endpoints are due than one tick can carry — and a leaked limit would rotate the entire backlog in a single pass.', async () => {
      if (!dbReachable || !repo) return;
      const older = await seedEndpoint({ secretCreatedAt: OLDER_SECRET });
      const old = await seedEndpoint({ secretCreatedAt: OLD_SECRET });
      const ordered = await dueIds();
      expect(ordered.indexOf(older), 'the older secret comes first').toBeLessThan(
        ordered.indexOf(old),
      );

      // V-1350 — `findEndpointsNeedingForceRotation` scans the WHOLE table: it
      // takes no account filter, so every other suite writing webhook_endpoints
      // shares this result set. Read twice in a row and a concurrent cleanup can
      // empty it in between, which is how this arm failed twice under a full run
      // while passing alone — reported as "limit 1 returns exactly one row:
      // expected [] to have a length of 1", a message that reads like a leaked
      // limit and is actually interference.
      //
      // Retry until a reading is uncontaminated, i.e. until BOTH seeds are still
      // due. Then the limited query is compared against a set known to hold at
      // least two rows, which is the only state in which "limit 1 returns one"
      // means what it says.
      let limited: string[] | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const full = await dueIds();
        if (!full.includes(older) || !full.includes(old)) continue;
        const one = await dueIds(1);
        // Re-read the full set: if the seeds survived on both sides of the
        // limited read, nothing removed them mid-measurement.
        const after = await dueIds();
        if (!after.includes(older) || !after.includes(old)) continue;
        limited = one;
        break;
      }
      expect(
        limited,
        'five readings in a row were disturbed by a concurrent writer — the limit was never measured',
      ).not.toBeNull();
      expect(limited, 'limit 1 returns exactly one row').toHaveLength(1);
    });
  },
);
