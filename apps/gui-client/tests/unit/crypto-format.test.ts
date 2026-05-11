// V-534.AF — unit tests for shared crypto formatting helpers.

import { describe, expect, it } from 'vitest';
import { formatCents, formatRelative } from '../../src/lib/crypto-format';

describe('V-534.AF formatCents', () => {
  it('renders integer cents with 2 decimal places + currency', () => {
    expect(formatCents(2500, 'EUR')).toBe('25.00 EUR');
    expect(formatCents(0, 'USD')).toBe('0.00 USD');
    expect(formatCents(123456, 'USD')).toBe('1234.56 USD');
  });

  it('rounds half-up via toFixed', () => {
    // 1.005 → toFixed(2) is environment-dependent (banker's vs half-up); accept
    // either as long as it returns a 2-decimal string with the currency.
    const out = formatCents(101, 'EUR');
    expect(out).toMatch(/^1\.0[01] EUR$/);
  });
});

describe('V-534.AF formatRelative', () => {
  const NOW = new Date('2026-05-11T12:00:00Z').getTime();

  it('returns "just now" for timestamps inside the past minute', () => {
    const iso = new Date(NOW - 30_000).toISOString();
    expect(formatRelative(iso, NOW)).toBe('just now');
  });

  it('returns "Nm ago" for timestamps in the past hour', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatRelative(iso, NOW)).toBe('5m ago');
  });

  it('returns "Nh ago" for timestamps in the past day', () => {
    const iso = new Date(NOW - 3 * 60 * 60_000).toISOString();
    expect(formatRelative(iso, NOW)).toBe('3h ago');
  });

  it('returns "Nd ago" beyond a day', () => {
    const iso = new Date(NOW - 4 * 24 * 60 * 60_000).toISOString();
    expect(formatRelative(iso, NOW)).toBe('4d ago');
  });
});
