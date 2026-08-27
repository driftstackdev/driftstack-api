// `SessionOperationsRepo.settle` is a terminal compare-and-set gated on
// `inArray(status, [...LIVE_STATUSES])`. Its own comment records why that set is
// {queued, running} rather than {running}: the design doc originally said
// `running` alone, "which cannot expire an operation that never started — a
// queued operation past its deadline would have been unsettleable forever."
//
// That bug is fixed. Nothing stops it recurring. The existing parity guard pins
// `LIVE_STATUSES = ['queued', 'running']` verbatim in the repo AND the partial
// index predicate in the DDL — so the CONSTANT cannot drift unnoticed. But a
// pin freezes a value, not a relationship: adding a seventh status to the CHECK
// and the `$type` union leaves every existing assertion green while the new
// status is neither live nor classified, and an operation in it can never be
// settled. Same shape, same consequence, new spelling.
//
// So this asserts the RELATIONSHIP the CAS depends on rather than the values:
// the four declarations of the status set agree, and LIVE plus TERMINAL exactly
// exhausts it. A new status fails here until somebody decides which side it is
// on — which is the decision the original bug skipped.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

const MIGRATION = 'apps/server/src/db/migrations/0108_session_operations.sql';
const SCHEMA = 'apps/server/src/db/schema.ts';
const REPO = 'apps/server/src/db/session-operations-repo.ts';

/** Terminal statuses, enumerated WITH the reason each is terminal. */
const TERMINAL: ReadonlyArray<readonly [string, string]> = [
  ['succeeded', 'the operation completed and its result is stored'],
  ['failed', 'the operation completed and its error is stored'],
  ['cancelled', 'the caller withdrew it before completion'],
  ['expired', 'its caller-supplied deadline passed before it settled'],
];

function quoted(source: string, re: RegExp): string[] {
  const m = re.exec(source);
  if (m === null) return [];
  return [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
}

function checkConstraintStatuses(): string[] {
  return quoted(
    read(MIGRATION),
    /CONSTRAINT "session_operations_status" CHECK \(\s*"status" IN \(([^)]*)\)/,
  );
}

function drizzleTypeStatuses(): string[] {
  // ANCHOR on the table. `status: text('status')` appears in many tables in
  // schema.ts, and an unanchored match silently returned another table's union
  // — caught on the first run by the non-vacuity arm below, which is why that
  // arm asserts a COUNT rather than merely a non-empty set.
  return quoted(
    read(SCHEMA),
    /sessionOperations = pgTable\([\s\S]*?status: text\('status'\)[\s\S]{0,120}?\.\$type<([^>]*)>/,
  );
}

function exportedUnionStatuses(): string[] {
  return quoted(read(REPO), /export type SessionOperationStatus =([\s\S]*?);/);
}

function liveStatuses(): string[] {
  return quoted(read(REPO), /const LIVE_STATUSES = \[([^\]]*)\]/);
}

describe('session-operation status: the CAS partition, not just its values', () => {
  it('CRITICAL every declaration of the status set found a real set — the arms below are not vacuous', () => {
    // Each extractor returns [] on a regex that stopped matching, and [] would
    // make every set comparison below trivially agree.
    expect(checkConstraintStatuses().length, 'DB CHECK constraint').toBe(6);
    expect(drizzleTypeStatuses().length, 'Drizzle $type union').toBe(6);
    expect(exportedUnionStatuses().length, 'SessionOperationStatus').toBe(6);
    expect(liveStatuses().length, 'LIVE_STATUSES').toBe(2);
  });

  it('CRITICAL all four declarations of the status set agree', () => {
    const check = [...checkConstraintStatuses()].sort();
    expect([...drizzleTypeStatuses()].sort(), 'Drizzle $type vs DB CHECK').toEqual(check);
    expect([...exportedUnionStatuses()].sort(), 'SessionOperationStatus vs DB CHECK').toEqual(
      check,
    );
    expect(check).toEqual([...liveStatuses(), ...TERMINAL.map(([s]) => s)].sort());
  });

  it('CRITICAL LIVE and TERMINAL partition the set — a new status settles nowhere until classified', () => {
    const all = new Set(checkConstraintStatuses());
    const live = liveStatuses();
    const terminal = TERMINAL.map(([s]) => s);
    expect(
      live.filter((s) => terminal.includes(s)),
      'a status cannot be both',
    ).toEqual([]);
    const unclassified = [...all].filter((s) => !live.includes(s) && !terminal.includes(s)).sort();
    expect(
      unclassified,
      'these statuses are neither live nor terminal, so settle() can never reach them — ' +
        'the exact defect fixed when LIVE_STATUSES stopped being {running} alone',
    ).toEqual([]);
  });

  it('queued is LIVE — the regression this file exists for', () => {
    // Not redundant with the partition arm: queued could be classified TERMINAL
    // and still partition cleanly, while silently restoring the original bug.
    expect(liveStatuses()).toContain('queued');
    expect(liveStatuses()).toContain('running');
  });
});
