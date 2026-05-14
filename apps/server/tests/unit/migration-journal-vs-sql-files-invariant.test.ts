// W849 — migration journal vs SQL files count invariant. One-
// hundred-seventy-fifth in the drift-guard series. Pins that the
// apps/server/src/db/migrations/meta/_journal.json entry count
// equals the SQL file count + entry indices are 0..N-1 monotonic.
// Defense against V-228-class regressions structurally (per V-231
// pre-push hook coordination).
//
// drizzle-kit can only apply migrations whose SQL file matches a
// journal entry. Drift (SQL file without journal entry, or extra
// journal entry without SQL file) would either:
//   - Silently skip the migration (data integrity bug).
//   - Cause drizzle-kit migrate to fail at deploy time (outage).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

describe('W849 migration journal vs SQL files invariant', () => {
  const migrationsDir = resolve(REPO_ROOT, 'apps/server/src/db/migrations');
  const journalPath = resolve(migrationsDir, 'meta/_journal.json');

  it('migrations dir + journal exist at canonical paths', () => {
    expect(existsSync(migrationsDir)).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  // ─── Journal shape ────────────────────────────────────────────

  it("CRITICAL _journal.json declares version='7' + dialect='postgresql'. Drizzle-kit schema version 7 is what 'drizzle-kit generate' currently produces — drift to a different version (e.g. on Drizzle major upgrade) would require coordinated schema migration.", () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    expect(j.version, '_journal.json version must be 7').toBe('7');
    expect(j.dialect, '_journal.json dialect must be postgresql').toBe('postgresql');
  });

  // ─── Entry count == SQL file count ────────────────────────────

  it('CRITICAL the number of journal entries EXACTLY equals the number of SQL files in apps/server/src/db/migrations/. Drift would either silently skip a migration (data integrity bug) or break drizzle-kit migrate at deploy (outage). This is the same invariant V-231 pre-push hook enforces — pinned here as a structural backstop.', () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(j.entries.length, `entries=${j.entries.length} vs SQL files=${sqlFiles.length}`).toBe(
      sqlFiles.length,
    );
  });

  // ─── Every entry tag has a matching SQL file ──────────────────

  it('CRITICAL every journal entry tag has a corresponding <tag>.sql file. Drift to a journal entry without SQL file would cause drizzle-kit migrate to fail at runtime.', () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    const sqlFiles = new Set(
      readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => f.replace(/\.sql$/, '')),
    );
    for (const entry of j.entries) {
      expect(sqlFiles.has(entry.tag), `journal tag '${entry.tag}' has no matching SQL file`).toBe(
        true,
      );
    }
  });

  // ─── Every SQL file has a matching journal entry ──────────────

  it('CRITICAL every SQL file has a corresponding journal entry tag. Drift to a SQL file without journal entry would silently skip the migration at deploy time — exactly the V-228 regression V-231 pre-push hook defends against.', () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    const journalTags = new Set(j.entries.map((e) => e.tag));
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    for (const sql of sqlFiles) {
      const tag = sql.replace(/\.sql$/, '');
      expect(journalTags.has(tag), `SQL file '${sql}' has no matching journal entry`).toBe(true);
    }
  });

  // ─── Entry indices are 0..N-1 monotonic ──────────────────────

  it('CRITICAL journal entry indices form a 0..N-1 monotonic sequence (no gaps, no duplicates). Drift to a gap would mean a migration was deleted from the journal but not the SQL file (or vice versa). Drift to a duplicate would let drizzle-kit apply a migration twice.', () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    const indices = j.entries.map((e) => e.idx).sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i], `expected idx=${i} at position ${i} but got ${indices[i]}`).toBe(i);
    }
  });

  // ─── breakpoints field present on every entry ─────────────────

  it('CRITICAL every journal entry has breakpoints:true (drizzle-kit default — enables single-statement transactional safety). Drift to false would let multi-statement migrations partially-apply on failure.', () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    for (const entry of j.entries) {
      expect(entry.breakpoints, `entry idx=${entry.idx} breakpoints must be true`).toBe(true);
    }
  });

  // ─── Entry tag naming convention ──────────────────────────────

  it("CRITICAL journal entry tag follows the convention '<4-digit-idx>_<descriptive-slug>' (e.g. '0000_gray_northstar'). Drift to a different convention would break grep-by-tag tooling.", () => {
    const j = JSON.parse(read(journalPath)) as Journal;
    for (const entry of j.entries) {
      expect(entry.tag, `entry idx=${entry.idx} tag must match <NNNN>_<slug>`).toMatch(
        /^[0-9]{4}_[a-z0-9_]+$/,
      );
    }
  });

  // ─── V-231 pre-push hook coordination ─────────────────────────

  it('CRITICAL .husky/pre-push declares the V-231 migration-journal-sync check. This test + the hook together implement defense-in-depth — the hook catches journal-vs-SQL mismatches before push; this test catches them at test time.', () => {
    const hook = read(resolve(REPO_ROOT, '.husky/pre-push'));
    expect(hook).toMatch(/V-231/);
    expect(hook).toMatch(/migration journal/i);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/migration-journal-vs-sql-files-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
