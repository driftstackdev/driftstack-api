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

  it('reports EVERY problem at once, so a misconfigured shell is fixed in one pass', () => {
    const verdict = validateE2eLocalTarget({ databaseUrl: undefined, redisUrl: undefined });
    expect(verdict.problems.length, 'both URLs complain, not just the first').toBe(2);
  });
});
