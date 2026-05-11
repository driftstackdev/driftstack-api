// V-534.AM — unit tests for CryptoOrderAdminDetailDrawer.
// V-534.AN — extended for inline action callbacks.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CryptoOrderAdminDetailDrawer } from '../../src/components/CryptoOrderAdminDetailDrawer';
import type { AdminCryptoOrder } from '../../src/lib/use-admin-crypto-orders-list';

function makeOrder(overrides: Partial<AdminCryptoOrder> = {}): AdminCryptoOrder {
  return {
    order_id: 'ord_abc',
    account_id: 'acc_buyer',
    product: 'team_growth',
    price_cents: 14900,
    price_currency: 'EUR',
    payment_id: null,
    status: 'paid',
    customer_note: null,
    refund_requested_at: null,
    refund_reason: null,
    internal_note: null,
    created_at: '2026-05-11T09:00:00.000Z',
    updated_at: '2026-05-11T09:30:00.000Z',
    ...overrides,
  };
}

describe('V-534.AM CryptoOrderAdminDetailDrawer', () => {
  it('renders the full envelope: id, account, status, amount, timestamps', () => {
    render(
      <CryptoOrderAdminDetailDrawer order={makeOrder({ payment_id: 'np_42' })} onClose={vi.fn()} />,
    );
    expect(screen.getByText('ord_abc')).toBeTruthy();
    expect(screen.getByText('acc_buyer')).toBeTruthy();
    expect(screen.getByText('team_growth')).toBeTruthy();
    expect(screen.getByText('149.00 EUR')).toBeTruthy();
    expect(screen.getByText('np_42')).toBeTruthy();
    expect(screen.getByText('2026-05-11T09:00:00.000Z')).toBeTruthy();
  });

  it('shows the "Refund pending" pill + refund detail when refund_requested_at is set', () => {
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({
          refund_requested_at: '2026-05-11T10:00:00.000Z',
          refund_reason: 'duplicate payment',
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/Refund pending/i)).toBeTruthy();
    expect(screen.getByText('2026-05-11T10:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('duplicate payment')).toBeTruthy();
  });

  it('shows the "No refund recorded" placeholder when no refund is outstanding', () => {
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    expect(screen.getByText('No refund recorded.')).toBeTruthy();
  });

  it('renders customer_note + internal_note when both are present', () => {
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({
          customer_note: 'PO-12345',
          internal_note: 'VIP, monitor for chargeback',
        })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('PO-12345')).toBeTruthy();
    expect(screen.getByText('VIP, monitor for chargeback')).toBeTruthy();
  });

  it('shows placeholder text when customer_note or internal_note are null', () => {
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    expect(screen.getByText('No customer note.')).toBeTruthy();
    expect(screen.getByText('No internal note.')).toBeTruthy();
  });

  it('calls onClose when the Close button is clicked', () => {
    const onClose = vi.fn();
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Close order detail/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sets aria-label on the aside to the order id', () => {
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Order detail for ord_abc')).toBeTruthy();
  });
});

describe('V-534.AN CryptoOrderAdminDetailDrawer — inline actions', () => {
  it('does NOT render any action button when callbacks are omitted', () => {
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    // The only button present should be Close.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Close');
  });

  it('renders Edit/Add note when onEditNote is provided + fires the callback', () => {
    const onEditNote = vi.fn();
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({ internal_note: null })}
        onClose={vi.fn()}
        onEditNote={onEditNote}
      />,
    );
    const btn = screen.getByRole('button', { name: /Add note/i });
    fireEvent.click(btn);
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote.mock.calls[0]?.[0]).toMatchObject({ order_id: 'ord_abc' });
  });

  it('label flips to "Edit note" when an internal_note already exists', () => {
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({ internal_note: 'existing context' })}
        onClose={vi.fn()}
        onEditNote={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Edit note/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add note/i })).toBeNull();
  });

  it('renders "Request refund" only for paid orders with no outstanding refund', () => {
    const onRequestRefund = vi.fn();
    const { rerender } = render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({ status: 'pending' })}
        onClose={vi.fn()}
        onRequestRefund={onRequestRefund}
      />,
    );
    expect(screen.queryByRole('button', { name: /Request refund/i })).toBeNull();
    rerender(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({ status: 'paid' })}
        onClose={vi.fn()}
        onRequestRefund={onRequestRefund}
      />,
    );
    expect(screen.getByRole('button', { name: /Request refund/i })).toBeTruthy();
  });

  it('renders "Clear refund" only when refund_requested_at is set + fires the callback', () => {
    const onCancelRefund = vi.fn();
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({
          refund_requested_at: '2026-05-11T10:00:00.000Z',
          refund_reason: 'duplicate',
        })}
        onClose={vi.fn()}
        onCancelRefund={onCancelRefund}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Clear refund' });
    fireEvent.click(btn);
    expect(onCancelRefund).toHaveBeenCalledTimes(1);
  });

  it('hides "Request refund" when a refund is already outstanding (even on paid orders)', () => {
    render(
      <CryptoOrderAdminDetailDrawer
        order={makeOrder({
          status: 'paid',
          refund_requested_at: '2026-05-11T10:00:00.000Z',
          refund_reason: 'r',
        })}
        onClose={vi.fn()}
        onRequestRefund={vi.fn()}
        onCancelRefund={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Request refund/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear refund' })).toBeTruthy();
  });
});
