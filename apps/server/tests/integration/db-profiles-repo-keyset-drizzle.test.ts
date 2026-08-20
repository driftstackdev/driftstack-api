// Drizzle-backed integration test for DrizzleProfilesRepo.list keyset
// pagination — same-timestamp completeness against a REAL Postgres.
//
// Sibling of db-sessions-repo-keyset-drizzle.test.ts. profiles is the
// prod-proven keyset REFERENCE impl (the timestamp-only-cursor migration
// mirrored it across the other repos), and it's the highest-traffic
// customer list — but it had no real-Postgres regression guard. list()
// pages an account's profiles on a compound (createdAt desc, id desc)
// keyset; a timestamp-only cursor would drop rows sharing the cursor's
// createdAt at a page boundary (profiles created in a burst share an
// identical now()). This locks the shipped keyset SQL on real PG.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine at localhost:5432 with the
//     `driftstack` schema migrated; this test always runs there.
//   - Local dev: skips if DATABASE_URL postgres is unreachable.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: profiles → accounts.
const seeded: string[] = [];

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
  // max > 1 deliberately. The cap test below fires N concurrent inserts; with a
  // single pooled connection postgres-js QUEUES them, so they run sequentially and
  // the pool — not the row lock — provides whatever serialisation is observed.
  //
  // Be precise about what widening this does and does not buy. It makes the
  // concurrency REAL rather than nominal. It does NOT turn the test into a proof
  // that the FOR UPDATE is what enforces the cap: measured both ways, deleting
  // `.for('update')` from insertWithLimit leaves this file green at `max: 1` AND
  // at `max: 8`, and a two-backend probe outside vitest also still accepted
  // exactly one. The TOCTOU window between the count and the insert is narrow, so
  // a race that does not hit it is not evidence the lock is unnecessary — the
  // lock is load-bearing by construction, since nothing else stops two
  // transactions that both read count < limit from both inserting.
  //
  // Left as an honest limitation rather than a claim: demonstrating the lock
  // itself needs forced interleaving, not a faster race.
  client = postgres(DB_URL, { max: 8 });
  try {
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo.list keyset (Drizzle path against real Postgres)',
  () => {
    it('pages a same-createdAt tie group larger than the page size WITHOUT dropping rows', async () => {
      if (!dbReachable || !client) {
        // Local dev without DATABASE_URL: skip quietly. In CI the DB
        // service + migrate step are part of the job — an unreachable or
        // unmigrated DB must FAIL the test, not vacuous-pass (this exact
        // silent skip hid a from-birth Date-bind crash in every one of
        // these tests until 2026-06-12).
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`keyset-prof-${accountId}@test.local`})`;

      // 2 newest, 5 in a tie group (> page size 2), 2 oldest — distinct
      // names (account+name is unique), controlled created_at for the tie.
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      const groups: Array<{ ts: Date; n: number }> = [
        { ts: new Date(base + 2000), n: 2 },
        { ts: new Date(base + 1000), n: 5 },
        { ts: new Date(base), n: 2 },
      ];
      const inserted: string[] = [];
      // created_at bound as ISO string. CORRECTED ATTRIBUTION (the first
      // version of this note blamed a postgres-js bump — wrong): raw Date
      // params crash postgres-js's Bind step, a class this codebase already
      // documents (scheduled-jobs-repo W441 note). These tests carried the
      // crash FROM BIRTH but CI's missing migrate step made the dbReachable
      // guard vacuous-pass them — first real execution was 2026-06-12
      // locally. ISO string binds are timestamptz-exact and robust.
      let nameSeq = 0;
      for (const g of groups) {
        for (let i = 0; i < g.n; i++) {
          const [row] = await client`
            INSERT INTO profiles (account_id, name, created_at)
            VALUES (${accountId}, ${`keyset-prof-${nameSeq++}`}, ${g.ts.toISOString()})
            RETURNING id`;
          inserted.push(row?.id as string);
        }
      }
      expect(inserted).toHaveLength(9);

      const collected: Array<{ id: string; createdAt: Date }> = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await repo.list(
          cursor === undefined ? { accountId, limit: 2 } : { accountId, limit: 2, cursor },
        );
        collected.push(...page.data.map((r) => ({ id: r.id, createdAt: r.createdAt })));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Completeness: every seeded profile returned exactly once.
      expect(collected).toHaveLength(9);
      expect(new Set(collected.map((r) => r.id)).size).toBe(9);
      expect([...collected].map((r) => r.id).sort()).toEqual([...inserted].sort());

      // Ordering: non-increasing createdAt (desc) across the full walk.
      for (let i = 1; i < collected.length; i++) {
        expect(collected[i]!.createdAt.getTime()).toBeLessThanOrEqual(
          collected[i - 1]!.createdAt.getTime(),
        );
      }
    });

    // FIX 3 — a cursor pointing at a profile that was soft-deleted between page
    // fetches must still ADVANCE the page, not silently reset to page 1. The
    // cursor-anchor lookup deliberately drops the notDeleted filter (a keyset
    // position is well-defined whether or not the boundary row is still live);
    // the RESULT set stays live-only. Pre-fix, a trashed boundary made the anchor
    // unresolvable → page 1 returned again with a non-null next_cursor (loop).
    it("CRITICAL list clamps an oversized limit to MAX_PAGE. The clamp had NO behavioural arm: removing it left the whole suite green except two source-text pins, which would go green again the moment someone rewrote the expression rather than deleted it. Every route in front of this repo carries a Zod .max(100), so the clamp is defence-in-depth — and that is exactly why it was easy to leave untested. The day a second caller reaches this repo without a schema, one call pulls the account's entire profile table into memory.", async () => {
      if (!dbReachable || client === null) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`cap-prof-${accountId}@test.local`})`;
      // 101 rows in ONE statement — enough to exceed the 100 cap, cheap enough
      // not to pay 101 round-trips. Swept by the account_id cleanup in afterAll.
      await client`
        INSERT INTO profiles (account_id, name)
        SELECT ${accountId}, 'cap-prof-' || g FROM generate_series(1, 101) g`;

      const page = await repo.list({ accountId, limit: 5000 });
      expect(page.data.length, 'the oversized limit was clamped to MAX_PAGE').toBe(100);
    });

    it('advances past a boundary profile trashed between page fetches (no reset to page 1)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG trashed-boundary test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      // Capture into a non-null local so the closure below keeps the narrowing
      // (the `client` field is `... | null`; closures don't carry the guard).
      const sql = client;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client: sql, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`boundary-${accountId}@test.local`})`;

      // Three distinct created_at so the desc order is c → b → a (newest first).
      const base = Date.UTC(2026, 5, 1, 0, 0, 0);
      const insert = async (name: string, ms: number): Promise<string> => {
        const [row] = await sql`
          INSERT INTO profiles (account_id, name, created_at)
          VALUES (${accountId}, ${name}, ${new Date(base + ms).toISOString()})
          RETURNING id`;
        return row?.id as string;
      };
      const a = await insert('boundary-a', 0);
      const b = await insert('boundary-b', 1000);
      const c = await insert('boundary-c', 2000);

      // Page 1 (limit 1) → newest `c`; next_cursor = c.
      const page1 = await repo.list({ accountId, limit: 1 });
      expect(page1.data.map((r) => r.id)).toEqual([c]);
      expect(page1.nextCursor).toBe(c);

      // Trash the boundary `c` before page 2.
      expect(await repo.delete({ id: c, accountId })).toBe(true);

      // Page 2 with the stale cursor MUST advance to `b`, not reset to the
      // newest live profile (which is now `b` too — so we additionally verify
      // page 3 reaches `a` and terminates, proving real forward progress).
      const page2 = await repo.list({ accountId, limit: 1, cursor: c });
      expect(page2.data.map((r) => r.id)).toEqual([b]);
      expect(page2.nextCursor).toBe(b);

      const page3 = await repo.list({ accountId, limit: 1, cursor: b });
      expect(page3.data.map((r) => r.id)).toEqual([a]);
      expect(page3.nextCursor).toBeNull();
    });

    // The sibling above removes a row mid-loop. This one ADDS rows mid-loop,
    // which is the case the customer documentation actually promises: "cursor
    // pagination is stable under concurrent inserts (page 2 doesn't shift just
    // because page 1 grew); offset pagination isn't, and we don't want to
    // expose customers to that footgun."
    //
    // Nothing checked it against real Postgres. The in-memory repo is not
    // evidence here — the property belongs to the shipped keyset SQL, and an
    // offset-based rewrite would keep every in-memory test passing while
    // duplicating rows for a customer driving a list to completion.
    it('does not repeat or drop a row when profiles are inserted mid-loop (the documented concurrent-insert promise)', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG concurrent-insert test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const sql = client;
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client: sql, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await sql`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`insert-${accountId}@test.local`})`;

      const base = Date.UTC(2026, 5, 2, 0, 0, 0);
      const insert = async (name: string, ms: number): Promise<string> => {
        const [row] = await sql`
          INSERT INTO profiles (account_id, name, created_at)
          VALUES (${accountId}, ${name}, ${new Date(base + ms).toISOString()})
          RETURNING id`;
        return row?.id as string;
      };

      const originals: string[] = [];
      for (let i = 0; i < 5; i += 1) originals.push(await insert(`orig-${String(i)}`, i * 1000));

      const page1 = await repo.list({ accountId, limit: 2 });
      expect(page1.data, 'page 1 is full').toHaveLength(2);

      // Page 1 "grows": three rows newer than anything already returned. Under
      // offset pagination these shift every later window and the loop re-reads
      // rows it has already handed the caller.
      for (let i = 0; i < 3; i += 1) await insert(`inserted-${String(i)}`, 10_000 + i * 1000);

      const seen = [...page1.data.map((r) => r.id)];
      let cursor = page1.nextCursor;
      for (let guard = 0; guard < 10 && cursor !== null; guard += 1) {
        const next = await repo.list({ accountId, limit: 2, cursor });
        seen.push(...next.data.map((r) => r.id));
        cursor = next.nextCursor;
      }

      expect(
        seen.filter((id, i) => seen.indexOf(id) !== i),
        'no row may be returned twice — the offset footgun the docs promise customers are spared',
      ).toEqual([]);
      expect(
        originals.filter((id) => !seen.includes(id)),
        'and no original may be skipped by the window moving underneath the loop',
      ).toEqual([]);
      expect(cursor, 'the drive-to-completion loop terminated on its own').toBeNull();
    });
  },
);

// V-714 — the TOCTOU guard this change exists for. Only a REAL Postgres
// exercises the `FOR UPDATE` account-row lock inside insertWithLimit; the
// in-memory repo's JS-single-thread atomicity can't reproduce the race.
describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo.insertWithLimit (V-714 — atomic tier-cap under real concurrency)',
  () => {
    // Organization metadata (migration 0076) — REAL-PG round-trip for the
    // jsonb tags column. The profiles route/service tests run on the
    // in-memory repo, so without this the drizzle path for tags was
    // untested against the actual driver. postgres-js + drizzle jsonb has
    // a known double-encode footgun class (array survives as a JSON
    // STRING instead of an array on read-back) — this pins the array
    // round-trip, the '[]' column default, the update path, and the
    // null-clears folder semantics.
    it('round-trips folder + jsonb tags through insert/update/findById (0076)', async () => {
      if (!dbReachable || !client) {
        // Local dev without DATABASE_URL: skip quietly. In CI the DB
        // service + migrate step are part of the job — an unreachable or
        // unmigrated DB must FAIL the test, not vacuous-pass (this exact
        // silent skip hid a from-birth Date-bind crash in every one of
        // these tests until 2026-06-12).
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`org-meta-${accountId}@test.local`})`;

      // Insert WITH organization values.
      const created = await repo.insert({
        accountId,
        name: 'org-roundtrip',
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
        folder: 'EU accounts',
        tags: ['retail', 'warmup'],
      });
      expect(created.folder).toBe('EU accounts');
      // The load-bearing assertion: an ARRAY back, not a JSON string.
      expect(Array.isArray(created.tags)).toBe(true);
      expect(created.tags).toEqual(['retail', 'warmup']);

      // Re-read through findById (separate SELECT round-trip).
      const fetched = await repo.findById({ id: created.id, accountId });
      expect(fetched?.tags).toEqual(['retail', 'warmup']);
      expect(fetched?.folder).toBe('EU accounts');

      // Insert WITHOUT organization values → column defaults.
      const bare = await repo.insert({
        accountId,
        name: 'org-defaults',
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
      });
      expect(bare.folder).toBeNull();
      expect(bare.tags).toEqual([]);

      // Update: exact-set tag replace + null-clears folder.
      const updated = await repo.update({
        id: created.id,
        accountId,
        updates: { folder: null, tags: ['b', 'c'] },
      });
      expect(updated.folder).toBeNull();
      expect(updated.tags).toEqual(['b', 'c']);

      // Clear tags with [].
      const cleared = await repo.update({
        id: created.id,
        accountId,
        updates: { tags: [] },
      });
      expect(cleared.tags).toEqual([]);
    });

    it('serialises N concurrent creates so exactly `limit` succeed (no over-create past the cap)', async () => {
      if (!dbReachable || !client) {
        // Local dev without DATABASE_URL: skip quietly. In CI the DB
        // service + migrate step are part of the job — an unreachable or
        // unmigrated DB must FAIL the test, not vacuous-pass (this exact
        // silent skip hid a from-birth Date-bind crash in every one of
        // these tests until 2026-06-12).
        if (process.env.CI) {
          throw new Error(
            'real-PG keyset test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`limit-prof-${accountId}@test.local`})`;

      // Fire N concurrent creates against a cap of 1, each with a DISTINCT name
      // (so the unique index is NOT the limiter — only the tier cap is). Without
      // the FOR UPDATE lock all N read count=0 and all insert (the TOCTOU); the
      // account-row lock serialises them so exactly `LIMIT` win.
      const LIMIT = 1;
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          repo.insertWithLimit(
            {
              accountId,
              name: `limit-prof-${i.toString()}`,
              archetype: 'iphone16pro_ios18_7_safari26_4',
              description: null,
            },
            LIMIT,
          ),
        ),
      );
      const accepted = results.filter((r) => 'record' in r);
      const refused = results.filter((r) => 'limitExceeded' in r);
      expect(accepted).toHaveLength(LIMIT);
      expect(refused).toHaveLength(N - LIMIT);

      // The DB agrees: exactly LIMIT rows exist for the account.
      const countRows = await client`
        SELECT count(*)::int AS n FROM profiles WHERE account_id = ${accountId}`;
      expect(countRows[0]?.n).toBe(LIMIT);
    });

    // doc-150 item 6 — sumSizeBytesByAccount over a REAL Postgres: COALESCE
    // NULL→0, excludes trashed (notDeleted), scoped to the account. The
    // in-memory repo + service tests cover the math; this pins the actual
    // COALESCE(sum(...))::bigint SQL + the notDeleted filter on the driver.
    // ── V-1194 — the soft-delete axis. `notDeleted` is one shared const used at nine
    // sites; neutralising it fired eight assertions, so the exclusion is well covered for
    // update / delete / restore / transfer / sumSizeBytes. Neutralising ONLY the five sites
    // those assertions did not name left all 3,278 integration tests green. These four are
    // the reachable ones.

    it('CRITICAL countByAccount excludes trashed profiles. Trashing is the documented way to free a slot — the repo comment beside it says trashed profiles do not count toward the quota — so if they still counted, a customer who trashed a profile to make room would be refused anyway, and nothing would say why.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG trashed-count test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`cnt-${accountId}@test.local`})`;
      const base = { archetype: 'iphone17_ios18_7_safari26_4', description: null };

      const live = await repo.insert({ accountId, name: 'live', ...base });
      const gone = await repo.insert({ accountId, name: 'gone', ...base });
      expect(await repo.countByAccount(accountId), 'both profiles should count while live').toBe(2);

      expect(await repo.delete({ id: gone.id, accountId }), 'the trash call did not take').toBe(
        true,
      );
      expect(
        await repo.countByAccount(accountId),
        'a trashed profile still counted toward the cap, so trashing frees nothing',
      ).toBe(1);
      void live;
    });

    it('CRITICAL list excludes trashed profiles. `listTrashed` is a separate read for the recycle bin, so a trashed row appearing in the live grid is not a cosmetic slip — it is the same profile shown in two places with two different meanings.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG trashed-list test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`lst-${accountId}@test.local`})`;
      const base = { archetype: 'iphone17_ios18_7_safari26_4', description: null };

      const live = await repo.insert({ accountId, name: 'live-one', ...base });
      const gone = await repo.insert({ accountId, name: 'gone-one', ...base });
      const second = await repo.insert({ accountId, name: 'live-two', ...base });
      const third = await repo.insert({ accountId, name: 'live-three', ...base });
      await repo.delete({ id: gone.id, accountId });

      // Ordering is (created_at desc, id desc) and these four rows are inserted in the
      // same instant, so without explicit timestamps the trashed row lands anywhere and
      // the cursor branch may never be asked to exclude it. Pin the order so `gone` is
      // deterministically ON page 2.
      for (const [p, offset] of [
        [third, 0],
        [second, 1],
        [gone, 2],
        [live, 3],
      ] as const) {
        await client`UPDATE profiles SET created_at = now() - ${`${offset} seconds`}::interval
                     WHERE id = ${p.id}`;
      }

      // The CURSOR branch builds its own WHERE, so an unpaged check leaves it
      // untested — the two branches carry the notDeleted filter separately.
      const page1 = await repo.list({ accountId, limit: 2 });
      expect(
        page1.data.map((r) => r.id),
        'page 1 leaked the trashed profile',
      ).not.toContain(gone.id);
      expect(page1.nextCursor, 'no second page to test the cursor branch with').not.toBeNull();
      const page2 = await repo.list({ accountId, limit: 2, cursor: page1.nextCursor ?? undefined });
      expect(
        page2.data.map((r) => r.id),
        'a cursor-paged read leaked the trashed profile',
      ).not.toContain(gone.id);
      expect(
        [...page1.data, ...page2.data].map((r) => r.id),
        'the paged reads never returned the later live rows, so the cursor branch did nothing',
      ).toEqual(expect.arrayContaining([second.id, third.id]));

      const ids = (await repo.list({ accountId })).data.map((r) => r.id);
      expect(ids, 'the live profile is missing — the check below would prove nothing').toContain(
        live.id,
      );
      expect(ids, 'a trashed profile appeared in the live listing').not.toContain(gone.id);
      expect(
        (await repo.listTrashed({ accountId })).map((r) => r.id),
        'the trashed profile is not in the recycle bin either, so the fixture never trashed',
      ).toContain(gone.id);
    });

    it('CRITICAL touch and recordSave are no-ops on a trashed profile. The repo says so beside recordSave — scoped and notDeleted like touch, a no-op for a wrong-account or trashed id — and a write that lands on a trashed row revives its usage timestamps and size while the customer believes it is in the bin.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG trashed-write test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`tch-${accountId}@test.local`})`;
      const base = { archetype: 'iphone17_ios18_7_safari26_4', description: null };

      const gone = await repo.insert({ accountId, name: 'trashed-writes', ...base });
      await repo.delete({ id: gone.id, accountId });

      // Positive control: a LIVE profile does accept both writes, so a repo that
      // silently wrote nothing at all could not satisfy the assertions below.
      const live = await repo.insert({ accountId, name: 'live-writes', ...base });
      await repo.touch({ id: live.id, accountId, at: new Date() });
      await repo.recordSave({ id: live.id, accountId, at: new Date(), sizeBytes: 4242 });
      const [liveRow] = await client<{ last_used_at: Date | null; size_bytes: string | null }[]>`
        SELECT last_used_at, size_bytes FROM profiles WHERE id = ${live.id}`;
      expect(liveRow?.last_used_at, 'a live profile did not accept touch').not.toBeNull();
      // size_bytes is a bigint; postgres-js hands it back as a string.
      expect(Number(liveRow?.size_bytes), 'a live profile did not accept recordSave').toBe(4242);

      await repo.touch({ id: gone.id, accountId, at: new Date() });
      await repo.recordSave({ id: gone.id, accountId, at: new Date(), sizeBytes: 9999 });
      const [goneRow] = await client<{ last_used_at: Date | null; size_bytes: string | null }[]>`
        SELECT last_used_at, size_bytes FROM profiles WHERE id = ${gone.id}`;
      expect(goneRow?.last_used_at, 'touch landed on a trashed profile').toBeNull();
      expect(goneRow?.size_bytes, 'recordSave landed on a trashed profile').toBeNull();
    });

    it('sumSizeBytesByAccount: COALESCE NULL→0, account-scoped, excludes trashed', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG sumSizeBytes test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      seeded.push(accountId, otherAccountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`sum-${accountId}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${otherAccountId}, ${`sum-${otherAccountId}@test.local`})`;

      const base = {
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
      };
      const sized = await repo.insert({ accountId, name: 'sized', ...base });
      const unsaved = await repo.insert({ accountId, name: 'unsaved', ...base }); // size NULL → 0
      const trashed = await repo.insert({ accountId, name: 'trashed', ...base });
      const otherAcct = await repo.insert({ accountId: otherAccountId, name: 'other', ...base });

      await repo.recordSave({ id: sized.id, accountId, at: new Date(), sizeBytes: 5000 });
      await repo.recordSave({ id: trashed.id, accountId, at: new Date(), sizeBytes: 9999 });
      await repo.recordSave({
        id: otherAcct.id,
        accountId: otherAccountId,
        at: new Date(),
        sizeBytes: 7777,
      });
      // Trash the 9999-byte profile → it must drop out of the live sum.
      await repo.delete({ id: trashed.id, accountId });

      // 5000 (sized) + 0 (unsaved NULL) ; trashed + other-account excluded.
      const total = await repo.sumSizeBytesByAccount(accountId);
      expect(total).toBe(5000);
      expect(unsaved.sizeBytes).toBeNull();

      // An account with zero profiles sums to 0 (COALESCE, not NULL).
      const emptyAccountId = randomUUID();
      seeded.push(emptyAccountId);
      await client`INSERT INTO accounts (id, email) VALUES (${emptyAccountId}, ${`sum-empty-${emptyAccountId}@test.local`})`;
      expect(await repo.sumSizeBytesByAccount(emptyAccountId)).toBe(0);
    });

    // ── update(): a partial patch, on the customer's own filing ─────────
    // `update` has NO test references anywhere in the tree — not a mock, not a
    // double. It patches six fields, two of which (folder, tags) ARE the
    // customer's organisation of their profiles: losing them un-files
    // everything, and nothing errors while it happens.
    //
    // Precise about what holds that, because the same shape misled me on the
    // webhook-endpoint patch: deleting the `!== undefined` guards does NOT
    // reproduce a wipe, since drizzle's `.set()` skips undefined values anyway.
    // The shape that DOES is a defaulting coalesce (`args.updates.tags ?? []`),
    // which is how this bug actually arrives. These arms pin the OUTCOME.

    it('CRITICAL updating one field leaves the customer’s filing intact', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`upd-${accountId}@test.local`})`;

      const created = await repo.insert({
        accountId,
        name: 'original',
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
      });
      await repo.update({
        id: created.id,
        accountId,
        updates: { folder: 'work', tags: ['banking', 'eu'], note: 'keep me' },
      });

      const renamed = await repo.update({
        id: created.id,
        accountId,
        updates: { name: 'renamed' },
      });
      expect(renamed.name).toBe('renamed');
      expect(
        renamed.folder,
        'renaming a profile un-filed it. Nothing errors when this happens — the customer sees a ' +
          'successful save and their organisation quietly gone',
      ).toBe('work');
      expect(renamed.tags, 'renaming a profile dropped its tags').toEqual(['banking', 'eu']);
      expect(renamed.note).toBe('keep me');
    });

    it('CRITICAL another account cannot edit this profile', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const mine = randomUUID();
      const theirs = randomUUID();
      seeded.push(mine, theirs);
      await client`INSERT INTO accounts (id, email) VALUES (${mine}, ${`upd-a-${mine}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${theirs}, ${`upd-b-${theirs}@test.local`})`;
      const created = await repo.insert({
        accountId: mine,
        name: 'mine',
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
      });

      // Refused by throwing rather than returning null — pinned as-is so the
      // caller's error mapping is not silently changed underneath it.
      await expect(
        repo.update({ id: created.id, accountId: theirs, updates: { name: 'stolen' } }),
        'one customer renamed another customer’s profile',
      ).rejects.toThrow();
      const [row] = await client`SELECT name FROM profiles WHERE id = ${created.id}`;
      expect(row?.name).toBe('mine');
    });

    it('CRITICAL a trashed profile cannot be edited', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`upd-t-${accountId}@test.local`})`;
      const created = await repo.insert({
        accountId,
        name: 'to-trash',
        archetype: 'iphone17_ios18_7_safari26_4',
        description: null,
      });
      expect(await repo.delete({ id: created.id, accountId })).toBe(true);

      // notDeleted is in the predicate: a row in the recycle bin is a tombstone,
      // so an edit must not quietly resurrect or mutate it behind the deletion.
      await expect(
        repo.update({ id: created.id, accountId, updates: { name: 'edited-after-trash' } }),
        'a trashed profile was edited — the recycle bin is supposed to be terminal until restore',
      ).rejects.toThrow();
    });
  },
);
