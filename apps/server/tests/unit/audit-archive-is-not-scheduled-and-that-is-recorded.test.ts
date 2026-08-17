// The audit archive is built, tested, and NOT running in production.
//
// AuditArchiveService bounds five tables on a 90-day window. Nothing constructs
// it: `grep AuditArchiveService apps/server/src` outside its own module returns
// comments only, it is absent from EXPECTED_RECURRING_JOB_TYPES, and
// db/audit-archive-repo.ts still says "monthly cron-driven service
// (deployment-time scheduler; not in this commit)". So the chain-liveness gauge
// cannot report it dead — a chain that was never armed emits no series at all.
//
// That is a deliberate state, not an oversight to fix in passing: archiveTable
// DELETES production rows after an R2 upload, and the end-to-end test's own
// header says to wire it against a staging dataset first. Scheduling it needs R2
// configuration and a staged rollout. This file does not schedule it. It records
// that it is not scheduled, and what that costs, so the gap stops being
// invisible.
//
// What it costs, specifically. Four of the five tables are also reached by other
// means or grow slowly. `session_events` is not:
//
//   • it has ON DELETE CASCADE from sessions, so on paper it is bounded;
//   • sessions are marked-destroyed, never row-deleted — `delete(sessions)`
//     appears nowhere in the source — so the cascade never fires;
//   • the wired retention sweep (privacy.retention_scrub, V-759) anonymises
//     session_operations, sessions and keys. It does not touch session_events;
//   • the only code that deletes from session_events is the dormant archive.
//
// AUDIT_TABLES already says this in prose — "sessions are marked-destroyed
// (never row-deleted) so the cascade never fires → unbounded growth". The table
// grows for the lifetime of the deployment, and the thing that would bound it
// has never run. Two recent fixes landed on this path (the bind-parameter
// ceiling in deleteRowsById, and indexes on the retention predicates); both are
// prerequisites for it ever running safely, and neither made it run.
//
// If you wire it: delete this file in the same commit. The arms below are
// written to fail the moment it becomes scheduled, so the record cannot outlive
// the fact.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Source text with line comments stripped, so prose mentions do not count. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the audit archive is dormant, and that is recorded rather than assumed', () => {
  it('CRITICAL it is still not constructed anywhere in production source', () => {
    // The moment this fails, the archive is being wired — which is good news and
    // means this whole file should go, along with the record it carries.
    const constructed = walk(SRC)
      .filter((f) => !f.endsWith('services/audit-archive.ts'))
      .filter((f) => /new AuditArchiveService\s*\(/.test(code(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(
      constructed,
      'AuditArchiveService is now constructed in production source. If it is being scheduled, ' +
        'delete this file in the same commit — its whole purpose is to record that it was NOT ' +
        'running, and a stale record is worse than none',
    ).toEqual([]);
  });

  it('CRITICAL no recurring job type claims the archive, so nothing monitors its absence', () => {
    // job-chain-liveness reports a dead chain as 0 rather than an absent series —
    // but only for chains on its roster. An unregistered sweep is invisible to
    // it, which is exactly why this needs saying out loud somewhere.
    const roster = readFileSync(resolve(SRC, 'services/job-chain-liveness.ts'), 'utf8');
    expect(roster, 'the liveness roster now names an archive job — wire-up has begun').not.toMatch(
      /audit[._]archive/,
    );
  });

  it('CRITICAL session_events is still deleted by nothing but the dormant archive', () => {
    // The consequence that makes this worth recording. If a new pruner appears,
    // this fails and whoever added it updates the record — the table may now be
    // bounded by something else, and that changes the story.
    const deleters = walk(SRC)
      .filter((f) => /\.delete\(sessionEvents\)/.test(code(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(
      deleters,
      'the set of things that delete session_events changed. If a new sweep bounds it, this ' +
        'file’s claim that the table grows forever is out of date',
    ).toEqual(['db/audit-archive-repo.ts']);
  });

  it('CRITICAL sessions are still never row-deleted, so the cascade still never fires', () => {
    // The other half of the argument. session_events has ON DELETE CASCADE; it
    // is inert only while sessions are marked-destroyed instead of deleted.
    const deletesSessions = walk(SRC)
      .filter((f) => /\.delete\(sessions\)/.test(code(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(
      deletesSessions,
      'something now row-deletes sessions, so the session_events CASCADE fires and the table may ' +
        'no longer grow without bound — re-check whether this record still holds',
    ).toEqual([]);
  });

  it('CRITICAL the wired retention sweep still does not cover session_events', () => {
    // privacy.retention_scrub is the sweep that IS running. If it grows to cover
    // session_events, the gap closes by a different route and this file is done.
    const scrub = code(resolve(SRC, 'db/retention-scrub-repo.ts'));
    expect(
      scrub,
      'the retention scrub now references session_events — if it bounds the table, the archive ' +
        'is no longer the only thing standing between it and unbounded growth',
    ).not.toMatch(/sessionEvents/);
  });
});
