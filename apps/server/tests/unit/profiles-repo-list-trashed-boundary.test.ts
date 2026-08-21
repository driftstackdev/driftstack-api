// FIX 3 — list() cursor must NOT silently reset to page 1 when the boundary
// profile (the one whose id was the prior page's next_cursor) is soft-deleted
// or restored between page fetches.
//
// Bug: list() resolved the cursor anchor with a notDeleted filter, so a cursor
// pointing at a now-trashed profile resolved to "no anchor" → the query
// returned the FIRST page again with a non-null next_cursor (a pagination loop
// / skipped rows). A supplied cursor is a keyset POSITION on the id; it must
// advance the page whether or not the boundary row is still live.
//
// The InMemoryProfilesRepo models the prod DrizzleProfilesRepo.list keyset
// (created_at desc, id desc) including this fix (cursor anchor resolved against
// the full live+trashed set, result set still filtered to live), so this unit
// test exercises the corrected behavior without a database. The real-Postgres
// SQL path is additionally guarded in db-profiles-repo-keyset-drizzle.test.ts.

import { describe, expect, it } from 'vitest';
import { InMemoryProfilesRepo } from '../integration/_helpers/in-memory-profiles-repo.js';
import { DEFAULT_PAGE, MAX_PAGE } from '../../src/db/profiles-repo.js';

const ACC = 'acc_boundary';
const NEW = (name: string) => ({
  accountId: ACC,
  name,
  archetype: 'iphone17_ios18_7_safari26_4',
  description: null,
});

describe('FIX 3 — DrizzleProfilesRepo.list trashed-boundary cursor (in-memory model)', () => {
  it('advances the page when the next_cursor profile is trashed between fetches (no reset to page 1)', async () => {
    const repo = new InMemoryProfilesRepo();
    // Three profiles, inserted oldest→newest so list (created_at desc) returns
    // them newest-first. A tiny stagger keeps the created_at strictly ordered.
    const a = await repo.insert(NEW('a-oldest'));
    await new Promise((r) => setTimeout(r, 2));
    const b = await repo.insert(NEW('b-middle'));
    await new Promise((r) => setTimeout(r, 2));
    const c = await repo.insert(NEW('c-newest'));

    // Page 1 (limit 1) → newest profile `c`; next_cursor = c.id.
    const page1 = await repo.list({ accountId: ACC, limit: 1 });
    expect(page1.data.map((p) => p.id)).toEqual([c.id]);
    expect(page1.nextCursor).toBe(c.id);
    expect(page1.hasMore).toBe(true);

    // The boundary profile `c` is soft-deleted (trashed) before page 2 is fetched.
    expect(await repo.delete({ id: c.id, accountId: ACC })).toBe(true);

    // Page 2 with the stale cursor (c.id) MUST advance to `b` — NOT reset to the
    // newest LIVE profile. Pre-fix this returned [b] only by luck on some inputs
    // and [page-1-again] on others; the regression is the silent reset.
    const page2 = await repo.list({ accountId: ACC, limit: 1, cursor: c.id });
    expect(page2.data.map((p) => p.id)).toEqual([b.id]);
    expect(page2.nextCursor).toBe(b.id);

    // Page 3 → the oldest profile `a`, then the walk terminates.
    const page3 = await repo.list({ accountId: ACC, limit: 1, cursor: b.id });
    expect(page3.data.map((p) => p.id)).toEqual([a.id]);
    expect(page3.nextCursor).toBeNull();
    expect(page3.hasMore).toBe(false);
  });

  it('a full keyset walk skips a mid-page trashed boundary without dropping or repeating rows', async () => {
    const repo = new InMemoryProfilesRepo();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await repo.insert(NEW(`p-${i.toString()}`));
      ids.push(p.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    // ids[0] oldest … ids[4] newest. list returns newest-first.
    const expectedLiveDesc = [...ids].reverse();

    // Walk page-by-page (limit 2); trash the boundary profile right after it's
    // handed back as a next_cursor, so each subsequent fetch uses a stale cursor.
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await repo.list(
        cursor === undefined ? { accountId: ACC, limit: 2 } : { accountId: ACC, limit: 2, cursor },
      );
      // Only count still-live rows (a trashed boundary never reappears in data).
      collected.push(...page.data.map((p) => p.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      // Trash the boundary the NEXT fetch will resolve against.
      await repo.delete({ id: cursor, accountId: ACC });
    }

    // Every profile that was still live when it was paged appears exactly once,
    // in descending order, and none repeats (no reset-to-page-1 loop).
    expect(new Set(collected).size).toBe(collected.length);
    // The collected ids are a prefix-consistent subsequence of the desc order
    // (boundaries that got trashed after being returned are still in `collected`
    // because they were returned in `data` BEFORE being trashed as a cursor).
    expect(collected).toEqual(expectedLiveDesc);
  });

  // V-1244 — the page size, which the double used to restate as `Math.min(args.limit ?? 50, 100)`.
  // These arms import the repo's constants rather than naming 50 and 100, so they follow the page
  // size instead of freezing it. What they pin is the WIRING: that the double clamps to the repo's
  // MAX_PAGE and defaults to the repo's DEFAULT_PAGE, whatever those are. Proved by setting the
  // repo constant to a different number and putting the literal back in the double — the pair of
  // edits it would take to reintroduce the drift — and watching these fail.
  it('CRITICAL the double clamps an over-large page to the repo MAX_PAGE. A fixture with its own cap serves a different page size than production the moment either number moves, and every test standing on it keeps asserting the old one.', async () => {
    const repo = new InMemoryProfilesRepo();
    for (let i = 0; i < MAX_PAGE + 1; i += 1) await repo.insert(NEW(`p-${String(i)}`));

    const page = await repo.list({ accountId: ACC, limit: MAX_PAGE + 500 });
    expect(page.data.length, 'the double did not clamp to the repo page cap').toBe(MAX_PAGE);
    expect(page.hasMore, 'the clamped page did not report more to come').toBe(true);
  });

  it('CRITICAL the double falls back to the repo DEFAULT_PAGE when no limit is given. The default decides what an unparameterised list returns, so a fixture disagreeing with production means every such test measures a page size no customer ever sees.', async () => {
    const repo = new InMemoryProfilesRepo();
    for (let i = 0; i < DEFAULT_PAGE + 1; i += 1) await repo.insert(NEW(`d-${String(i)}`));

    const page = await repo.list({ accountId: ACC });
    expect(page.data.length, 'the double did not default to the repo page default').toBe(
      DEFAULT_PAGE,
    );
  });
});
