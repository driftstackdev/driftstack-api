// `profileSessionAdvisoryLockKey` driven directly.
//
// Both customer session-create surfaces serialize on this key before checking or
// binding a persistent profile:
//
//   db/sessions-repo.ts        SELECT pg_advisory_xact_lock(hashtext(<key>))
//   db/agent-sessions-repo.ts  SELECT pg_advisory_xact_lock(hashtext(<key>))
//
// The module exists because those two drifted into independent locks once
// before, and its comment says so. What guarded it afterwards were content-parity
// regexes pinning the call site in each repo — which prove both repos CALL the
// shared helper, and that is a connection the code genuinely cannot express.
//
// What no test proved is what the helper RETURNS, and that was measured rather
// than assumed. Against 85 files / 1019 tests covering profiles, sessions and
// both repo parity suites:
//
//   key becomes a constant (every profile shares one lock) → 1019 PASS
//   key becomes unique per call (the lock protects nothing) → 1019 PASS, 0 TS errors
//
// The second is the one that matters. `pg_advisory_xact_lock` on a value that
// differs every call acquires a fresh lock nobody contends for, so two concurrent
// creates against the same profile both proceed — precisely the race the lock was
// added to close — and every test still passes.
//
// Two properties carry that, and they are separate: DETERMINISM (the same profile
// always yields the same key, or the lock is not shared) and INJECTIVITY (distinct
// profiles yield distinct keys, or unrelated creates serialize on each other).
// A single "returns a string containing the id" assertion would satisfy neither.

import { describe, expect, it } from 'vitest';
import { profileSessionAdvisoryLockKey } from '../../src/db/profile-session-lock.js';

const PROFILE_A = 'prf_11111111-1111-4111-8111-111111111111';
const PROFILE_B = 'prf_22222222-2222-4222-8222-222222222222';

describe('profileSessionAdvisoryLockKey', () => {
  it('CRITICAL the same profile always yields the same key. A key that varies between calls makes pg_advisory_xact_lock take a fresh uncontended lock every time, so two concurrent session creates on one profile both proceed — the exact race this lock closes — while every existing test still passes.', () => {
    const first = profileSessionAdvisoryLockKey(PROFILE_A);
    const second = profileSessionAdvisoryLockKey(PROFILE_A);
    expect(second, 'repeated calls must agree').toBe(first);
    // Separate calls in a different order, in case some cache made the two
    // adjacent calls agree for a reason that would not hold across requests.
    profileSessionAdvisoryLockKey(PROFILE_B);
    expect(profileSessionAdvisoryLockKey(PROFILE_A), 'and must survive an interleaved call').toBe(
      first,
    );
  });

  it('CRITICAL distinct profiles yield distinct keys. Collapsing them to one constant serializes every customer session-create in the deployment behind a single advisory lock — which is a throughput failure that no functional test can see, because the results stay correct.', () => {
    expect(profileSessionAdvisoryLockKey(PROFILE_B)).not.toBe(
      profileSessionAdvisoryLockKey(PROFILE_A),
    );
  });

  it('CRITICAL the profile id appears in the key, so distinctness comes from the identity rather than from anything incidental.', () => {
    expect(profileSessionAdvisoryLockKey(PROFILE_A)).toContain(PROFILE_A);
  });

  it('the key is namespaced, so it cannot collide with an advisory lock taken for some other purpose on the same connection.', () => {
    expect(profileSessionAdvisoryLockKey(PROFILE_A).startsWith('profile-session:')).toBe(true);
  });
});
