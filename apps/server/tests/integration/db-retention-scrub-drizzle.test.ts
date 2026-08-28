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
/**
 * The two rows either side of the cutoff.
 *
 * LONG_AGO and RECENT sit 110 days apart across a 90-day window — nowhere near the
 * edge — so an operator flip or a window off by a day passes both. The predicate is
 * `destroyed_at < cutoff` (strict), so a row exactly AT the cutoff is INSIDE and must
 * survive; one second older is out. Scrubbing early destroys customer data before the
 * 90 days the privacy policy promises, and it cannot be undone.
 */
const AT_CUTOFF = new Date(NOW.getTime() - 90 * DAY_MS);
const JUST_PAST_CUTOFF = new Date(NOW.getTime() - 90 * DAY_MS - 1000);
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
  for (const table of [
    'accounts',
    'api_keys',
    'sessions',
    'session_operations',
    'usage_records',
    'web_sessions',
  ]) {
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
    ALTER TABLE "${TEST_SCHEMA}"."web_sessions"
      ADD CONSTRAINT web_sessions_account_fk FOREIGN KEY (account_id)
      REFERENCES "${TEST_SCHEMA}"."accounts"(id) ON DELETE CASCADE;
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
      atCutoffSession: string;
      justPastSession: string;
      atCutoffKey: string;
      justPastKey: string;
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
      // The boundary pair, seeded alongside so one sweep decides all four rows.
      const atCutoffKey = await mkKey(AT_CUTOFF);
      const justPastKey = await mkKey(JUST_PAST_CUTOFF);
      const atCutoffSession = await mkSession(AT_CUTOFF, atCutoffKey);
      const justPastSession = await mkSession(JUST_PAST_CUTOFF, justPastKey);

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
      return {
        oldSession,
        recentSession,
        oldKey,
        recentKey,
        atCutoffSession,
        justPastSession,
        atCutoffKey,
        justPastKey,
      };
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

    it('CRITICAL the cutoff is bracketed: a row exactly AT 90 days survives and one a second older is scrubbed. The two rows the other arms use sit 110 days apart across the window, so an operator flip or a window off by a day passes them both. Early scrubbing is the direction that costs: it destroys a name, a hash and a customer label before the 90 days the privacy policy promises, and nothing brings them back.', async () => {
      if (!dbReachable) return;
      const seeded = await seed();
      await sweeper().tickOnce(NOW);

      // AT the cutoff — `destroyed_at < cutoff` is strict, so this row is INSIDE.
      const [atSession] = await client!<Array<{ label: string | null; metadata: unknown }>>`
        SELECT label, metadata FROM sessions WHERE id = ${seeded.atCutoffSession}`;
      expect(
        atSession?.label,
        'a session destroyed exactly at the 90-day cutoff was scrubbed — the window is one row too wide',
      ).toBe('customer label');
      const [atKey] = await client!<Array<{ name: string }>>`
        SELECT name FROM api_keys WHERE id = ${seeded.atCutoffKey}`;
      expect(
        atKey?.name,
        'a key revoked exactly at the cutoff was anonymised early, and that cannot be undone',
      ).toBe('customer named this key');

      // One second older — outside, and must be scrubbed.
      const [pastSession] = await client!<Array<{ label: string | null }>>`
        SELECT label FROM sessions WHERE id = ${seeded.justPastSession}`;
      expect(
        pastSession?.label,
        'a session one second past the cutoff kept its label — the window is one row too narrow',
      ).toBeNull();
      const [pastKey] = await client!<Array<{ name: string }>>`
        SELECT name FROM api_keys WHERE id = ${seeded.justPastKey}`;
      expect(pastKey?.name, 'a key one second past the cutoff kept its name').toBe(
        RETENTION_SCRUB_SENTINEL,
      );
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
      // Every step, not the three that existed when this arm was written.
      expect(second.webSessionsScrubbed).toBe(0);
    });

    // ── web_sessions (§9 session metadata) ───────────────────────────────────────
    // `issued_from_ip` and `user_agent` are a source IP and a device string recorded per
    // sign-in. Nothing scrubbed or pruned them: this table appeared ZERO times in the
    // sweeper, so they survived until the account cascade removed the row.
    async function seedWebSession(over: {
      expiresAt: string;
      revokedAt?: string | null;
    }): Promise<{ accountId: string; sessionId: string }> {
      if (!client) throw new Error('no client');
      const accountId = randomUUID();
      const sessionId = randomUUID();
      await client`
        INSERT INTO accounts (id, email, tier, status)
        VALUES (${accountId}, ${`ws-${accountId}@retention.test`}, 'solo_manual', 'active')`;
      // token_hash is UNIQUely indexed, so it must differ per row. last_used_at is
      // DEFAULT now() NOT NULL in the migration and is deliberately not supplied.
      await client`
        INSERT INTO web_sessions (id, account_id, token_hash, expires_at, revoked_at,
                                  issued_from_ip, user_agent)
        VALUES (${sessionId}, ${accountId}, ${`hash-${sessionId}`}, ${over.expiresAt},
                ${over.revokedAt ?? null}, '203.0.113.7', 'Mozilla/5.0 (probe)')`;
      return { accountId, sessionId };
    }

    async function identifiersOf(id: string): Promise<{
      ip: string | null;
      ua: string | null;
      account: string | null;
      expires: Date | null;
    }> {
      const [row] = await client!<
        Array<{
          issued_from_ip: string | null;
          user_agent: string | null;
          account_id: string | null;
          expires_at: Date | null;
        }>
      >`SELECT issued_from_ip, user_agent, account_id, expires_at
          FROM web_sessions WHERE id = ${id}`;
      return {
        ip: row?.issued_from_ip ?? null,
        ua: row?.user_agent ?? null,
        account: row?.account_id ?? null,
        expires: row?.expires_at ?? null,
      };
    }

    it('CRITICAL nulls the per-login IP and user-agent once a session is past the window, and leaves a session inside it untouched', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const past = await seedWebSession({ expiresAt: '2026-01-01T00:00:00.000Z' });
      const recent = await seedWebSession({ expiresAt: '2026-08-10T00:00:00.000Z' });

      const result = await sweeper().tickOnce(NOW);
      expect(result.webSessionsScrubbed).toBeGreaterThanOrEqual(1);

      const gone = await identifiersOf(past.sessionId);
      expect(gone.ip).toBeNull();
      expect(gone.ua).toBeNull();
      // The ROW survives, and so does everything that is not a personal identifier — the
      // dashboard session list orders on these and nothing else reads the two scrubbed
      // columns. Deleting the row instead would change what the customer sees.
      expect(gone.account).toBe(past.accountId);
      expect(gone.expires).not.toBeNull();

      const kept = await identifiersOf(recent.sessionId);
      expect(kept.ip, 'a session two days old is inside the window').toBe('203.0.113.7');
      expect(kept.ua).toBe('Mozilla/5.0 (probe)');
    });

    it('CRITICAL the window starts at REVOCATION, not expiry — a session revoked yesterday is not due even though it expired long ago. Keying on expires_at alone would scrub it 89 days early, which is the simplification a future reader is most likely to make.', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      const revokedRecently = await seedWebSession({
        expiresAt: '2026-01-01T00:00:00.000Z',
        revokedAt: '2026-08-11T00:00:00.000Z',
      });

      await sweeper().tickOnce(NOW);

      const row = await identifiersOf(revokedRecently.sessionId);
      expect(row.ip, 'revoked one day ago — 89 days of the window remain').toBe('203.0.113.7');
      expect(row.ua).toBe('Mozilla/5.0 (probe)');
    });

    // ⛔ The file's existing idempotency arm asserts `webSessionsScrubbed === 0` on a repeat
    // tick, but it runs EARLIER in the file than these arms, so no web_sessions row exists
    // when it executes — it asserts zero against an empty table. Measured: removing the
    // already-scrubbed guard from BOTH the CTE and the UPDATE left that arm green. This one
    // seeds first, so the second tick has something it could wrongly re-scrub.
    it('CRITICAL a repeat tick re-scrubs NOTHING. Without the already-scrubbed guard the same rows are re-selected every tick, the count inflates forever, and each daily run logs a retention event that did not happen.', async () => {
      if (!dbReachable || !client) throw new Error('real PostgreSQL setup failed');
      await seedWebSession({ expiresAt: '2025-12-01T00:00:00.000Z' });

      const first = await sweeper().tickOnce(NOW);
      expect(first.webSessionsScrubbed, 'the seeded row was due').toBeGreaterThanOrEqual(1);

      const second = await sweeper().tickOnce(NOW);
      expect(second.webSessionsScrubbed, 'already scrubbed — nothing left to do').toBe(0);
    });
  },
);
