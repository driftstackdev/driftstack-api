// No repo builds a statement with more ids than the driver will bind.
//
// `inArray(col, ids)` binds one parameter per id and postgres-js refuses past
// 65534 — measured here, not assumed: the last case in each arm passes 70000.
//
// Three sites derived their id list from a query result or an object listing,
// so their size was set by accumulated data rather than by anything in the
// code. All three are retention or cleanup work that runs on a backlog, which
// is what makes the failure self-reinforcing — the sweep that would shrink the
// table is the thing that breaks, so the backlog that triggered it keeps
// growing:
//
//   deleteRowsById            the audit archive uploads to R2 and writes its
//                             ledger row BEFORE deleting, so an oversized
//                             window left the rows in place with the archive
//                             already written.
//   purgeEmails               the V-295c3 90-day erasure of the email column on
//                             unsubscribed rows — a privacy commitment.
//   findExistingProfileIds    the orphan-blob reaper, which is wrapped to NEVER
//                             throw, so it would log and continue having reaped
//                             nothing.
//
// Each arm passes ids that do not exist. Binding is what breaks, not matching,
// so this needs no seeded rows and stays fast.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleArchiveTableRepo } from '../../src/db/audit-archive-repo.js';
import { DrizzleStatusSubscribersRepo } from '../../src/db/status-subscribers-repo.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { ID_BIND_CHUNK } from '../../src/db/chunk-ids.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Comfortably past the 65534 ceiling a single statement can bind. */
const OVER_CEILING = 70_000;

let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    client = postgres(DB_URL, { max: 1 });
  } catch {
    /* local dev without a database */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
});

afterAll(async () => {
  await client?.end({ timeout: 2 }).catch(() => undefined);
});

/** Text-keyed tables (processed_stripe_events.event_id). */
function absentTextIds(prefix: string): string[] {
  return Array.from({ length: OVER_CEILING }, (_, i) => `${prefix}_absent_${i}`);
}

/**
 * Valid v4-shaped UUIDs that cannot exist: the random block is all zeroes and
 * the index is encoded in the final 12 hex digits. uuid-typed columns reject a
 * non-UUID string at parse time (22P02) BEFORE the bind path is reached, which
 * would make these arms fail for a reason unrelated to what they measure.
 */
function absentUuids(): string[] {
  return Array.from(
    { length: OVER_CEILING },
    (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
  );
}

function db(c: ReturnType<typeof postgres>): {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
} {
  return {
    client: c,
    db: drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>,
    close: async () => {},
  };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'id lists larger than one statement can bind',
  () => {
    it('CRITICAL the chunk size is under the ceiling the driver enforces', () => {
      // Pinned separately from the behaviour: raising this constant past 65534
      // reintroduces every failure below and is a one-token edit.
      expect(ID_BIND_CHUNK).toBeLessThan(65_534);
      expect(ID_BIND_CHUNK).toBeGreaterThan(0);
    });

    it('CRITICAL the ceiling is real — a single statement over it still fails', () => {
      // Anti-vacuity for the three arms below. If the driver ever stopped
      // enforcing a limit, they would pass without proving anything, and this
      // case says so out loud by failing.
      if (!client) {
        if (process.env.CI) throw new Error('id-bind ceiling test: database unreachable in CI');
        return;
      }
      const c = client;
      const ids = absentUuids();
      return expect(c`SELECT 1 FROM status_subscribers WHERE id IN ${c(ids)}`).rejects.toThrow(
        /MAX_PARAMETERS_EXCEEDED/,
      );
    });

    it('CRITICAL audit archive deleteRowsById', async () => {
      if (!client) {
        if (process.env.CI) throw new Error('id-bind ceiling test: database unreachable in CI');
        return;
      }
      const repo = new DrizzleArchiveTableRepo(db(client));
      await expect(
        repo.deleteRowsById('processed_stripe_events', absentTextIds('evt')),
      ).resolves.toBe(0);
    });

    it('CRITICAL status-subscriber purgeEmails', async () => {
      if (!client) {
        if (process.env.CI) throw new Error('id-bind ceiling test: database unreachable in CI');
        return;
      }
      const repo = new DrizzleStatusSubscribersRepo(db(client));
      await expect(repo.purgeEmails(absentUuids())).resolves.toBe(0);
    });

    it('CRITICAL profiles findExistingProfileIds', async () => {
      if (!client) {
        if (process.env.CI) throw new Error('id-bind ceiling test: database unreachable in CI');
        return;
      }
      const repo = new DrizzleProfilesRepo(db(client));
      const found = await repo.findExistingProfileIds(absentUuids());
      expect(found.size).toBe(0);
    });
  },
);
