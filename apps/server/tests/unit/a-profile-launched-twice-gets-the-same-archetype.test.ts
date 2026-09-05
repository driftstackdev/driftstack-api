// A profile's fingerprint must not move between launches.
//
// A profile is a PERSISTENT browser identity: its archetype is chosen once at
// create (`profiles.ts:189-197`) and stored on the row. Chrome version sampling
// is coming, and the obvious-looking place to put it — the per-session dispatch
// — is the wrong one. Sampling there would launch the SAME profile as chrome151
// on Monday and chrome153 on Tuesday, under a stable cookie jar and canvas.
//
// That is worse than the tell it would be trying to fix. Shipping only-latest is
// a POPULATION tell, visible to someone comparing many users. A browser major
// that walks between two launches of one identity is a PER-IDENTITY tell,
// visible to a single observer over time.
//
// The reason this needs its own guard: a re-sampling bug passes every other test
// in the suite. Dispatch still works, the assign is still valid, the archetype
// is still a real archetype. It surfaces only as fingerprint drift in the field,
// where nobody can attribute it. So the invariant is pinned directly, and pinned
// BEFORE sampling exists, so the day someone adds a weighted draw to the
// dispatch path this goes red instead of shipping.
//
// Pins the INVARIANT (same profile → same archetype), not the implementation.

import { describe, it, expect } from 'vitest';
import { resolveDispatchArchetype } from '../../src/routes/agent-sessions.js';
import { archetypeAllowedForTier, defaultArchetypeIdForTier } from '@driftstack/api-types';

const STATIC_DEFAULT = 'iphone16pro_ios18_6_safari18_6';

describe('one profile provisions one fingerprint, every launch', () => {
  it('returns an identical archetype across many launches of the same profile', () => {
    const profileArchetype = 'iphone17_ios18_7_chrome152';
    const seen = new Set<string>();
    // Many iterations: a weighted draw introduced here would be overwhelmingly
    // unlikely to return one value 200 times, so this fails loudly rather than
    // flakily if sampling is ever moved into the dispatch path.
    for (let i = 0; i < 200; i += 1) {
      seen.add(
        resolveDispatchArchetype({ profileArchetype, staticDefault: STATIC_DEFAULT }).archetype,
      );
    }
    expect(seen.size, `dispatch returned ${seen.size} distinct archetypes for ONE profile`).toBe(1);
    expect([...seen][0]).toBe(profileArchetype);
  });

  it('is stable for a profile-less run too', () => {
    // The static default must not become a per-session draw by the back door
    // either. Sampling for profile-less runs is legitimate, but it belongs at
    // its own call site with its own archetypeSource — not silently here.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(
        resolveDispatchArchetype({ profileArchetype: undefined, staticDefault: STATIC_DEFAULT })
          .archetype,
      );
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(STATIC_DEFAULT);
  });

  it("a profile's own archetype always wins over the operator default", () => {
    // Vacuity control for the arms above: proves they are stable because the
    // resolution is deterministic, not because it always returns one constant.
    const withProfile = resolveDispatchArchetype({
      profileArchetype: 'iphone13_ios18_7_safari26_5',
      staticDefault: STATIC_DEFAULT,
    });
    const without = resolveDispatchArchetype({
      profileArchetype: undefined,
      staticDefault: STATIC_DEFAULT,
    });
    expect(withProfile.archetype).toBe('iphone13_ios18_7_safari26_5');
    expect(without.archetype).toBe(STATIC_DEFAULT);
    expect(withProfile.archetype).not.toBe(without.archetype);
  });

  it('names the source, so a sampled draw can never be reported as a stored one', () => {
    // `archetypeSource` is what a field report uses to tell a persisted identity
    // from a one-off. If ephemeral sampling lands it needs its OWN value here
    // (e.g. 'sampled-ephemeral'), never these two.
    expect(
      resolveDispatchArchetype({ profileArchetype: 'x', staticDefault: STATIC_DEFAULT })
        .archetypeSource,
    ).toBe('profile');
    expect(
      resolveDispatchArchetype({ profileArchetype: undefined, staticDefault: STATIC_DEFAULT })
        .archetypeSource,
    ).toBe('static-default');
  });

  // P-15 (2026-09-05) — a profile-less session dispatches the fleet's static default only
  // when the owner's tier is entitled to it; a restricted tier gets its own default.
  it('CRITICAL a free owner without a profile is NOT dispatched the static default when that device is outside the free entitlement', () => {
    const r = resolveDispatchArchetype({
      profileArchetype: undefined,
      staticDefault: STATIC_DEFAULT,
      tier: 'free',
    });
    expect(r.archetypeSource).toBe('tier-default');
    expect(r.archetype).toBe(defaultArchetypeIdForTier('free'));
    expect(archetypeAllowedForTier('free', r.archetype)).toBe(true);
  });

  it('a paid owner without a profile still gets the static default; a bound profile always wins', () => {
    expect(
      resolveDispatchArchetype({
        profileArchetype: undefined,
        staticDefault: STATIC_DEFAULT,
        tier: 'api_builder',
      }),
    ).toEqual({ archetype: STATIC_DEFAULT, archetypeSource: 'static-default' });
    expect(
      resolveDispatchArchetype({
        profileArchetype: 'iphone13_ios18_7_safari26_5',
        staticDefault: STATIC_DEFAULT,
        tier: 'free',
      }).archetypeSource,
    ).toBe('profile');
  });
});
