// V-534.AF — unit tests for CryptoOrderSummaryCard.
// V-534.BF — appended tests for V-666.AV expires_at countdown.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CryptoOrderSummaryCard } from '../../src/components/CryptoOrderSummaryCard';
import { formatTimestamp } from '../../src/lib/crypto-format';
import type { CryptoOrderData } from '../../src/lib/use-crypto-order';

function makeOrder(overrides: Partial<CryptoOrderData> = {}): CryptoOrderData {
  return {
    order_id: 'ord_abc',
    product: 'team_growth',
    price_cents: 14900,
    price_currency: 'EUR',
    payment_id: null,
    status: 'pending',
    created_at: '2026-05-11T10:00:00.000Z',
    updated_at: '2026-05-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('V-534.AF CryptoOrderSummaryCard', () => {
  it('renders order id + product + formatted price + status badge', () => {
    render(<CryptoOrderSummaryCard order={makeOrder()} />);
    expect(screen.getByText('ord_abc')).toBeTruthy();
    expect(screen.getByText('team_growth')).toBeTruthy();
    expect(screen.getByText('149.00 EUR')).toBeTruthy();
    expect(screen.getByText('Awaiting payment')).toBeTruthy();
  });

  it('renders the payment_id row only when payment_id is non-null', () => {
    const { rerender } = render(<CryptoOrderSummaryCard order={makeOrder()} />);
    expect(screen.queryByText('Payment id')).toBeNull();
    rerender(<CryptoOrderSummaryCard order={makeOrder({ payment_id: 'np_42' })} />);
    expect(screen.getByText('Payment id')).toBeTruthy();
    expect(screen.getByText('np_42')).toBeTruthy();
  });

  it('renders the optional footer content', () => {
    render(
      <CryptoOrderSummaryCard order={makeOrder()} footer={<button type="button">Cancel</button>} />,
    );
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();
  });

  it('does not render a footer container when none is supplied', () => {
    const { container } = render(<CryptoOrderSummaryCard order={makeOrder()} />);
    // The footer wrapper is a top-level `<div class="mt-4">`; absent ⇒ no
    // button descendants and no element matching that class chain.
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('V-534.BF CryptoOrderSummaryCard — expires_at countdown', () => {
  it('renders "Pay by" row with a remaining-minutes hint on pending orders', () => {
    const expiresAt = '2026-05-11T11:00:00.000Z';
    const nowMs = new Date('2026-05-11T10:15:00.000Z').getTime(); // 45m to go
    render(
      <CryptoOrderSummaryCard order={makeOrder({ expires_at: expiresAt })} nowFn={() => nowMs} />,
    );
    expect(screen.getByText('Pay by')).toBeTruthy();
    // Pay-by timestamp renders via formatTimestamp (locale absolute time), not raw ISO.
    expect(screen.getByText(formatTimestamp(expiresAt))).toBeTruthy();
    expect(screen.getByText(/45m remaining/i)).toBeTruthy();
  });

  it('formats hours + minutes when more than an hour remains', () => {
    const expiresAt = '2026-05-11T12:30:00.000Z';
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime(); // 2h 30m
    render(
      <CryptoOrderSummaryCard order={makeOrder({ expires_at: expiresAt })} nowFn={() => nowMs} />,
    );
    expect(screen.getByText(/2h 30m remaining/i)).toBeTruthy();
  });

  it('reports "pay window elapsed" when expires_at is in the past', () => {
    const expiresAt = '2026-05-11T09:00:00.000Z';
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime();
    render(
      <CryptoOrderSummaryCard order={makeOrder({ expires_at: expiresAt })} nowFn={() => nowMs} />,
    );
    expect(screen.getByText(/pay window elapsed/i)).toBeTruthy();
  });

  it('does NOT render Pay by row when status is not pending', () => {
    render(<CryptoOrderSummaryCard order={makeOrder({ status: 'paid', expires_at: null })} />);
    expect(screen.queryByText('Pay by')).toBeNull();
  });

  it('does NOT render Pay by row when expires_at is null', () => {
    render(<CryptoOrderSummaryCard order={makeOrder({ expires_at: null })} />);
    expect(screen.queryByText('Pay by')).toBeNull();
  });

  it('does NOT render Pay by row when expires_at is undefined (older server)', () => {
    render(<CryptoOrderSummaryCard order={makeOrder()} />);
    expect(screen.queryByText('Pay by')).toBeNull();
  });
});
