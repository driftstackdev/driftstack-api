// V-286 — pure-function unit tests for the V-274 shared
// `useBrowserSignIn` hook module. Component / hook lifecycle tests
// require jsdom + React Testing Library; that's deferred to a
// follow-up V-NNN with the broader test-infra setup. This file
// covers the pure helpers — load-bearing CSRF state generation +
// the underlying entropy contract.

import { describe, expect, it } from 'vitest';
import { generateBrowserSignInState } from '../../src/lib/browser-sign-in.js';

describe('generateBrowserSignInState', () => {
  it('returns 48 hex chars (24 bytes × 2 hex)', () => {
    const s = generateBrowserSignInState();
    expect(s).toMatch(/^[0-9a-f]{48}$/);
  });

  it('exceeds the V-266 server-side min(16) check', () => {
    const s = generateBrowserSignInState();
    expect(s.length).toBeGreaterThanOrEqual(16);
    expect(s.length).toBeLessThanOrEqual(128); // also under the max(128) cap
  });

  it('produces distinct values across calls (entropy sanity)', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 100; i++) {
      samples.add(generateBrowserSignInState());
    }
    // 24 bytes = 192 bits of entropy. Birthday collision probability
    // across 100 samples is vanishingly small. If we ever see a
    // collision in this loop, something is wrong with crypto.getRandomValues.
    expect(samples.size).toBe(100);
  });

  it('does not include URL-unsafe characters', () => {
    // Hex output is URL-safe by construction (only 0-9 + a-f). Defence
    // in depth: assert no `+`, `/`, `=`, or whitespace appear, since
    // any of those would break the V-266 server-side state-token
    // round-trip through the dashboard URL.
    const s = generateBrowserSignInState();
    expect(s).not.toMatch(/[+/=\s]/);
  });
});
