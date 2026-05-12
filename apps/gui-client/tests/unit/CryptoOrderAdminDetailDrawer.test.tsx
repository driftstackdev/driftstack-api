// V-534.AM — unit tests for CryptoOrderAdminDetailDrawer.
// V-534.AN — extended for inline edit-note callback.
// V-534.BD — extended for the event-timeline section.
//
// Crypto payments are non-refundable. The drawer carries no refund
// surface; tests verify only the read-only envelope + the edit-note
// action.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// V-534.BD — mock the events hook before importing the drawer.
interface MockEventsState {
  kind: 'idle' | 'loading' | 'ready' | 'error';
  events?: Array<{ status: string; at: string; source: string }>;
  message?: string;
}
const eventsMock: { state: MockEventsState } = vi.hoisted(() => ({
  state: { kind: 'ready' as const, events: [] },
}));
vi.mock('../../src/lib/use-admin-order-events', () => ({
  useAdminOrderEvents: () => ({
    state: eventsMock.state,
    refetch: () => Promise.resolve(),
  }),
}));

const { CryptoOrderAdminDetailDrawer } =
  await import('../../src/components/CryptoOrderAdminDetailDrawer');
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

describe('V-534.AN CryptoOrderAdminDetailDrawer — inline edit-note action', () => {
  it('does NOT render any action button when callbacks are omitted', () => {
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
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
});

describe('V-534.BD CryptoOrderAdminDetailDrawer — events timeline', () => {
  it('renders the timeline section with create + ipn rows', () => {
    eventsMock.state = {
      kind: 'ready',
      events: [
        { status: 'pending', at: '2026-05-11T10:00:00.000Z', source: 'create' },
        { status: 'paid', at: '2026-05-11T10:30:00.000Z', source: 'ipn' },
      ],
    };
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    const timeline = screen.getByLabelText('Order events timeline');
    expect(timeline).toBeTruthy();
    expect(timeline.textContent).toContain('via create');
    expect(timeline.textContent).toContain('via ipn');
    expect(timeline.textContent).toContain('2026-05-11T10:00:00.000Z');
  });

  it('renders a loading message while the fetch is in flight', () => {
    eventsMock.state = { kind: 'loading' };
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Order events timeline').textContent).toContain(
      'Loading timeline',
    );
  });

  it('renders an inline error when the events fetch fails', () => {
    eventsMock.state = { kind: 'error', message: 'HTTP 404' };
    render(<CryptoOrderAdminDetailDrawer order={makeOrder()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Order events timeline').textContent).toContain('HTTP 404');
  });
});
