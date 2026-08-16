// V-759 — privacy-policy §9 retention enforcement, against a REAL Postgres.
//
// This is the test that matters for this change, because the change is irreversible. Two
// guards the design (docs/internal/2026-08-12-retention-anonymisation-design.md) demanded
// beyond the usual sweeper template:
//
//   1. NOTHING INSIDE THE 90-DAY WINDOW IS TOUCHED. Over-scrubbing is the whole risk and it
//      cannot be undone.
//   2. `usage_records` SURVIVE a session scrub. This is the specific catastrophe the design
//      exists to avoid: `usage_records.session_id` CASCADES from `sessions`, and §9 requires
//      billing data be kept 7 years (Dutch tax law, AWR Art 52), so a sweep that DELETED
//      sessions would destroy statutorily-retained records to satisfy a 90-day promise.
//
// Guard 2 is only meaningful if the cascade actually exists in the test schema. Postgres'
// `CREATE TABLE ... (LIKE x INCLUDING ALL)` copies constraints but NOT foreign keys, so the
// FK is re-added by hand below. Without that, a future change to DELETE-instead-of-scrub
// would leave usage_records intact here and the guard would pass while the real database
// lost billing data.
//
// Run scope:
//   - CI: postgres service present; runs.
//   - Local: set DATABASE_URL to run; skipped otherwise.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleRetentionScrubRepo,
  RETENTION_SCRUB_SENTINEL,
} from '../../src/db/retention-scrub-repo.js';
import { RetentionScrubSweeperService } from '../../src/services/retention-scrub-sweeper.js';
import type { Database } from '../../src/db/client.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const TEST_SCHEMA = `retention_scrub_${randomUUID().replaceAll('-', '')}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let dbReachable = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-12T00:00:00.000Z');
/** Comfortably outside the 90-day window. */
const LONG_AGO = new Date(NOW.getTime() - 200 * DAY_MS);
/** Comfortably INSIDE it — must survive untouched. */
const RECENT = new Date(NOW.getTime() - 10 * DAY_MS);
/** Seeded into `sessions.metadata`; the in-window row must still hold exactly this. */
const SEEDED_METADATA = { note: 'customer metadata' };

beforeAll(async () => {
  admin = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await admin`SELECT 1`;
    dbReachable = true;
  } catch {
    await admin.end({ timeout: 1 }).catch(() => {});
    admin = null;
    return;
  }
  await admin.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  for (const table of ['accounts', 'api_keys', 'sessions', 'session_operations', 'usage_records']) {
    await admin.unsafe(
      `CREATE TABLE "${TEST_SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }
  // LIKE does not copy foreign keys. Re-add the two that make this test's guards real:
  // the cascade that would destroy billing data if sessions were deleted, and the
  // session_operations cascade.
  await admin.unsafe(`
    ALTER TABLE "${TEST_SCHEMA}"."usage_records"
      ADD CONSTRAINT usage_records_session_fk FOREIGN KEY (session_id)
      REFERENCES "${TEST_SCHEMA}"."sessions"(id) ON DELETE CASCADE;
    ALTER TABLE "${TEST_SCHEMA}"."session_operations"
      ADD CONSTRAINT session_operations_session_fk FOREIGN KEY (session_id)
      REFERENCES "${TEST_SCHEMA}"."sessions"(id) ON DELETE CASCADE;
  `);
  client = postgres(DB_URL, { max: 1 });
  // Constructing the drizzle wrapper MUTATES this client: drizzle-orm/postgres-js replaces
  // the serializers for every timestamp OID (1184/1082/1083/1114/...) and for jsonb (3802)
  // with a transparent pass-through, so the client can no longer bind a `Date` or a
  // `sql.json()` wrapper afterwards. It is therefore built ONCE, here, before any seeding —
  // and the seeds below pass ISO strings and JSON text, which survive a pass-through
  // serializer unchanged and are parsed by Postgres against the target column's type.
  // Getting this wrong is invisible in a single test: the first test passes and every
  // subsequent one dies on identical seed code.
  db = drizzle(client);
  try {
    await client.unsafe(`SET search_path TO "${TEST_SCHEMA}", public`);
    const [current] = await client<Array<{ value: string }>>`SELECT current_schema() AS value`;
    expect(current?.value).toBe(TEST_SCHEMA);
    await client`SELECT 1 FROM sessions LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  await client?.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'privacy §9 retention scrub (V-759, real Postgres)',
  () => {
    async function seed(): Promise<{
      oldSession: string;
      recentSession: string;
      oldKey: string;
      recentKey: string;
    }> {
      if (!client) throw new Error('real PostgreSQL setup failed');
      const accountId = randomUUID();
      await client`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${accountId}, ${`r-${accountId}@t.test`}, 'api_scale', 'active')`;

      // Explicit column lists, matching the idiom of the other db-*-drizzle tests. Timestamps
      // go in as ISO strings and jsonb as JSON text — see the serializer note in beforeAll.
      const mkKey = async (revokedAt: Date): Promise<string> => {
        const id = randomUUID();
        await client!`
          INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, revoked_at)
          VALUES (${id}, ${accountId}, 'customer named this key',
                  ${`dsk_${id.slice(0, 8)}`}, ${`hash-${id}`}, ${revokedAt.toISOString()})`;
        return id;
      };
      const mkSession = async (destroyedAt: Date, keyId: string): Promise<string> => {
        const id = randomUUID();
        await client!`
          INSERT INTO sessions (id, account_id, api_key_id, status, archetype,
                                driver_session_id, purpose, label, metadata, destroyed_at)
          VALUES (${id}, ${accountId}, ${keyId}, 'destroyed', 'desktop_chrome',
                  ${`drv-${id}`}, 'production_customer', 'customer label',
                  ${JSON.stringify(SEEDED_METADATA)}, ${destroyedAt.toISOString()})`;
        return id;
      };

      const oldKey = await mkKey(LONG_AGO);
      const recentKey = await mkKey(RECENT);
      const oldSession = await mkSession(LONG_AGO, oldKey);
      const recentSession = await mkSession(RECENT, recentKey);

      // A usage record on the OLD session — the billing row §9 keeps for 7 years.
      await client`
        INSERT INTO usage_records (id, account_id, session_id, record_type, quantity)
        VALUES (${randomUUID()}, ${accountId}, ${oldSession}, 'session_minute', 1)`;

      // Operations on both sessions. `kind` and `status` are CHECK-constrained vocabularies
      // and `request_fingerprint` is CHECK-constrained to 64 hex chars, so these are the real
      // shapes rather than plausible-looking placeholders.
      const hex64 = (): string => `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
      for (const sid of [oldSession, recentSession]) {
        await client`
          INSERT INTO session_operations (id, account_id, session_id, kind, status,
                                          driver_incarnation_id, deadline_at,
                                          request_fingerprint)
          VALUES (${randomUUID()}, ${accountId}, ${sid}, 'login', 'queued',
                  ${randomUUID()}, ${NOW.toISOString()}, ${hex64()})`;
      }
      return { oldSession, recentSession, oldKey, recentKey };
    }

    function sweeper(): RetentionScrubSweeperService {
      const database = { client: client!, db: db!, close: async () => {} } as unknown as Database;
      return new RetentionScrubSweeperService({ repo: new DrizzleRetentionScrubRepo(database) });
    }

    it('CRITICAL scrubs only what is PAST the window, and leaves everything inside it untouched', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const { oldSession, recentSession, oldKey, recentKey } = await seed();

      const result = await sweeper().tickOnce(NOW);
      expect(result.sessionsScrubbed).toBeGreaterThanOrEqual(1);

      const [old] = await client<
        Array<{
          purpose: string;
          label: string | null;
          metadata: unknown;
        }>
      >`SELECT purpose, label, metadata FROM sessions WHERE id = ${oldSession}`;
      // The customer-supplied fields are gone...
      expect(old?.label).toBeNull();
      expect(old?.metadata).toBeNull();
      // ...but `purpose` is an ENUM — a fixed internal vocabulary, not personal data — so it
      // must be left intact. Scrubbing it was the first design of this sweep and it was
      // wrong: the column cannot even hold a sentinel.
      expect(old?.purpose).toBe('production_customer');

      // The whole risk of this change, asserted directly: a session that ended 10 days ago
      // keeps every field. Over-scrubbing is irreversible.
      const [recent] = await client<Array<{ label: string | null; metadata: unknown }>>`
        SELECT label, metadata FROM sessions WHERE id = ${recentSession}`;
      expect(recent?.label).toBe('customer label');
      // Deep-equal, not just non-null: this doubles as proof the seeded JSON text landed as
      // real jsonb rather than a double-encoded jsonb *string*.
      expect(recent?.metadata).toEqual(SEEDED_METADATA);

      const [recentOps] = await client<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM session_operations WHERE session_id = ${recentSession}`;
      expect(recentOps?.n).toBe('1');

      const [key] = await client<Array<{ name: string; key_hash: string; key_prefix: string }>>`
        SELECT name, key_hash, key_prefix FROM api_keys WHERE id = ${oldKey}`;
      expect(key?.name).toBe(RETENTION_SCRUB_SENTINEL);
      // Per-row-unique hash sentinel, so a future unique index cannot break the sweep.
      expect(key?.key_hash).toBe(`scrubbed:${oldKey}`);
      // key_prefix is uniquely indexed and is not credential material — left intact.
      expect(key?.key_prefix).not.toBe(RETENTION_SCRUB_SENTINEL);

      // The api_keys sweep had only this PAST-the-window direction, while sessions
      // had both. `recentKey` was already seeded and simply never asserted, so
      // widening the key window — scrubbing every revoked key immediately instead
      // of after 90 days — left the whole suite green. That window is what the
      // privacy policy's "90 days after revocation the record is anonymised" line
      // rests on, and destroying the name and hash early is irreversible.
      const [recentKeyRow] = await client<
        Array<{ name: string; key_hash: string }>
      >`SELECT name, key_hash FROM api_keys WHERE id = ${recentKey}`;
      expect(recentKeyRow?.name, 'a key revoked inside the window keeps its name').toBe(
        'customer named this key',
      );
      expect(recentKeyRow?.key_hash, 'and its hash — anonymising early cannot be undone').toBe(
        `hash-${recentKey}`,
      );

      // Deliberately NOT asserted: that a NEVER-revoked key survives. The sweep's
      // `revoked_at IS NOT NULL` predicate is redundant with `revoked_at < cutoff`
      // under SQL three-valued logic — NULL < cutoff is NULL, so such a row is
      // never selected — and an arm for it would pin a state the query cannot
      // reach. Verified against the database rather than assumed.
    });

    it('CRITICAL a scrubbed session KEEPS its row, so usage_records (7-year billing data) survive', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const { oldSession } = await seed();

      await sweeper().tickOnce(NOW);

      // The session row must still exist. This is the load-bearing assertion: the FK above
      // is ON DELETE CASCADE, so if this sweep ever becomes a DELETE, the usage record goes
      // with it and a 7-year statutory retention duty is breached to satisfy a 90-day one.
      const [session] = await client<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM sessions WHERE id = ${oldSession}`;
      expect(session?.n, 'the sweep must SCRUB the session, never DELETE it').toBe('1');

      const [usage] = await client<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM usage_records WHERE session_id = ${oldSession}`;
      expect(usage?.n, 'billing data must survive the retention scrub').toBe('1');
    });

    it('deletes operations of expired sessions, and is idempotent across ticks', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const { oldSession } = await seed();

      const first = await sweeper().tickOnce(NOW);
      expect(first.operationsDeleted).toBeGreaterThanOrEqual(1);

      const [ops] = await client<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM session_operations WHERE session_id = ${oldSession}`;
      expect(ops?.n).toBe('0');

      // A second tick must report ZERO, not re-scrub. Without the `purpose <> sentinel`
      // and `name <> sentinel` guards the counts would inflate forever and every daily
      // tick would log a retention event that did not happen.
      const second = await sweeper().tickOnce(NOW);
      expect(second.operationsDeleted).toBe(0);
      expect(second.sessionsScrubbed).toBe(0);
      expect(second.apiKeysScrubbed).toBe(0);
    });
  },
);
