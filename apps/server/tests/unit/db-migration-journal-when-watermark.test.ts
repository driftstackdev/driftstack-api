// V-751 — the migration journal's `when` values are a WATERMARK, not decoration.
//
// drizzle's pg migrator (node_modules/drizzle-orm/pg-core/dialect.js) reads the
// last-applied row ONCE, before the loop:
//
//     select ... from drizzle.__drizzle_migrations order by created_at desc limit 1
//     for await (const migration of migrations) {
//       if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { apply }
//     }
//
// Two consequences, both verified empirically against throwaway databases:
//
//  • FRESH database — `lastDbMigration` is undefined, so `!lastDbMigration` short-circuits
//    and EVERY entry applies regardless of its `when`. Confirmed: a fresh DB + the full
//    journal applies all 112 migrations and yields 52 public tables. This is what CI does
//    (ci.yml runs `npm run db:migrate -w apps/server` against a fresh postgres:17-alpine),
//    which is why a `when` anomaly is invisible to CI.
//
//  • ALREADY-MIGRATED database — the gate is `max(created_at) < when`. So any entry whose
//    `when` does not EXCEED the highest `when` already recorded is silently skipped.
//    Confirmed: a DB migrated to 0021 only (recorded max 1778909000000) then re-migrated
//    with the full journal skips 0022-0057 entirely and then THROWS on a later migration
//    that depends on their tables — reporting "Failed query" against the wrong migration.
//
// `0021_scheduled_jobs` carries a hand-typed `when` of 1778909000000, roughly 9 days
// ahead of its neighbours, which is why entries 0022-0057 sit below it. They applied
// correctly on every real database because those were migrated fresh, and rewriting
// history now would be worse than recording it — so that set is pinned as a known
// historical anomaly rather than "fixed".
//
// What this guard is FOR is the next migration. Every migration in this repo is
// hand-authored (drizzle-kit generate is broken here — see the TD-002 proposal), so `when`
// is hand-typed every single time. A new entry authored at or below the running maximum
// would be silently skipped on prod and staging while passing CI green, and would surface
// later as a failed deploy blaming an unrelated migration. Nothing else in the suite
// catches that.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '..', '..', 'src', 'db', 'migrations');

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(resolve(MIGRATIONS, 'meta', '_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
  return parsed.entries ?? [];
}

/**
 * Entries whose `when` fails to exceed the highest `when` of everything before them —
 * i.e. exactly the entries drizzle would SKIP on an already-migrated database.
 */
function belowRunningMax(entries: readonly JournalEntry[]): number[] {
  const skipped: number[] = [];
  let runningMax = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    if (e.when > runningMax) runningMax = e.when;
    else skipped.push(e.idx);
  }
  return skipped;
}

/**
 * The 0021 watermark fallout: 0022-0057 sit below `0021_scheduled_jobs`'s hand-typed
 * 1778909000000. Frozen deliberately — these applied on every real (fresh) database, and
 * editing historical `when` values cannot repair an existing DB anyway, because the
 * poisoned value is already recorded in its __drizzle_migrations table.
 */
const KNOWN_HISTORICAL_ANOMALY = Array.from({ length: 36 }, (_, i) => 22 + i);

describe('migration journal `when` watermark (V-751)', () => {
  it('CRITICAL no NEW migration sits at or below the running max — that one is skipped on every already-migrated database while CI stays green', () => {
    const entries = journal();
    expect(entries.length).toBeGreaterThan(100);

    const skipped = belowRunningMax(entries);
    const unexpected = skipped.filter((idx) => !KNOWN_HISTORICAL_ANOMALY.includes(idx));

    expect(
      unexpected,
      'migration(s) whose `when` does not exceed every earlier `when`. drizzle gates on ' +
        '`max(created_at) < when`, so each of these is SILENTLY SKIPPED on prod/staging ' +
        '(already migrated) while applying fine in CI (fresh DB). Raise the `when` above ' +
        `the current head (${Math.max(...entries.map((e) => e.when))}).`,
    ).toEqual([]);
  });

  it('CRITICAL the historical anomaly set has not grown — it is 0022-0057 and nothing else', () => {
    // Pinned both ways: a new violation must not be absorbed into the allowlist, and a
    // future repair that legitimately shrinks it must update this expectation on purpose.
    expect(belowRunningMax(journal())).toEqual(KNOWN_HISTORICAL_ANOMALY);
  });

  it('the newest entry carries the highest `when`, so appending a migration cannot land under the head', () => {
    const entries = journal();
    const last = entries[entries.length - 1];
    expect(last).toBeDefined();
    expect(last?.when).toBe(Math.max(...entries.map((e) => e.when)));
  });

  it('every .sql file has a journal entry and every entry has a .sql file', () => {
    const entries = journal();
    const sqlTags = new Set(
      readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => f.slice(0, -4)),
    );
    const journalTags = new Set(entries.map((e) => e.tag));
    // A .sql with no entry never runs; an entry with no .sql throws at migrate time.
    expect(
      [...sqlTags].filter((t) => !journalTags.has(t)),
      'sql files missing from the journal',
    ).toEqual([]);
    expect(
      [...journalTags].filter((t) => !sqlTags.has(t)),
      'journal entries with no sql file',
    ).toEqual([]);
  });

  it('idx values are unique, ascending, and contiguous from 0 — the migrator applies in array order', () => {
    const entries = journal();
    const idxs = entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
    expect(idxs[0]).toBe(0);
    expect(idxs[idxs.length - 1]).toBe(idxs.length - 1);
  });
});
