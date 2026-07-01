// Regression tests for scripts/migration-immutability-check.mjs's runChecks()
// — the pure, DB-free comparison logic that decides whether a deploy may
// proceed. The script itself has no DB-integration test (out of this repo's
// vitest boundary — apps/server/src/db/ is exercised by e2e, not vitest); this
// covers the pure decision logic with synthetic journal/hash/applied-row data.
//
// Check 1 regression: a same-count content SWAP between two already-applied
// migration files (tags/filenames unchanged) used to pass a pure
// hash-membership-in-a-set test, because each swapped hash still matched SOME
// current file (just the wrong one). Binding each applied row to its
// journal-ordinal tag (this fix) catches it.

import { describe, expect, it } from 'vitest';
import { runChecks } from '../migration-immutability-check.mjs';

function journalEntry(idx: number, tag: string, when: number) {
  return { idx, tag, when, version: '7', breakpoints: true };
}

function appliedRow(id: number, hash: string, createdAt: number) {
  return { id, hash, createdAt };
}

describe('migration-immutability-check runChecks', () => {
  it('happy path: 2 applied migrations, hashes match their own tags, no pending — zero failures', () => {
    const journal = [journalEntry(0, '0001_a', 1000), journalEntry(1, '0002_b', 2000)];
    const sqlHashByTag = new Map([
      ['0001_a', 'HASH_A'],
      ['0002_b', 'HASH_B'],
    ]);
    const applied = [appliedRow(1, 'HASH_A', 1000), appliedRow(2, 'HASH_B', 2000)];

    expect(runChecks(journal, sqlHashByTag, applied)).toEqual([]);
  });

  it('CRITICAL regression: a same-count content SWAP between two already-applied files is caught (tag-bound comparison, not set-membership)', () => {
    const journal = [journalEntry(0, '0001_a', 1000), journalEntry(1, '0002_b', 2000)];
    // Applied rows recorded the ORIGINAL hashes at apply time.
    const applied = [appliedRow(1, 'HASH_A', 1000), appliedRow(2, 'HASH_B', 2000)];
    // But someone swapped the SQL content between the two files on disk —
    // 0001_a's file now hashes to HASH_B and 0002_b's file now hashes to
    // HASH_A. A pure "does this row's hash exist in the set of all current
    // hashes" check would see both HASH_A and HASH_B present and report zero
    // failures, even though both migrations were silently rewritten.
    const sqlHashByTag = new Map([
      ['0001_a', 'HASH_B'],
      ['0002_b', 'HASH_A'],
    ]);

    const failures = runChecks(journal, sqlHashByTag, applied);
    const swapFailures = failures.filter(
      (f) => f.check === 'applied-row-hash-not-in-current-files',
    );
    expect(swapFailures).toHaveLength(2);
    expect(swapFailures.map((f) => f.tag).sort()).toEqual(['0001_a', '0002_b']);
  });

  it('single genuinely-tampered file (hash matches nothing current) still fails Check 1', () => {
    const journal = [journalEntry(0, '0001_a', 1000)];
    const applied = [appliedRow(1, 'HASH_ORIGINAL', 1000)];
    const sqlHashByTag = new Map([['0001_a', 'HASH_TAMPERED']]);

    const failures = runChecks(journal, sqlHashByTag, applied);
    const check1Failures = failures.filter(
      (f) => f.check === 'applied-row-hash-not-in-current-files',
    );
    expect(check1Failures).toHaveLength(1);
    expect(check1Failures[0]).toMatchObject({
      check: 'applied-row-hash-not-in-current-files',
      tag: '0001_a',
    });
  });

  it('untampered multi-migration history with no drift produces zero failures (no false positives from the tag-bound rewrite)', () => {
    const journal = [
      journalEntry(0, '0001_a', 1000),
      journalEntry(1, '0002_b', 2000),
      journalEntry(2, '0003_c', 3000),
    ];
    const sqlHashByTag = new Map([
      ['0001_a', 'H1'],
      ['0002_b', 'H2'],
      ['0003_c', 'H3'],
    ]);
    const applied = [
      appliedRow(1, 'H1', 1000),
      appliedRow(2, 'H2', 2000),
      appliedRow(3, 'H3', 3000),
    ];

    expect(runChecks(journal, sqlHashByTag, applied)).toEqual([]);
  });

  it('Check 2: a journal tag with no corresponding .sql file fails, independent of Check 1', () => {
    const journal = [journalEntry(0, '0001_a', 1000), journalEntry(1, '0002_missing', 2000)];
    const sqlHashByTag = new Map([['0001_a', 'H1']]);
    const applied = [appliedRow(1, 'H1', 1000)];

    const failures = runChecks(journal, sqlHashByTag, applied);
    expect(failures).toEqual([
      expect.objectContaining({ check: 'journal-tag-missing-sql-file', tag: '0002_missing' }),
    ]);
  });

  it('Check 3: a pending (not-yet-applied) journal entry with `when` at/below the watermark fails', () => {
    const journal = [journalEntry(0, '0001_a', 1000), journalEntry(1, '0002_pending', 500)];
    const sqlHashByTag = new Map([
      ['0001_a', 'H1'],
      ['0002_pending', 'H2'],
    ]);
    const applied = [appliedRow(1, 'H1', 1000)]; // 0002_pending not yet applied

    const failures = runChecks(journal, sqlHashByTag, applied);
    expect(failures).toEqual([
      expect.objectContaining({
        check: 'pending-journal-when-below-watermark',
        tag: '0002_pending',
        maxWatermark: 1000,
      }),
    ]);
  });

  it('Check 3: a pending entry with `when` above the watermark does NOT fail', () => {
    const journal = [journalEntry(0, '0001_a', 1000), journalEntry(1, '0002_pending', 1500)];
    const sqlHashByTag = new Map([
      ['0001_a', 'H1'],
      ['0002_pending', 'H2'],
    ]);
    const applied = [appliedRow(1, 'H1', 1000)];

    expect(runChecks(journal, sqlHashByTag, applied)).toEqual([]);
  });

  it('Check 4: more applied rows than journal entries (different-branch contamination) fails, and Check 1 does not throw on the length mismatch', () => {
    const journal = [journalEntry(0, '0001_a', 1000)];
    const sqlHashByTag = new Map([['0001_a', 'H1']]);
    const applied = [appliedRow(1, 'H1', 1000), appliedRow(2, 'H2_UNKNOWN', 2000)];

    const failures = runChecks(journal, sqlHashByTag, applied);
    expect(failures).toEqual([
      expect.objectContaining({
        check: 'applied-count-exceeds-journal-count',
        applied: 2,
        journal: 1,
      }),
    ]);
  });

  it('empty journal + empty applied — zero failures (fresh DB, no migrations yet)', () => {
    expect(runChecks([], new Map(), [])).toEqual([]);
  });
});
