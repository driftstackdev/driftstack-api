// V-534.U — unit tests for CryptoOrderStatusBadge.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CryptoOrderStatusBadge,
  cryptoOrderStatusLabelFor,
  cryptoOrderStatusToneFor,
  isTerminalCryptoOrderStatus,
} from '../../src/components/CryptoOrderStatusBadge';

describe('V-534.U cryptoOrderStatusLabelFor', () => {
  it('maps every known status to a human-readable label', () => {
    expect(cryptoOrderStatusLabelFor('pending')).toBe('Awaiting payment');
    expect(cryptoOrderStatusLabelFor('confirming')).toBe('Confirming on-chain');
    expect(cryptoOrderStatusLabelFor('paid')).toBe('Paid');
    expect(cryptoOrderStatusLabelFor('failed')).toBe('Failed');
    expect(cryptoOrderStatusLabelFor('partial')).toContain('Partial');
  });

  it('falls back to the raw status for unknown values', () => {
    expect(cryptoOrderStatusLabelFor('refunded')).toBe('refunded');
  });
});

describe('V-534.U cryptoOrderStatusToneFor', () => {
  it('paid → success, failed → error, partial → warning', () => {
    expect(cryptoOrderStatusToneFor('paid')).toBe('success');
    expect(cryptoOrderStatusToneFor('failed')).toBe('error');
    expect(cryptoOrderStatusToneFor('partial')).toBe('warning');
  });

  it('confirming → busy (used for the animated pulse)', () => {
    expect(cryptoOrderStatusToneFor('confirming')).toBe('busy');
  });

  it('pending → neutral', () => {
    expect(cryptoOrderStatusToneFor('pending')).toBe('neutral');
  });

  it('falls back to neutral for unknown statuses', () => {
    expect(cryptoOrderStatusToneFor('mystery')).toBe('neutral');
  });
});

describe('V-534.U isTerminalCryptoOrderStatus', () => {
  it('paid + failed are terminal', () => {
    expect(isTerminalCryptoOrderStatus('paid')).toBe(true);
    expect(isTerminalCryptoOrderStatus('failed')).toBe(true);
  });

  it('pending + confirming + partial are NOT terminal', () => {
    expect(isTerminalCryptoOrderStatus('pending')).toBe(false);
    expect(isTerminalCryptoOrderStatus('confirming')).toBe(false);
    expect(isTerminalCryptoOrderStatus('partial')).toBe(false);
  });
});

describe('V-534.U CryptoOrderStatusBadge rendering', () => {
  it('renders the canonical label with role="status"', () => {
    render(<CryptoOrderStatusBadge status="paid" />);
    const el = screen.getByRole('status', { name: /crypto order status: paid/i });
    expect(el.textContent).toContain('Paid');
  });

  it('applies tone-specific classes per status', () => {
    const { container: paidEl } = render(<CryptoOrderStatusBadge status="paid" />);
    expect(paidEl.querySelector('span')?.className).toContain('status-success');
    const { container: failedEl } = render(<CryptoOrderStatusBadge status="failed" />);
    expect(failedEl.querySelector('span')?.className).toContain('status-error');
    const { container: partialEl } = render(<CryptoOrderStatusBadge status="partial" />);
    expect(partialEl.querySelector('span')?.className).toContain('status-warning');
  });

  it('confirming state includes an animated pulse dot', () => {
    const { container } = render(<CryptoOrderStatusBadge status="confirming" />);
    expect(container.innerHTML).toContain('animate-pulse');
  });

  it('applies size=sm when requested', () => {
    const { container } = render(<CryptoOrderStatusBadge status="paid" size="sm" />);
    expect(container.querySelector('span')?.className).toContain('text-xs');
  });
});
