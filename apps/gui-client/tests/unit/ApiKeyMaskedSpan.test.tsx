// V-534.R — unit tests for ApiKeyMaskedSpan + maskApiKey helper.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiKeyMaskedSpan, maskApiKey } from '../../src/components/ApiKeyMaskedSpan';

describe('V-534.R maskApiKey helper', () => {
  it('returns "—" placeholder for null / undefined / empty', () => {
    expect(maskApiKey(null)).toBe('—');
    expect(maskApiKey(undefined)).toBe('—');
    expect(maskApiKey('')).toBe('—');
  });

  it('preserves the full ds_live_ prefix + shows first 4 / last 4', () => {
    expect(maskApiKey('ds_live_abcdefghijklmnopqrstuvwxyz1234')).toBe('ds_live_abcd…1234');
  });

  it('recognises ds_test_ prefix as well', () => {
    expect(maskApiKey('ds_test_abcdefghijklmnop')).toBe('ds_test_abcd…mnop');
  });

  it('recognises webhook + oauth prefixes', () => {
    expect(maskApiKey('whsec_v1_abcdefghijklmnopqrstuvwxyz')).toContain('whsec_v1_');
    expect(maskApiKey('oas_abcdefghijklmnop')).toContain('oas_');
    expect(maskApiKey('oat_abcdefghijklmnop')).toContain('oat_');
  });

  it('returns the full body when shorter than visible window (no masking needed)', () => {
    expect(maskApiKey('ds_live_abc')).toBe('ds_live_abc');
  });

  it('honours custom visible prefix/suffix chars', () => {
    expect(
      maskApiKey('ds_live_abcdefghijklmnopqrstuvwxyz', {
        visiblePrefixChars: 6,
        visibleSuffixChars: 2,
      }),
    ).toBe('ds_live_abcdef…yz');
  });

  it('unknown-prefix keys are masked without a recognised prefix', () => {
    expect(maskApiKey('xyz_foobarbazquxquux')).toBe('xyz_…quux');
  });
});

describe('V-534.R ApiKeyMaskedSpan component', () => {
  it('renders the masked form with aria-label', () => {
    render(<ApiKeyMaskedSpan apiKey="ds_live_abcdefghijklmnopqrstuvwxyz1234" />);
    const span = screen.getByLabelText('API key (masked)');
    expect(span.textContent).toBe('ds_live_abcd…1234');
  });

  it('renders the placeholder when apiKey is null', () => {
    render(<ApiKeyMaskedSpan apiKey={null} />);
    expect(screen.getByLabelText('API key (masked)').textContent).toBe('—');
  });

  it('honours className override', () => {
    const { container } = render(
      <ApiKeyMaskedSpan apiKey="ds_live_abcdefghijklmnopqrstuvwxyz1234" className="custom-class" />,
    );
    expect(container.querySelector('.custom-class')).not.toBeNull();
  });
});
