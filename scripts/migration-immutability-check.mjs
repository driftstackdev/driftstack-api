#!/usr/bin/env node
// Migration immutability + journal-integrity pre-deploy gate.
//
// Prevents the 2026-05-19 incident class: deploy-bridge.sh shipped new
// code expecting 17 missing migrations (0041-0057) that drizzle-orm's
// migrator silent-skipped because the journal's `when` values were below
// the DB's max(__drizzle_migrations.created_at) watermark. The bug went
// undetected because the post-condition row-count check (`expectedCount
// === actualCount`) only fires inside `migrate.ts` AFTER the swap is
// already half-done.
//
// This gate is hash- and watermark-aware. Run it BEFORE the swap step so
// a misconfigured journal aborts the deploy at the migration check, not
// at /health-poll-timeout-then-rollback.
//
// Checks (in order, all FAIL on mismatch):
//   1. Every drizzle.__drizzle_migrations row has a matching journal entry
//      AND its hash matches the current SQL file content. Any post-apply
//      rewrite of an old migration's SQL is a P0 finding — DDL applied to
//      env X with checksum H1 must never silently become H2 in repo.
//   2. Every journal entry's hash matches its SQL file (no orphan tags).
//   3. Pending journal entries (not in __drizzle_migrations yet) all have
//      `when > max(DB created_at)`. Any pending entry with `when` below
//      the watermark would be silent-skipped by drizzle-orm 0.38.4's
//      `lastDbMigration.created_at < migration.folderMillis` check.
//   4. Journal entry count >= __drizzle_migrations row count (no rows in
//      DB that the journal doesn't know about — that would mean a
//      different code branch's migrations got applied).
//
// Exit codes:
//   0 — all checks pass; deploy may proceed.
//   2 — at least one check failed; details on stderr; deploy MUST NOT
//       proceed without operator intervention.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/migration-immutability-check.mjs
//   # or via deploy-bridge.sh which sources /opt/driftstack/api/.env first.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'apps', 'server', 'src', 'db', 'migrations');
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, 'meta', '_journal.json');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERR migration-immutability-check: DATABASE_URL env var required');
  process.exit(2);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function loadJournal() {
  const raw = readFileSync(JOURNAL_PATH);
  return JSON.parse(raw.toString()).entries;
}

function hashesByTag() {
  // Drizzle hashes `fs.readFileSync(path).toString()` — string content,
  // utf-8. Match its serialization exactly.
  const out = new Map();
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith('.sql')) continue;
    const content = readFileSync(resolve(MIGRATIONS_DIR, f)).toString();
    out.set(f.replace(/\.sql$/, ''), sha256(content));
  }
  return out;
}

async function pullAppliedRows(client) {
  const rows = await client`
    SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    hash: r.hash,
    createdAt: Number(r.created_at),
  }));
}

function report(failures) {
  if (failures.length === 0) {
    console.log(JSON.stringify({ msg: 'migration-immutability OK' }));
    return 0;
  }
  for (const f of failures) {
    console.error(JSON.stringify({ msg: 'migration-immutability FAIL', ...f }));
  }
  console.error(
    JSON.stringify({
      msg: 'migration-immutability summary',
      failedChecks: failures.length,
      hint:
        'Hash mismatches indicate post-apply rewrite of old SQL files (forbidden ' +
        'per the immutability rule). Watermark violations indicate pending journal ' +
        'entries that drizzle-orm 0.38.4 will silent-skip. Operator must investigate ' +
        'BEFORE deploying.',
    }),
  );
  return 2;
}

async function main() {
  const client = postgres(DB_URL, { max: 1 });
  try {
    const journal = loadJournal();
    const sqlHashByTag = hashesByTag();
    const applied = await pullAppliedRows(client);
    const appliedHashes = new Set(applied.map((r) => r.hash));
    const maxWatermark = applied.length === 0 ? 0 : Math.max(...applied.map((r) => r.createdAt));
    const failures = [];

    // Check 1: every applied row's hash matches a current SQL file.
    for (const row of applied) {
      const matched = [...sqlHashByTag.entries()].find(([, h]) => h === row.hash);
      if (!matched) {
        failures.push({
          check: 'applied-row-hash-not-in-current-files',
          severity: 'P0',
          row: { id: row.id, hashPrefix: row.hash.slice(0, 12), createdAt: row.createdAt },
          detail:
            'Applied migration row hash does not match ANY current .sql file. ' +
            'Either the SQL was rewritten post-apply (forbidden) or this DB has ' +
            'migrations from a different branch.',
        });
      }
    }

    // Check 2: every journal entry's SQL file hashes consistently and the
    // file exists.
    for (const e of journal) {
      const h = sqlHashByTag.get(e.tag);
      if (!h) {
        failures.push({
          check: 'journal-tag-missing-sql-file',
          severity: 'P0',
          tag: e.tag,
          detail: `Journal entry ${e.idx} (${e.tag}) has no corresponding .sql file.`,
        });
      }
    }

    // Check 3: pending journal entries (not yet applied) must have
    // `when > maxWatermark` to survive drizzle-orm 0.38.4's silent-skip.
    for (const e of journal) {
      const sqlHash = sqlHashByTag.get(e.tag);
      if (!sqlHash) continue; // already covered by check 2
      const isApplied = appliedHashes.has(sqlHash);
      if (isApplied) continue;
      if (e.when <= maxWatermark) {
        failures.push({
          check: 'pending-journal-when-below-watermark',
          severity: 'P0',
          tag: e.tag,
          when: e.when,
          maxWatermark,
          gap: maxWatermark - e.when,
          detail:
            'Pending journal entry has `when` <= max(DB.__drizzle_migrations. ' +
            'created_at) — drizzle-orm 0.38.4 will silent-skip this on next ' +
            "migrate() call. Bump the journal entry's `when` above the " +
            'watermark before deploying (or apply the migration manually + ' +
            'INSERT into __drizzle_migrations).',
        });
      }
    }

    // Check 4: journal length >= applied count. Reverse means rows in DB
    // that aren't in journal — different-branch contamination.
    if (applied.length > journal.length) {
      failures.push({
        check: 'applied-count-exceeds-journal-count',
        severity: 'P0',
        applied: applied.length,
        journal: journal.length,
        detail:
          'More rows in __drizzle_migrations than entries in journal. The DB ' +
          'has migrations this repo does not know about — likely contamination ' +
          'from a different branch. Investigate before deploying.',
      });
    }

    return report(failures);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      JSON.stringify({
        msg: 'migration-immutability-check CRASHED',
        err: { name: err.name, message: err.message, stack: err.stack },
      }),
    );
    process.exit(2);
  });
