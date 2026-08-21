// V-1233 — one contract for the admin-audit time window, against BOTH implementations of
// `AdminAuditLogRepo`.
//
// The twenty-third of the twenty-nine. This is the staff-action trail — who did what to which
// customer — and the thing callers do with it is read a window at a time: an export, a review, a
// page of "everything between these two timestamps".
//
// THE WINDOW IS HALF-OPEN, and the two edges are deliberately asymmetric:
//
//   Drizzle  gte(timestamp, from)   AND   lt(timestamp, to)
//   double   timestamp >= fromMs    &&    timestamp <  toMs
//
// `from` inclusive, `to` exclusive. That asymmetry is the whole point and it is the easiest thing
// in the file to get wrong, because either edge alone looks arbitrary. What makes it correct is the
// consequence: adjacent windows [a, b) and [b, c) PARTITION the log. Every entry lands in exactly
// one of them — no entry counted twice, none dropped between pages.
//
// Make `to` inclusive and an entry on the boundary appears in two consecutive exports; make `from`
// exclusive and it appears in neither. Both are silent, and both corrupt a record whose only job is
// to be an accurate account of what staff did. So the third arm asserts the partition directly
// rather than trusting that two correct-looking edges compose.
//
// Timestamps are stamped by the repo, not chosen by the caller — but `insert` RETURNS the row, so
// the test reads the stamp back and builds the windows around it. Same technique as V-1231, and the
// reason this boundary is testable through the shared interface where V-1228's ordering was not.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { AdminAuditLogRepo } from '../../src/services/admin-audit.js';
import { DrizzleAdminAuditLogRepo } from '../../src/db/admin-audit-repo.js';
import { InMemoryAdminAuditLogRepo } from './_helpers/in-memory-admin-audit-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ACTION = 'account.suspended' as const;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM admin_audit_log LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM admin_audit_log WHERE admin_account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM api_keys WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Staff {
  adminAccountId: string;
  adminKeyId: string;
}

interface Subject {
  repo: AdminAuditLogRepo;
  staff: () => Promise<Staff>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryAdminAuditLogRepo(),
    staff: () => Promise.resolve({ adminAccountId: randomUUID(), adminKeyId: randomUUID() }),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleAdminAuditLogRepo({ client: c, db, close: async () => {} }),
    staff: async () => {
      const adminAccountId = randomUUID();
      const adminKeyId = randomUUID();
      seeded.push(adminAccountId);
      const tag = adminAccountId.slice(0, 8);
      await c`INSERT INTO accounts (id, email)
              VALUES (${adminAccountId}, ${`adminaudit-${adminAccountId}@test.local`})`;
      await c`INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
              VALUES (${adminKeyId}::uuid, ${adminAccountId}::uuid, ${`k-${tag}`},
                      ${`ds_aa_${tag}`}, ${`hash-${tag}`}, ${['driftstack_internal_admin']})`;
      return { adminAccountId, adminKeyId };
    },
  };
}

async function act(s: Subject, staff: Staff) {
  return s.repo.insert({
    adminAccountId: staff.adminAccountId,
    adminKeyId: staff.adminKeyId,
    action: ACTION,
    result: 'ok',
  });
}

const idsIn = async (s: Subject, staff: Staff, from?: Date, to?: Date): Promise<string[]> =>
  (
    await s.repo.list({
      adminAccountId: staff.adminAccountId,
      // `limit` is required by ListAuditFilters — large enough that these arms are about the
      // WINDOW and never about pagination.
      limit: 100,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    })
  ).items.map((r) => r.id);

function adminAuditWindowContract(
  label: string,
  make: () => Subject,
  enabled: () => boolean,
): void {
  describe(`AdminAuditLogRepo window contract — ${label}`, () => {
    it('CRITICAL `from` is INCLUSIVE, in both. An entry stamped exactly at the start of a window belongs to that window; an exclusive `from` drops it from every export, because the previous window ended before it.', async () => {
      if (!enabled()) return;
      const s = make();
      const staff = await s.staff();
      const entry = await act(s, staff);

      expect(
        await idsIn(s, staff, entry.timestamp, undefined),
        'an entry stamped exactly at `from` was excluded',
      ).toEqual([entry.id]);
    });

    it('CRITICAL `to` is EXCLUSIVE, in both. An entry stamped exactly at the end of a window belongs to the NEXT one; an inclusive `to` puts it in two consecutive exports.', async () => {
      if (!enabled()) return;
      const s = make();
      const staff = await s.staff();
      const entry = await act(s, staff);

      expect(
        await idsIn(s, staff, undefined, entry.timestamp),
        'an entry stamped exactly at `to` was included',
      ).toEqual([]);
    });

    it('CRITICAL adjacent windows PARTITION the log — every entry in exactly one, in both. This is what the two asymmetric edges are FOR, and asserting it directly is the only way to catch edges that are each defensible alone and wrong together: an inclusive `to` double-counts the boundary entry, an exclusive `from` loses it.', async () => {
      if (!enabled()) return;
      const s = make();
      const staff = await s.staff();
      const first = await act(s, staff);
      await new Promise((r) => setTimeout(r, 5));
      const boundary = await act(s, staff);
      await new Promise((r) => setTimeout(r, 5));
      const last = await act(s, staff);

      const earlier = await idsIn(s, staff, first.timestamp, boundary.timestamp);
      const later = await idsIn(
        s,
        staff,
        boundary.timestamp,
        new Date(last.timestamp.getTime() + 1),
      );

      expect(
        earlier,
        'the earlier window did not hold exactly the entries before the boundary',
      ).toEqual([first.id]);
      expect(
        [...later].sort(),
        'the later window did not hold the boundary entry and the one after it',
      ).toEqual([boundary.id, last.id].sort());
      expect(
        earlier.filter((id) => later.includes(id)),
        'an entry appeared in BOTH windows — the boundary is counted twice',
      ).toEqual([]);
    });

    it('CRITICAL the adminAccountId filter scopes to one operator, in both. This trail answers "what did THIS member of staff do", and folding in another operator\'s actions misattributes them to a person who did not perform them.', async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.staff();
      const other = await s.staff();
      const own = await act(s, mine);
      await act(s, other);

      expect(
        await idsIn(s, mine, undefined, undefined),
        "another operator's actions were attributed to this one",
      ).toEqual([own.id]);
    });

    it('CRITICAL an entry is recorded and readable back at all, in both. Without this the window arms are satisfied by an implementation that stores nothing and returns an empty page for every query.', async () => {
      if (!enabled()) return;
      const s = make();
      const staff = await s.staff();
      const entry = await act(s, staff);

      expect(
        await idsIn(s, staff, undefined, undefined),
        'the recorded action was not readable back',
      ).toEqual([entry.id]);
    });
  });
}

adminAuditWindowContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'AdminAuditLogRepo window contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    adminAuditWindowContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
