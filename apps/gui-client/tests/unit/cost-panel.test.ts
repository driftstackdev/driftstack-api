// V-534.F — unit tests for the cost-panel formatter.

import { describe, expect, it } from 'vitest';
import { classifyTone, formatCents, formatCostBreakdown } from '../../src/lib/cost-panel';

describe('V-534.F formatCents', () => {
  it('EUR formatting with 2 decimals', () => {
    expect(formatCents(123)).toBe('€1.23');
    expect(formatCents(15000)).toBe('€150.00');
    expect(formatCents(0)).toBe('€0.00');
  });

  it('USD formatting honours the currency parameter', () => {
    expect(formatCents(1999, 'USD')).toBe('$19.99');
  });
});

describe('V-534.F classifyTone', () => {
  it('under-soft → ok, between → warn, over-hard → alert', () => {
    expect(classifyTone('under-soft')).toBe('ok');
    expect(classifyTone('between-soft-and-hard')).toBe('warn');
    expect(classifyTone('over-hard')).toBe('alert');
  });
});

describe('V-534.F formatCostBreakdown', () => {
  it('renders 5 component rows + a total in the same currency', () => {
    const out = formatCostBreakdown({
      computeCents: 120,
      storageCents: 20,
      egressCents: 5,
      emailCents: 5,
      llmCents: 180,
      totalCents: 330,
      thresholdState: 'under-soft',
    });
    expect(out.rows).toHaveLength(5);
    expect(out.rows[0]?.label).toBe('Compute (session-minutes)');
    expect(out.rows[0]?.formatted).toBe('€1.20');
    expect(out.total.formatted).toBe('€3.30');
    expect(out.tone).toBe('ok');
  });

  it('over-hard threshold sets alert tone + alert copy', () => {
    const out = formatCostBreakdown({
      computeCents: 9999,
      storageCents: 0,
      egressCents: 0,
      emailCents: 0,
      llmCents: 0,
      totalCents: 9999,
      thresholdState: 'over-hard',
    });
    expect(out.tone).toBe('alert');
    expect(out.toneCopy.toLowerCase()).toContain('hard threshold');
  });

  it('USD currency carries through to row + total formatting', () => {
    const out = formatCostBreakdown(
      {
        computeCents: 500,
        storageCents: 0,
        egressCents: 0,
        emailCents: 0,
        llmCents: 0,
        totalCents: 500,
        thresholdState: 'under-soft',
      },
      { currency: 'USD' },
    );
    expect(out.total.formatted).toBe('$5.00');
    expect(out.rows[0]?.formatted).toBe('$5.00');
  });
});
