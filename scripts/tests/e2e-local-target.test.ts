// The no-Docker e2e entry point refuses a target it would destroy.
//
// `resetState()` runs `TRUNCATE … RESTART IDENTITY CASCADE` over the whole schema
// and `redis.flushdb()` before EVERY test. The harness defaults are the shared
// development database and Redis index 0, which are right for compose (both are
// disposable containers) and exactly wrong on a developer machine.
//
// The harness's existing rule — readiness item 30 — refuses a NON-LOOPBACK target.
// It cannot help here: every mistake this file is about is on loopback. These are
// the checks that only become meaningful once "not compose" is the stated
// contract, which is why they live on a separate entry point rather than being
// bolted onto `test:e2e`.

import { describe, expect, it } from 'vitest';
import { validateE2eLocalTarget } from '../e2e-local.mjs';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'e2e-local.mjs');
const CANONICAL = resolve(HERE, '..', '..', 'apps', 'server', 'src', 'lib', 'loopback-host.ts');

/** The string literals of a `LOOPBACK_HOSTS` set declaration, from source. */
function loopbackHostsIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const decl = /LOOPBACK_HOSTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (decl === null) return [];
  return [...(decl[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const SAFE = {
  databaseUrl: 'postgres://localhost:5432/driftstack_e2e_local',
  redisUrl: 'redis://localhost:6379/12',
};

describe('e2e-local target validation', () => {
  it('accepts a disposable local database and an unused redis index', () => {
    const verdict = validateE2eLocalTarget(SAFE);
    expect(verdict.problems, 'a legitimate target must produce no complaints').toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('CRITICAL refuses the shared development database by name', () => {
    // The whole point: this target is LOOPBACK, so item 30's rule passes it, and
    // the suite would TRUNCATE every table in the database a developer works in.
    const verdict = validateE2eLocalTarget({
      ...SAFE,
      databaseUrl: 'postgres://driftstack:driftstack@localhost:5432/driftstack',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/shared development database/);
  });

  it('CRITICAL refuses an unset DATABASE_URL rather than inheriting the harness default', () => {
    const verdict = validateE2eLocalTarget({ ...SAFE, databaseUrl: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/unset/);
  });

  it('CRITICAL refuses redis index 0, which flushdb() would wipe for every other local tool', () => {
    for (const redisUrl of ['redis://localhost:6379/0', 'redis://localhost:6379']) {
      const verdict = validateE2eLocalTarget({ ...SAFE, redisUrl });
      expect(verdict.ok, `${redisUrl} must be refused`).toBe(false);
      expect(verdict.problems.join(' ')).toMatch(/non-default database index/);
    }
  });

  it('refuses a non-loopback host on either URL', () => {
    expect(
      validateE2eLocalTarget({ ...SAFE, databaseUrl: 'postgres://db.example.test:5432/x' }).ok,
    ).toBe(false);
    expect(
      validateE2eLocalTarget({ ...SAFE, redisUrl: 'redis://cache.example.test:6379/3' }).ok,
    ).toBe(false);
  });

  it('CRITICAL refuses an UNPARSEABLE url instead of assuming it is harmless', () => {
    // A guard that cannot identify its target must not conclude the target is
    // safe, or malformed input becomes the bypass.
    for (const bad of ['not a url', '://', 'postgres://[oops']) {
      expect(validateE2eLocalTarget({ ...SAFE, databaseUrl: bad }).ok, bad).toBe(false);
      expect(validateE2eLocalTarget({ ...SAFE, redisUrl: bad }).ok, bad).toBe(false);
    }
  });

  it('CRITICAL both loopback sets were parsed out of source. Each assertion below is a subset check, and a subset of nothing holds trivially — a renamed constant or a reformatted literal would make the invariant agree with anything.', () => {
    const script = loopbackHostsIn(SCRIPT);
    const canonical = loopbackHostsIn(CANONICAL);
    expect(script.length, `hosts parsed from ${SCRIPT}`).toBeGreaterThanOrEqual(3);
    expect(canonical.length, `hosts parsed from ${CANONICAL}`).toBeGreaterThanOrEqual(3);
    expect(canonical, 'the canonical set is the one lib/loopback-host.ts declares').toContain(
      'localhost',
    );
  });

  it('CRITICAL this script may be STRICTER than the shared classifier but never more permissive. lib/loopback-host.ts exists so the two destructive callers cannot disagree — its header says two copies of a safety predicate is the shape that drifted a lock into two locks, and "the weaker one is the one that matters". This script cannot import it: it is plain .mjs and the classifier is TypeScript, so the copy is structural and only an invariant keeps it honest. A host accepted here but not there would authorise a TRUNCATE of whatever it names against a target the shared rule refuses. Today the script omits 0.0.0.0 and does not case-fold, which are both refusals — safe, and the direction this pins.', () => {
    const canonical = new Set(loopbackHostsIn(CANONICAL));
    const extra = loopbackHostsIn(SCRIPT).filter((h) => !canonical.has(h));
    expect(
      extra,
      'host(s) this script treats as loopback that lib/loopback-host.ts does not. Add them to the shared classifier first, or remove them here:',
    ).toEqual([]);
  });

  it('reports EVERY problem at once, so a misconfigured shell is fixed in one pass', () => {
    const verdict = validateE2eLocalTarget({ databaseUrl: undefined, redisUrl: undefined });
    expect(verdict.problems.length, 'both URLs complain, not just the first').toBe(2);
  });
});
