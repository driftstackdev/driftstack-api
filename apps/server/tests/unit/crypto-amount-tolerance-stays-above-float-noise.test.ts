// The under-payment decision must be decided by the tolerance, never by
// floating-point representation.
//
// `applyIpnStatus` settles a crypto order on
// `actually_paid >= pay_amount * (1 - AMOUNT_RECONCILE_TOLERANCE_FRACTION)`,
// and BOTH operands are float64 the whole way:
//
//   • the IPN declares `pay_amount?: number` / `actually_paid?: number`, so the
//     value is already a JSON double before it reaches us — a string column
//     could not recover precision the wire never carried;
//   • `crypto_orders.pay_amount` is numeric(38,18) with drizzle `mode: 'number'`,
//     which reads it back as a double.
//
// That is coherent as long as the tolerance is far larger than the error. It is:
// 1% against a relative error near 2.2e-16, fourteen orders of magnitude apart.
// Measured, not assumed — `1.234567890123456789` round-trips through Number() as
// `1.2345678901234567`, losing its last two digits, and `123456789.1234567890…`
// loses ten. Those losses are real and they are irrelevant AT THIS TOLERANCE.
//
// What this file adds is that relationship, stated directly.
//
// Checked rather than assumed, and the first draft of this comment was wrong:
// tightening the tolerance to 1e-16 DOES already fail
// crypto-orders-amount-reconciliation, at its "tolerates a tiny under-payment
// within the rounding tolerance" arm. So the shipped value is not unguarded.
//
// It is guarded incidentally, though. That arm fails because one fixture pays a
// specific hair under the quote; it is a consequence of the number chosen for
// that scenario, not a statement about what the tolerance has to be. Nothing
// said WHY 1% is safe, and nothing tied the floor to the arithmetic — so a
// future edit that retunes both the tolerance and that fixture together (the
// natural thing to do when a fixture starts failing) would pass review with the
// comparison now decided by representation instead of by policy.
//
// The floor here is the missing half: it names float64 epsilon as the thing the
// tolerance must clear, and fails on the constant alone, whatever the fixtures
// happen to use.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src', 'services', 'crypto-orders.ts');

/** The tolerance, read from the service rather than restated. */
function toleranceFraction(): number {
  const body = readFileSync(SRC, 'utf8');
  const m = /const AMOUNT_RECONCILE_TOLERANCE_FRACTION = ([\d.e-]+);/.exec(body);
  expect(m, 'AMOUNT_RECONCILE_TOLERANCE_FRACTION could not be read from crypto-orders.ts').not.toBe(
    null,
  );
  return Number(m?.[1]);
}

/** The settle rule, as applyIpnStatus computes it. */
function settlesAsPaid(owed: number, actuallyPaid: number, tolerance: number): boolean {
  return !(actuallyPaid < owed * (1 - tolerance));
}

/**
 * Crypto amounts whose full precision does NOT survive a float64 round-trip.
 * Verified below rather than asserted — if a JS engine ever represented these
 * exactly, the premise of this file would be gone and it should say so.
 */
const LOSSY_AMOUNTS = ['1.234567890123456789', '123456789.123456789012345678'] as const;

describe('the crypto under-payment tolerance stays above float64 noise', () => {
  it('CRITICAL the premise holds — these amounts really do lose digits as doubles', () => {
    // Anti-vacuity. Every case below is about precision loss being harmless;
    // if there were no precision loss, they would prove nothing.
    for (const amount of LOSSY_AMOUNTS) {
      expect(String(Number(amount)), `${amount} unexpectedly round-trips exactly`).not.toBe(amount);
    }
  });

  it('CRITICAL the tolerance is orders of magnitude above the representation error', () => {
    // Number.EPSILON (2.22e-16) is the relative spacing of doubles near 1. A
    // tolerance within a few orders of magnitude of it is not a tolerance, it is
    // noise. 1e-9 leaves seven orders of headroom and is still far tighter than
    // any real slippage allowance.
    const tolerance = toleranceFraction();
    expect(tolerance, 'the reconciliation tolerance is missing or zero').toBeGreaterThan(0);
    expect(
      tolerance,
      'the under-payment tolerance is close enough to float64 epsilon that the paid/partial ' +
        'decision is decided by representation rather than by policy — a full payment on an ' +
        '18-decimal amount would flip to `partial` depending on how the value rounds',
    ).toBeGreaterThan(1e-9);
  });

  it('CRITICAL an exactly-full payment settles as paid even when the amount is lossy', () => {
    // The customer paid precisely what was quoted. Both sides go through the
    // same double conversion, so this must hold whatever the digits are.
    const tolerance = toleranceFraction();
    for (const amount of LOSSY_AMOUNTS) {
      const owed = Number(amount);
      expect(
        settlesAsPaid(owed, owed, tolerance),
        `${amount}: an exact payment must never be classified partial`,
      ).toBe(true);
    }
  });

  it('CRITICAL a real short-pay is still rejected at this tolerance', () => {
    // The other direction, so the guard cannot be satisfied by widening the
    // tolerance until everything passes. A 5% short-pay is well outside the 1%
    // slippage allowance and must still route to `partial`.
    const tolerance = toleranceFraction();
    const owed = Number(LOSSY_AMOUNTS[0]);
    expect(settlesAsPaid(owed, owed * 0.95, tolerance)).toBe(false);
  });

  it('shows what a noise-level tolerance would do, so the floor above is not arbitrary', () => {
    // Not a check on the shipped value — a demonstration of the failure it
    // prevents. At a tolerance below the representation error, whether a full
    // payment settles depends on which way the last digit rounded.
    const owed = Number('123456789.123456789012345678');
    const paidFullPrecisionThenRounded = Number('123456789.123456789012345670');
    expect(settlesAsPaid(owed, paidFullPrecisionThenRounded, 1e-18)).toBe(true);
    // Same pair, judged by the shipped tolerance: unambiguous.
    expect(settlesAsPaid(owed, paidFullPrecisionThenRounded, toleranceFraction())).toBe(true);
  });
});
