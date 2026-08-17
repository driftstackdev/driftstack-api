// Item 2 — AuditArchiveService is built, unit-tested, and has never RUN.
// `audit_archive_runs` holds zero rows, and the recommendation attached to that
// item is "wire it, but on a staging dataset first — it deletes production rows
// after an R2 upload."
//
// This is that first run: the real Drizzle repos against real Postgres, with a
// recording R2 double. Everything the unit tests cover is exercised against
// fakes; what has never been exercised is the SQL — the window predicate that
// decides which rows are old enough, and the delete-by-id that removes them
// afterwards. A subsystem whose deletion step has never touched a real database
// is the definition of an unknown-unknown.
//
// Deliberately drives `processed_stripe_events`: it is one of the five tables in
// scope, has no foreign keys to satisfy, and its rows are pure bookkeeping, so a
// mistake here cannot strand customer data in a shared local database.

import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleArchiveLedgerRepo,
  DrizzleArchiveTableRepo,
} from '../../src/db/audit-archive-repo.js';
import { AuditArchiveService } from '../../src/services/audit-archive.js';
import type { R2 } from '../../src/lib/r2.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

let client: ReturnType<typeof postgres> | null = null;
const seededIds: string[] = [];
const seededAccounts: string[] = [];

function recordingR2(): { r2: R2; puts: { key: string; body: Buffer }[] } {
  const puts: { key: string; body: Buffer }[] = [];
  const r2 = {
    putObject: (args: { key: string; body: Buffer | string }) => {
      puts.push({ key: args.key, body: Buffer.from(args.body) });
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, puts };
}

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM processed_stripe_events LIMIT 0`;
    await client`SELECT 1 FROM audit_archive_runs LIMIT 0`;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (!client) return;
  for (const id of seededIds) {
    await client`DELETE FROM processed_stripe_events WHERE event_id = ${id}`.catch(() => {});
  }
  for (const id of seededAccounts) {
    // session_events cascade from sessions, sessions from accounts; deliveries
    // cascade from endpoints.
    await client`DELETE FROM sessions WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM webhook_endpoints WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM api_keys WHERE account_id = ${id}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
  }
  // Scoped by the test-only R2 prefix, NOT by table name: the redaction arms
  // archive session_events and webhook_deliveries too, and a table-name filter
  // left their ledger rows behind in a shared database.
  await client`DELETE FROM audit_archive_runs WHERE r2_object_key LIKE 'test-archive/%'`.catch(
    () => {},
  );
  await client.end({ timeout: 5 });
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AuditArchiveService against real Postgres (its first end-to-end run)',
  () => {
    it('CRITICAL deletes a set larger than one statement can bind', async () => {
      // The bind-parameter ceiling, exercised for real. `inArray` binds one
      // parameter per id and postgres-js refuses past 65534: measured on this
      // server, 60000 ids succeed and 70000 raise MAX_PARAMETERS_EXCEEDED.
      //
      // That mattered because of WHERE it threw. archiveTable uploads to R2 and
      // inserts the ledger row BEFORE deleting, so a run over the ceiling left
      // the rows in Postgres with the archive already written — and the next run
      // re-selected the same set plus whatever had accrued, forever. session_events
      // is documented in AUDIT_TABLES as growing without bound, so it is the table
      // that reaches this first, and the retention promise would fail silently.
      //
      // Deliberately passes ids that do not exist: binding is what breaks, not
      // matching, so this proves the chunking without seeding 70k rows.
      if (!client) {
        if (process.env.CI) {
          throw new Error('real-PG audit-archive test: database unreachable/unmigrated in CI');
        }
        return;
      }
      const c = client;
      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleArchiveTableRepo({ client: c, db, close: async () => {} });
      const ids = Array.from({ length: 70_000 }, (_, i) => `evt_absent_${i}`);

      const deleted = await repo.deleteRowsById('processed_stripe_events', ids);
      expect(deleted, 'none of the synthetic ids exist, so nothing should be removed').toBe(0);
    });

    it('CRITICAL uploads the aged rows, deletes exactly those, and leaves recent rows alone', async () => {
      if (!client) {
        if (process.env.CI) {
          throw new Error('real-PG audit-archive test: database unreachable/unmigrated in CI');
        }
        return;
      }
      const c = client;
      const stamp = Date.now().toString(36);
      const oldA = `evt_old_a_${stamp}`;
      const oldB = `evt_old_b_${stamp}`;
      const recent = `evt_recent_${stamp}`;
      seededIds.push(oldA, oldB, recent);

      const longAgo = new Date(Date.now() - 200 * DAY_MS);
      const alsoLongAgo = new Date(Date.now() - 150 * DAY_MS);
      const yesterday = new Date(Date.now() - DAY_MS);
      for (const [id, at] of [
        [oldA, longAgo],
        [oldB, alsoLongAgo],
        [recent, yesterday],
      ] as const) {
        await c`INSERT INTO processed_stripe_events (event_id, event_type, payload_hash, result, received_at)
                VALUES (${id}, ${'invoice.paid'}, ${'hash'}, ${'handled'}, ${at.toISOString()}::timestamptz)`;
      }

      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const { r2, puts } = recordingR2();
      const service = new AuditArchiveService({
        r2,
        ledger: new DrizzleArchiveLedgerRepo({ client: c, db, close: async () => {} }),
        rows: new DrizzleArchiveTableRepo({ client: c, db, close: async () => {} }),
        r2Prefix: 'test-archive',
      });

      const result = await service.archiveTable('processed_stripe_events');

      // The rows this run claims to have archived are the seeded aged ones. It
      // may sweep other aged rows a shared database already held, so this
      // asserts containment rather than an exact count.
      expect(result.rowsArchived).toBeGreaterThanOrEqual(2);
      expect(puts, 'exactly one object per sweep').toHaveLength(1);

      const uploaded = gunzipSync(puts[0]!.body).toString('utf-8');
      const ids = uploaded
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { eventId?: string; event_id?: string })
        .map((r) => r.eventId ?? r.event_id);
      expect(ids, 'both aged rows are in the upload').toEqual(expect.arrayContaining([oldA, oldB]));
      expect(ids, 'the recent row is NOT').not.toContain(recent);

      // The deletion step — the half that has never touched a real database.
      const survivors = await c`SELECT event_id FROM processed_stripe_events
                                WHERE event_id IN (${oldA}, ${oldB}, ${recent})`;
      expect(survivors.map((r) => String(r['event_id']))).toEqual([recent]);

      // …and the ledger records the sweep, including that the delete completed.
      const runs = await c`SELECT rows_archived, sha256_checksum, deleted_from_postgres
                           FROM audit_archive_runs WHERE r2_object_key = ${puts[0]!.key}`;
      expect(runs.length, 'the ledger gains a row — it had zero before').toBe(1);
      expect(runs[0]?.['deleted_from_postgres']).toBe(true);
      expect(
        runs[0]?.['sha256_checksum'],
        'the checksum is over the uploaded bytes, so a corrupted upload is detectable',
      ).toBe(createHash('sha256').update(puts[0]!.body).digest('hex'));
    });

    it('CRITICAL a navigated event is archived REDACTED — origin only, never the full URL', async () => {
      // Exactly two of the five tables in scope carry a projection —
      // session_events (this arm) and webhook_deliveries (the next) — and both
      // projections are REDACTIONS rather than shape changes. Here, `navigated`
      // keeps the origin and drops the path and query, which is where customer
      // data and tokens live.
      //
      // That redaction had never run on the archive path against a real row. If
      // the archive skipped it, the full URL would leave the database and land
      // in an R2 object — the live API redacts it and the archive would not.
      if (!client) {
        if (process.env.CI) throw new Error('real-PG audit-archive redaction test: DB unreachable');
        return;
      }
      const c = client;
      const accountId = randomUUID();
      const keyId = randomUUID();
      const sessionId = randomUUID();
      seededAccounts.push(accountId);
      await c`INSERT INTO accounts (id, email, tier, status)
              VALUES (${accountId}, ${`arch-${accountId}@t.test`}, 'api_scale', 'active')`;
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash)
              VALUES (${keyId}, ${accountId}, 'k', ${`dsk_${keyId.slice(0, 8)}`}, ${`h-${keyId}`})`;
      await c`INSERT INTO sessions (id, account_id, api_key_id, status, archetype, driver_session_id)
              VALUES (${sessionId}, ${accountId}, ${keyId}, 'destroyed',
                      'iphone17_ios18_7_safari26_4', ${`drv-${sessionId}`})`;

      const SECRET_PATH = '/reset-password?token=super-secret-value';
      await c`INSERT INTO session_events (session_id, type, payload, created_at)
              VALUES (${sessionId}, 'navigated',
                      ${JSON.stringify({ url: `https://bank.example.test${SECRET_PATH}` })}::text::jsonb,
                      ${new Date(Date.now() - 200 * DAY_MS).toISOString()}::timestamptz)`;

      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const { r2, puts } = recordingR2();
      const service = new AuditArchiveService({
        r2,
        ledger: new DrizzleArchiveLedgerRepo({ client: c, db, close: async () => {} }),
        rows: new DrizzleArchiveTableRepo({ client: c, db, close: async () => {} }),
        r2Prefix: 'test-archive',
      });

      await service.archiveTable('session_events');

      expect(puts).toHaveLength(1);
      const uploaded = gunzipSync(puts[0]!.body).toString('utf-8');
      expect(uploaded, 'the secret path and query must NEVER reach the archive').not.toContain(
        'super-secret-value',
      );
      // Asserting the ABSENCE of the path alone would anchor on a PREFIX of the
      // secret, which the secrecy-assertion invariant rightly refuses: a prefix is
      // routinely public, so its absence is a weaker claim than it looks. The
      // stronger statement is positive — the projected field equals the bare
      // origin, so no part of the path survived, token or not.
      const archived = uploaded
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { payload?: { requested_origin?: string } });
      expect(archived).toHaveLength(1);
      expect(archived[0]?.payload?.requested_origin).toBe('https://bank.example.test');
    });

    it('CRITICAL a legacy session.failed delivery is archived through the allowlist envelope', async () => {
      // The second projection, and the one with no behavioural test at all — its
      // only coverage was a content-parity pin, which records what the source
      // SAID and never whether it was true.
      //
      // It exists because rows written before the session-observability fix
      // carry failure detail straight from the target site. `projectSessionFailedData`
      // is an ALLOWLIST — session_id, duration_ms, operation and a canned copy
      // survive, everything else is dropped — and the archive re-applies it to
      // those legacy rows, alongside nulling the response excerpt and the error.
      // Untested, the archive would ship exactly what the live path refuses to.
      if (!client) {
        if (process.env.CI)
          throw new Error('real-PG webhook-archive redaction test: DB unreachable');
        return;
      }
      const c = client;
      const accountId = randomUUID();
      const endpointId = randomUUID();
      const eventId = randomUUID();
      seededAccounts.push(accountId);

      const UPSTREAM_SECRET = 'upstream-bearer-abc123-do-not-archive';
      const EXCERPT_SECRET = 'response-body-holding-a-session-cookie-xyz789';
      const DELIVERY_ERROR_SECRET = 'connect ETIMEDOUT 10.4.7.9:8443 internal-host';

      await c`INSERT INTO accounts (id, email, tier, status)
              VALUES (${accountId}, ${`wh-${accountId}@t.test`}, 'api_scale', 'active')`;
      await c`INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
              VALUES (${endpointId}, ${accountId}, 'https://hooks.example.test/in',
                      ${`whsec_${endpointId}`}, 'whsec_', ARRAY['session.failed']::webhook_event_type[])`;

      // The pre-fix payload shape: arbitrary failure detail under `data`.
      const legacyPayload = {
        id: eventId,
        type: 'session.failed',
        created_at: new Date(Date.now() - 200 * DAY_MS).toISOString(),
        data: {
          session_id: randomUUID(),
          duration_ms: 4200,
          operation: 'navigate',
          error_message: `target refused auth: ${UPSTREAM_SECRET}`,
          target_url: 'https://bank.example.test/account?session=leaky',
        },
      };
      await c`INSERT INTO webhook_deliveries
                (webhook_id, event_id, event_type, payload, status, attempts,
                 last_response_status, last_response_excerpt, last_error, created_at)
              VALUES (${endpointId}, ${eventId}, 'session.failed',
                      ${JSON.stringify(legacyPayload)}::text::jsonb, 'failed', 3,
                      500, ${EXCERPT_SECRET}, ${DELIVERY_ERROR_SECRET},
                      ${new Date(Date.now() - 200 * DAY_MS).toISOString()}::timestamptz)`;

      const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const { r2, puts } = recordingR2();
      const service = new AuditArchiveService({
        r2,
        ledger: new DrizzleArchiveLedgerRepo({ client: c, db, close: async () => {} }),
        rows: new DrizzleArchiveTableRepo({ client: c, db, close: async () => {} }),
        r2Prefix: 'test-archive',
      });

      await service.archiveTable('webhook_deliveries');

      expect(puts).toHaveLength(1);
      const uploaded = gunzipSync(puts[0]!.body).toString('utf-8');
      expect(uploaded, 'upstream failure detail must not reach the archive').not.toContain(
        UPSTREAM_SECRET,
      );
      expect(uploaded, 'the response excerpt is nulled, not archived').not.toContain(
        EXCERPT_SECRET,
      );
      expect(uploaded, 'the delivery error is nulled, not archived').not.toContain(
        DELIVERY_ERROR_SECRET,
      );

      // Positive form: the archived row carries ONLY the allowlisted keys, so a
      // future field added to the legacy payload cannot ride along unnoticed.
      const rows = uploaded
        .split('\n')
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              eventId?: string;
              payload?: { type?: string; data?: Record<string, unknown> };
              lastResponseExcerpt?: unknown;
              lastError?: unknown;
            },
        );
      const mine = rows.find((r) => r.eventId === eventId);
      expect(mine, 'the seeded delivery must be in the upload').toBeDefined();
      expect(mine?.payload?.type).toBe('session.failed');
      expect(mine?.payload?.data?.['operation']).toBe('navigate');

      // `error_message` is allowlisted but REPLACED with one of four canned
      // strings, so its presence is not a leak and its absence is not the
      // property to assert. What matters is that no key outside the allowlist
      // survives — that is what stops a field added to the legacy payload from
      // riding along unnoticed — and that the message is canned, not upstream.
      const ALLOWED = ['duration_ms', 'error_message', 'error_name', 'operation', 'session_id'];
      expect(Object.keys(mine?.payload?.data ?? {}).filter((k) => !ALLOWED.includes(k))).toEqual(
        [],
      );
      expect([
        'The session operation timed out.',
        'The browser operation failed.',
        'The browser driver was unavailable.',
        'The session operation failed.',
      ]).toContain(mine?.payload?.data?.['error_message']);
      expect(mine?.lastResponseExcerpt).toBeNull();
      expect(mine?.lastError).toBeNull();
    });
  },
);
