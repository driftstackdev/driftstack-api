// Unit tests for BillingView — the customer billing/crypto hub that
// wires the previously-unreachable crypto-checkout cluster into nav.
//
// Verifies the three CUSTOMER tabs render, default to "Usage & cost",
// switch on click, and that the checkout tab receives a defaultProduct
// derived from the account tier (with a constant fallback).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

interface MockSettings {
  accountMe: { tier: string } | null;
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

// Stub the three child views with identifiable markers so this test
// pins BillingView's composition + tab switching, not the children's
// own fetch lifecycles (those have their own dedicated tests).
vi.mock('../../src/views/BillingCostView', () => ({
  BillingCostView: () => <div data-testid="cost-view">cost</div>,
}));
vi.mock('../../src/views/CryptoCheckoutFlowView', () => ({
  CryptoCheckoutFlowView: (props: { defaultProduct: string }) => (
    <div data-testid="checkout-view">{props.defaultProduct}</div>
  ),
}));
vi.mock('../../src/views/CryptoOrdersHistoryView', () => ({
  CryptoOrdersHistoryView: () => <div data-testid="orders-view">orders</div>,
}));

const { BillingView } = await import('../../src/views/BillingView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({ accountMe: { tier: 'api_builder' } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BillingView', () => {
  it('renders the three customer tabs', () => {
    render(<BillingView />);
    expect(screen.getByRole('tab', { name: 'Usage & cost' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Top up / Pay' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Orders' })).toBeTruthy();
  });

  it('defaults to the Usage & cost tab', () => {
    render(<BillingView />);
    expect(screen.getByTestId('cost-view')).toBeTruthy();
    expect(screen.queryByTestId('checkout-view')).toBeNull();
    expect(screen.queryByTestId('orders-view')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Usage & cost' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('switches to the checkout tab and passes the tier as defaultProduct', () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Top up / Pay' }));
    const checkout = screen.getByTestId('checkout-view');
    expect(checkout).toBeTruthy();
    // api_builder is a SUPPORTED_PRODUCT → used directly as the default.
    expect(checkout.textContent).toBe('api_builder');
  });

  it('switches to the Orders tab', () => {
    render(<BillingView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    expect(screen.getByTestId('orders-view')).toBeTruthy();
  });

  it('falls back to api_starter when the tier is not a purchasable product', () => {
    useSettingsMock.mockReturnValue({ accountMe: { tier: 'free' } });
    render(<BillingView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Top up / Pay' }));
    expect(screen.getByTestId('checkout-view').textContent).toBe('api_starter');
  });

  it('falls back to api_starter when accountMe is null (unauthenticated/loading)', () => {
    useSettingsMock.mockReturnValue({ accountMe: null });
    render(<BillingView />);
    fireEvent.click(screen.getByRole('tab', { name: 'Top up / Pay' }));
    expect(screen.getByTestId('checkout-view').textContent).toBe('api_starter');
  });
});
