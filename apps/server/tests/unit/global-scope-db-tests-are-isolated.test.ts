// A test that runs a GLOBAL database operation must have its own database.
//
// Nine repo methods migrate an encryption envelope by scanning their whole
// table, and six purge paths select-and-delete by cutoff across every account.
// None takes an account scope. Against a shared Postgres their behaviour
// depends on rows owned by whichever other test file happens to be running —
// and, for the purges, they DELETE those rows.
//
// That produced four separate incidents with three different mechanisms: an
// unconvertible secret made a sweep throw; a syntactically-v2 fixture made a key
// probe throw; a raw-SQL agent session made a transcript migration reject
// plaintext; and an agent-session purge deleted a receipt test's rows through
// ON DELETE CASCADE. Each was first "fixed" by changing a fixture, and each
// fixture fix left the next mechanism reachable — a row is always in exactly one
// of a sweep's two sets, so no value is invisible to both.
//
// Isolation removes the shared state instead of negotiating with it. This guard
// exists so the NEXT such test cannot quietly rejoin the shared database: the
// cost of getting it wrong is an intermittent failure in an unrelated file,
// which is the most expensive kind of test failure there is.
//
// The roster of global operations is derived from the repo sources by naming
// pattern rather than hand-listed, so a new sibling added with the established
// name is covered the day it lands rather than the day someone remembers.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_SRC = resolve(HERE, '..', '..', 'src', 'db');
const INTEGRATION = resolve(HERE, '..', 'integration');
const E2E = resolve(HERE, '..', 'e2e');

/**
 * Names of repo operations that act on a WHOLE TABLE with no account scope.
 *
 * Derived from the sources: envelope migrations (`migrate*Envelopes`,
 * `encryptLegacySecrets`) and retention paths that select or delete by cutoff
 * (`*ForTerminatedAccountsBefore`, `findDeletedAccountIds*Before`,
 * `purgeTrashedBefore`).
 */
function globalOperations(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(REPO_SRC)) {
    if (!entry.endsWith('.ts')) continue;
    const src = readFileSync(resolve(REPO_SRC, entry), 'utf8');
    for (const m of src.matchAll(
      /\b(migrate\w*Envelopes|encryptLegacySecrets|\w*ForTerminatedAccountsBefore|findDeletedAccountIds\w*Before|purgeTrashedBefore)\s*\(/g,
    )) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFilesUnder(full));
    // e2e specs use .spec.ts; both are included so the guard's reach is
    // "any real-Postgres test", not "one directory". e2e is not exposed today —
    // `buildApp` carries none of the nine migrations and the harness never
    // calls `createProductionDeps` — but a guard whose scope is narrower than
    // the property it claims is the same defect it exists to catch.
    else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

interface Offender {
  readonly file: string;
  readonly operation: string;
}

/**
 * Real-Postgres integration files — the only ones that can collide, since a
 * file using fakes shares nothing.
 *
 * Shared with the vacuity case below deliberately. An earlier draft had that
 * case re-implement this scan inline, so breaking the real one left it green: a
 * mirror test asserting the mirror, which is exactly the trap this suite keeps
 * finding elsewhere.
 */
function realPostgresFiles(): string[] {
  return [...testFilesUnder(INTEGRATION), ...testFilesUnder(E2E)].filter((f) => {
    const src = readFileSync(f, 'utf8');
    // Integration files open their own connection; e2e specs never do — they
    // boot a server through the harness, which owns the connection. Detecting
    // only `postgres(` silently excluded all 28 e2e specs, so the first version
    // of this widening matched nothing and would have shipped as decoration.
    return src.includes('postgres(') || src.includes('helpers/server');
  });
}

/** Real-Postgres test files that call a global operation without isolating. */
function unisolatedCallers(): Offender[] {
  const ops = globalOperations();
  const out: Offender[] = [];
  for (const file of realPostgresFiles()) {
    const src = readFileSync(file, 'utf8');
    if (src.includes('ensureIsolatedDatabase')) continue;
    for (const op of ops) {
      if (src.includes(op))
        out.push({ file: file.slice(resolve(HERE, '..').length + 1), operation: op });
    }
  }
  return out;
}

describe('global-scope database tests run against their own database', () => {
  it('CRITICAL the roster of global operations was actually derived. An empty list would make the check below vacuously true — and the failure it guards is an absence, so a broken derivation would hide the same thing twice.', () => {
    const ops = globalOperations();
    expect(ops.length, 'global operations found in the repo sources').toBeGreaterThan(8);
    expect(ops, 'a known envelope sweep must survive the derivation').toContain(
      'encryptLegacySecrets',
    );
    expect(ops, 'and a known retention purge').toContain('findDeletedAccountIdsWithByokKeyBefore');
  });

  it('CRITICAL the scan sees real integration files, so "no offenders" means checked rather than not looked.', () => {
    const files = realPostgresFiles();
    expect(files.length, 'real-Postgres integration files').toBeGreaterThan(30);
    expect(
      files.filter((f) => readFileSync(f, 'utf8').includes('ensureIsolatedDatabase')).length,
      'files already isolated',
    ).toBeGreaterThan(10);
  });

  it('CRITICAL no real-Postgres test calls a global operation on the shared database. Such a test reads — and for the purges DELETES — rows belonging to other files, and the failure surfaces in the OTHER file, which is why this class cost four incidents before it was named.', () => {
    const offenders = unisolatedCallers()
      .map((o) => `${o.file} calls ${o.operation}`)
      .sort();
    expect(
      offenders,
      'test file(s) running a whole-table operation against the shared database — use ensureIsolatedDatabase:',
    ).toEqual([]);
  });
});
