// `apps/server/src/db/**` is measured by neither gate, so this asserts the one
// thing that still holds it: every repo class is constructed by an integration
// test, where it runs against a real Postgres.
//
// The two exclusions are individually defensible and land in the same place.
// `vitest.config.ts` leaves `apps/server/src/db/**` out of coverage on the stated
// grounds that it is "exercised by e2e against real Postgres, not by vitest" — a
// justification its own comment records as expired. And `verify-suite --all` is CI
// job `build-test`, which does not run the e2e job at all. So the directory the
// coverage gate declines to measure is also the directory the unit gate never
// executes, and 53 source files sit in it.
//
// What DOES execute this SQL is `tests/integration/**`, whenever DATABASE_URL is
// set: those files construct the Drizzle classes directly and drive them against
// Postgres. That is a real guarantee and nothing was checking it stayed true. A new
// repo added tomorrow — or an existing one whose only real-Postgres test is deleted
// — takes its SQL out of every gate at once, silently, because a repo with no test
// fails nothing.
//
// ⚠️ This asserts EXECUTION, not assertion quality. A repo can be constructed by a
// test that only uses two of its methods, and that is exactly what happened with
// `oauth-store`: four db-oauth files construct it, and six of its fourteen methods
// had still never run, because those files seed the tables with hand-written SQL.
// So this is the floor — "the class is reachable from real Postgres at all" — not
// a coverage claim, and it is written that way on purpose. A guard that overstated
// itself here would be the more expensive failure, because it would stop the
// per-method work that found those six.
//
// ⛔ The census that produced this file was WRONG first time and worth recording.
// It matched `.methodName(` across integration tests and reported 41 methods whose
// SQL "never runs" — including all three of `retention-scrub-repo`, which has a
// dedicated `db-retention-scrub-drizzle` file driving it through its SERVICE, so
// the repo method name never appears. Constructing the class is the signal that
// survives that; a method-name match is not.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DB_DIR = resolve(REPO_ROOT, 'apps/server/src/db');
const INTEGRATION_DIR = resolve(REPO_ROOT, 'apps/server/tests/integration');

/** Exported classes that look like a persistence adapter rather than a helper. */
function repoClasses(source: string): string[] {
  return [...source.matchAll(/export class (\w+)/g)]
    .map((m) => m[1] as string)
    .filter(
      (name) => name.startsWith('Drizzle') || name.includes('Repo') || name.includes('Store'),
    );
}

/** Every integration test body, concatenated — the only tests that reach Postgres. */
function integrationSource(): { text: string; files: number } {
  let text = '';
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        files += 1;
        text += readFileSync(full, 'utf8');
      }
    }
  };
  walk(INTEGRATION_DIR);
  return { text, files };
}

/**
 * `db/*.ts` files with no persistence class, listed rather than filtered silently.
 *
 * Each is a module the rule cannot apply to: schema definitions, the client, CLI
 * entrypoints, and two pure helpers. Naming them means a NEW file here has to be
 * classified deliberately — "has no repo class" and "has a repo class nobody
 * tests" must not look the same from a green run.
 */
const NO_PERSISTENCE_CLASS = new Set([
  'chunk-ids.ts',
  'client.ts',
  'migrate.ts',
  'profile-session-lock.ts',
  'schema.ts',
  'seed-target-guard.ts',
  'seed.ts',
  // V-1263 — holds the billed-subscription status set and nothing else. It exists precisely
  // BECAUSE it has no repo: two repos and two doubles needed the same policy value, and giving
  // it to either repo would have made that module its accidental owner.
  'subscription-status-sets.ts',
]);

describe('every Drizzle repo is driven against a real Postgres', () => {
  it('CRITICAL every repo class is constructed by some integration test. src/db/** is outside the coverage gate AND outside the CI job that gate belongs to, so a repo nobody drives against Postgres has its SQL checked by nothing at all — and adding one fails nothing on its own.', () => {
    const { text, files } = integrationSource();
    expect(files, 'the integration corpus read as empty — the walk, not the tests').toBeGreaterThan(
      100,
    );

    const missing: string[] = [];
    let checked = 0;
    for (const fileName of readdirSync(DB_DIR).sort()) {
      if (!fileName.endsWith('.ts')) continue;
      const classes = repoClasses(readFileSync(join(DB_DIR, fileName), 'utf8'));
      if (classes.length === 0) continue;
      checked += 1;
      const constructed = classes.some((c) => new RegExp(`new\\s+${c}\\s*\\(`).test(text));
      if (!constructed) missing.push(`${fileName} (${classes.join(', ')})`);
    }

    expect(
      checked,
      'no repo classes were found at all — the class regex, not the repo layer',
    ).toBeGreaterThan(30);
    expect(
      missing,
      `these repo classes are never constructed by an integration test, so their SQL runs in no gate:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the no-persistence-class list cannot rot — every file it names must still exist, and must still have no repo class. A stale entry excuses a file that is gone; an entry that GAINED a repo class excuses the exact thing this file exists to catch.', () => {
    const present = new Set(readdirSync(DB_DIR).filter((f) => f.endsWith('.ts')));
    const gone = [...NO_PERSISTENCE_CLASS].filter((f) => !present.has(f));
    expect(
      gone,
      `listed as having no repo class but no longer present:\n  ${gone.join('\n  ')}`,
    ).toEqual([]);

    const nowHasOne = [...NO_PERSISTENCE_CLASS].filter(
      (f) => repoClasses(readFileSync(join(DB_DIR, f), 'utf8')).length > 0,
    );
    expect(
      nowHasOne,
      `these gained a repo class while still listed as having none:\n  ${nowHasOne.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL the classification is complete: every db/*.ts either has a repo class or is on the list. A file that is neither is a file the rule silently skipped, which is how a new persistence module would slip past — the census must account for all of them, not most.', () => {
    const unclassified: string[] = [];
    for (const fileName of readdirSync(DB_DIR).sort()) {
      if (!fileName.endsWith('.ts')) continue;
      const hasClass = repoClasses(readFileSync(join(DB_DIR, fileName), 'utf8')).length > 0;
      if (!hasClass && !NO_PERSISTENCE_CLASS.has(fileName)) unclassified.push(fileName);
    }
    expect(
      unclassified,
      `neither a repo class nor listed as having none:\n  ${unclassified.join('\n  ')}`,
    ).toEqual([]);
  });
});
