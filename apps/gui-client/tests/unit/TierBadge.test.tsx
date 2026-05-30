// V-534.M — unit tests for TierBadge.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TierBadge, tierLabelFor, tierToneFor } from '../../src/components/TierBadge';

describe('V-534.M tierLabelFor', () => {
  it('maps every known tier id to a human-readable label', () => {
    expect(tierLabelFor('free')).toBe('Free');
    expect(tierLabelFor('solo_manual')).toBe('Personal');
    expect(tierLabelFor('api_builder')).toBe('API Builder');
    expect(tierLabelFor('enterprise')).toBe('Enterprise');
  });

  it('falls back to the raw id for unknown tiers (forward-compat)', () => {
    expect(tierLabelFor('future_tier_x')).toBe('future_tier_x');
  });
});

describe('V-534.M tierToneFor', () => {
  it('free → neutral, paid tiers → paid, enterprise → enterprise', () => {
    expect(tierToneFor('free')).toBe('neutral');
    expect(tierToneFor('solo_manual')).toBe('paid');
    expect(tierToneFor('agency_manual')).toBe('paid');
    expect(tierToneFor('api_builder')).toBe('paid');
    expect(tierToneFor('enterprise')).toBe('enterprise');
  });

  it('falls back to neutral for unknown tiers', () => {
    expect(tierToneFor('mystery')).toBe('neutral');
  });
});

describe('V-534.M TierBadge rendering', () => {
  it('renders the canonical label for a known tier', () => {
    render(<TierBadge tier="solo_manual" />);
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('uses the explicit label override when supplied', () => {
    render(<TierBadge tier="solo_manual" label="Custom Plan" />);
    expect(screen.getByText('Custom Plan')).toBeTruthy();
    expect(screen.queryByText('Personal')).toBeNull();
  });

  it('sets aria-label so screen readers announce "Tier: <label>"', () => {
    render(<TierBadge tier="enterprise" />);
    const el = screen.getByRole('status', { name: /tier: enterprise/i });
    expect(el.textContent).toBe('Enterprise');
  });

  it('applies size=sm classes when requested', () => {
    const { container } = render(<TierBadge tier="free" size="sm" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('text-xs');
  });

  it('defaults to size=md', () => {
    const { container } = render(<TierBadge tier="free" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('text-sm');
  });

  it('applies tone-specific styling per tier', () => {
    const { container: paidEl } = render(<TierBadge tier="solo_manual" />);
    expect(paidEl.querySelector('span')?.className).toContain('status-success');
    const { container: enterpriseEl } = render(<TierBadge tier="enterprise" />);
    expect(enterpriseEl.querySelector('span')?.className).toContain('accent');
    const { container: neutralEl } = render(<TierBadge tier="free" />);
    expect(neutralEl.querySelector('span')?.className).toContain('surface-inset');
  });
});
