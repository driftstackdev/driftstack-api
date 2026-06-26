// Billing-integrity hardening — per-account concurrent bundled-LLM-turn
// limiter. Bounds the soft-cap read-then-act TOCTOU overshoot: only
// `limit` bundled turns may be in-flight per account at once.

import { describe, expect, it } from 'vitest';
import { BundledTurnConcurrencyLimiter } from '../../src/services/bundled-turn-concurrency.js';

describe('BundledTurnConcurrencyLimiter', () => {
  it('admits up to the ceiling, then refuses', () => {
    const l = new BundledTurnConcurrencyLimiter(2);
    expect(l.limit).toBe(2);
    expect(l.tryAcquire('acc')).toBe(true); // 1
    expect(l.tryAcquire('acc')).toBe(true); // 2
    expect(l.current('acc')).toBe(2);
    // At the ceiling — the 3rd concurrent turn is refused.
    expect(l.tryAcquire('acc')).toBe(false);
    expect(l.current('acc')).toBe(2);
  });

  it('release frees a slot so a subsequent turn is admitted', () => {
    const l = new BundledTurnConcurrencyLimiter(1);
    expect(l.tryAcquire('acc')).toBe(true);
    expect(l.tryAcquire('acc')).toBe(false);
    l.release('acc');
    expect(l.current('acc')).toBe(0);
    expect(l.tryAcquire('acc')).toBe(true);
  });

  it('is isolated per account', () => {
    const l = new BundledTurnConcurrencyLimiter(1);
    expect(l.tryAcquire('a')).toBe(true);
    // Account a is full; account b is independent.
    expect(l.tryAcquire('a')).toBe(false);
    expect(l.tryAcquire('b')).toBe(true);
  });

  it('release never drives the count negative (idempotent at zero)', () => {
    const l = new BundledTurnConcurrencyLimiter(3);
    l.release('acc'); // no slot held
    l.release('acc');
    expect(l.current('acc')).toBe(0);
    // A fresh acquire still works (count didn't go negative).
    expect(l.tryAcquire('acc')).toBe(true);
    expect(l.current('acc')).toBe(1);
  });

  it('rejects an invalid ceiling', () => {
    expect(() => new BundledTurnConcurrencyLimiter(0)).toThrow();
  });

  it('defaults the ceiling to 3', () => {
    const l = new BundledTurnConcurrencyLimiter();
    expect(l.limit).toBe(3);
  });
});
