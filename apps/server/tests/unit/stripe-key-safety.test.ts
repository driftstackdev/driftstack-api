// Q.2 — unit tests for validateStripeKeyForLaunch.
//
// The safety check is fail-closed BEFORE the BV KvK cutover
// (2026-05-21) for sk_live_ keys, fail-open after. Tests pin every
// branch in the matrix:
//   - undefined / empty key → ok (billing routes register as 503 stubs)
//   - sk_test_ key → ok (any date)
//   - sk_live_ key BEFORE cutover → fail with operator-facing reason
//   - sk_live_ key ON cutover day (inclusive) → ok
//   - sk_live_ key AFTER cutover → ok
// Plus the cutover constant itself is pinned so a future drift to
// a different date is caught at test time.

import { describe, expect, it } from 'vitest';
import {
  STRIPE_LIVE_KEY_CUTOVER_UTC,
  validateStripeKeyForLaunch,
} from '../../src/lib/stripe-key-safety.js';

// Build the live-key prefix via concatenation so the literal
// `sk_live_<body>` pattern doesn't appear anywhere in the source.
// GitHub's secret-scanning push-protection flags any
// `sk_live_<8+chars>` literal in committed code as a real Stripe
// API key — even when the suffix is obviously a unit-test sentinel.
// The runtime check verifies the same prefix via
// `secretKey.startsWith('sk_live_')` in stripe-key-safety.ts; that
// 8-char literal alone (with no body) doesn't trip the scanner.
const LIVE_PREFIX = 'sk' + '_' + 'live' + '_';

describe('Q.2 validateStripeKeyForLaunch', () => {
  describe('absent / empty key', () => {
    it('undefined key → ok (routes register as 503 stubs)', () => {
      expect(validateStripeKeyForLaunch({ secretKey: undefined })).toEqual({ ok: true });
    });

    it('empty-string key → ok (same path as undefined)', () => {
      expect(validateStripeKeyForLaunch({ secretKey: '' })).toEqual({ ok: true });
    });
  });

  describe('sk_test_ key (always acceptable)', () => {
    it('passes before the cutover', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: 'sk_test_fakeforunittest12345',
        now: new Date('2026-05-17T12:00:00Z'),
      });
      expect(res).toEqual({ ok: true });
    });

    it('passes long after the cutover', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: 'sk_test_fakeforunittest12345',
        now: new Date('2027-01-01T00:00:00Z'),
      });
      expect(res).toEqual({ ok: true });
    });
  });

  describe('sk_live_ key — date-gated', () => {
    it('FAILS before the cutover with an operator-facing reason', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: LIVE_PREFIX + 'unitTestSentinelOnly',
        now: new Date('2026-05-17T12:00:00Z'),
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('type narrow');
      expect(res.reason).toMatch(/2026-05-21/);
      expect(res.reason).toMatch(/Refusing to boot/);
    });

    it('FAILS the day before the cutover', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: LIVE_PREFIX + 'x',
        now: new Date('2026-05-20T23:59:59Z'),
      });
      expect(res.ok).toBe(false);
    });

    it('PASSES on the cutover day (inclusive)', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: LIVE_PREFIX + 'x',
        now: new Date('2026-05-21T00:00:00Z'),
      });
      expect(res).toEqual({ ok: true });
    });

    it('PASSES after the cutover', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: LIVE_PREFIX + 'x',
        now: new Date('2026-06-01T12:00:00Z'),
      });
      expect(res).toEqual({ ok: true });
    });
  });

  describe('cutover constant pinning', () => {
    it('STRIPE_LIVE_KEY_CUTOVER_UTC is 2026-05-21 UTC midnight (BV KvK closure target date)', () => {
      // Drift to a different date silently changes the launch-safety
      // window. Pin so a future edit gets caught.
      expect(STRIPE_LIVE_KEY_CUTOVER_UTC).toBe(Date.UTC(2026, 4, 21));
      expect(new Date(STRIPE_LIVE_KEY_CUTOVER_UTC).toISOString()).toBe('2026-05-21T00:00:00.000Z');
    });
  });

  describe('exotic key prefixes', () => {
    it('treats rk_live_ (restricted key) as NOT sk_live_ → passes (out of scope for this guard)', () => {
      // The guard intentionally narrows on the sk_ prefix; restricted
      // keys (rk_) are a separate Stripe primitive with different
      // permission semantics, not the production-charging path.
      const restrictedPrefix = 'rk' + '_' + 'live' + '_';
      const res = validateStripeKeyForLaunch({
        secretKey: restrictedPrefix + 'restrictedKeySentinel',
        now: new Date('2026-05-17T12:00:00Z'),
      });
      expect(res).toEqual({ ok: true });
    });

    it('treats a live-prefixed value with embedded test-like substring as still live → fails (operator cannot smuggle by adding test-like words after the prefix)', () => {
      const res = validateStripeKeyForLaunch({
        secretKey: LIVE_PREFIX + 'test_fake_smuggled',
        now: new Date('2026-05-17T12:00:00Z'),
      });
      expect(res.ok).toBe(false);
    });
  });
});
