// V-534.K — unit tests for CryptoCheckoutView.
//
// The hook is mocked so each test pins one observable state; the
// view's only contract is rendering the right surface for each.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  CryptoCheckoutResponse,
  CryptoCheckoutState,
  UseCryptoCheckoutResult,
} from '../../src/lib/use-crypto-checkout';

const startSpy = vi.fn(() => Promise.resolve());
const resetSpy = vi.fn();
const useCryptoCheckoutMock = vi.fn<() => UseCryptoCheckoutResult>();
vi.mock('../../src/lib/use-crypto-checkout', () => ({
  useCryptoCheckout: () => useCryptoCheckoutMock(),
}));

const { CryptoCheckoutView } = await import('../../src/views/CryptoCheckoutView');

const OPTIONS = [
  { product: 'trial_pack', label: 'Trial pack ($2.99)', price_cents: 299, price_currency: 'USD' },
  {
    product: 'solo_manual',
    label: 'Solo Manual ($25/mo)',
    price_cents: 2500,
    price_currency: 'USD',
  },
];

function setState(state: CryptoCheckoutState): void {
  useCryptoCheckoutMock.mockReturnValue({ state, start: startSpy, reset: resetSpy });
}

const READY_ORDER: CryptoCheckoutResponse = {
  order_id: 'ord_abc123def456',
  product: 'trial_pack',
  price_cents: 299,
  price_currency: 'USD',
  status: 'pending',
  provider: 'stub',
  payment_address: null,
  pay_currency: null,
  created_at: '2026-05-11T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('V-534.K CryptoCheckoutView — idle/picker render', () => {
  it('renders the product picker + "Pay with crypto" button when idle', () => {
    setState({ kind: 'idle' });
    render(<CryptoCheckoutView options={OPTIONS} />);
    expect(screen.getByLabelText(/product/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /pay with crypto/i })).toBeTruthy();
  });

  it('disables the button while the hook is loading + shows progress label', () => {
    setState({ kind: 'loading' });
    render(<CryptoCheckoutView options={OPTIONS} />);
    const btn = screen.getByRole<HTMLButtonElement>('button', { name: /minting order/i });
    expect(btn.disabled).toBe(true);
  });
});

describe('V-534.K CryptoCheckoutView — submit', () => {
  it('calls start() with the selected option on click', () => {
    setState({ kind: 'idle' });
    render(<CryptoCheckoutView options={OPTIONS} />);
    const picker = screen.getByLabelText<HTMLSelectElement>(/product/i);
    fireEvent.change(picker, { target: { value: 'solo_manual' } });
    fireEvent.click(screen.getByRole('button', { name: /pay with crypto/i }));
    expect(startSpy).toHaveBeenCalledWith({
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'USD',
    });
  });
});

describe('V-534.K CryptoCheckoutView — error', () => {
  it('shows an alert with the message when the hook errors', () => {
    setState({ kind: 'error', message: 'HTTP 422' });
    render(<CryptoCheckoutView options={OPTIONS} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/HTTP 422/);
  });
});

describe('V-534.K CryptoCheckoutView — ready (provider=stub)', () => {
  it('renders the order_id + "support will reach out" notice when provider is stub', () => {
    setState({ kind: 'ready', order: READY_ORDER });
    render(<CryptoCheckoutView options={OPTIONS} />);
    expect(screen.getByText(/ord_abc123def456/)).toBeTruthy();
    expect(screen.getByText(/email you a payment address/i)).toBeTruthy();
    // The product picker is hidden once the order is ready.
    expect(screen.queryByLabelText(/product/i)).toBeNull();
  });

  it('renders the deposit address when provider is the real nowpayments flow', () => {
    setState({
      kind: 'ready',
      order: {
        ...READY_ORDER,
        provider: 'nowpayments',
        payment_address: 'bc1qexampledepositaddress',
        pay_currency: 'btc',
      },
    });
    render(<CryptoCheckoutView options={OPTIONS} />);
    expect(screen.getByText(/bc1qexampledepositaddress/)).toBeTruthy();
    expect(screen.queryByText(/email you a payment address/i)).toBeNull();
  });

  it('clicking "Start another order" invokes reset()', () => {
    setState({ kind: 'ready', order: READY_ORDER });
    render(<CryptoCheckoutView options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: /start another order/i }));
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });
});
