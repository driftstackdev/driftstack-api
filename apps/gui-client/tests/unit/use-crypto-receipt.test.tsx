// V-534.AA — unit tests for useCryptoReceipt + formatReceiptForClipboard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CryptoReceiptData } from '../../src/lib/use-crypto-receipt';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoReceipt, formatReceiptForClipboard } =
  await import('../../src/lib/use-crypto-receipt');

function sample(overrides: Partial<CryptoReceiptData> = {}): CryptoReceiptData {
  return {
    order_id: 'ord_42',
    issued_at: '2026-05-11T10:00:00.000Z',
    status: 'paid',
    product: 'solo_manual',
    price_cents: 2500,
    price_currency: 'EUR',
    payment_id: 'np_x',
    paid_at: '2026-05-11T09:55:00.000Z',
    created_at: '2026-05-11T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.AA useCryptoReceipt — fetch', () => {
  it('transitions loading → ready on mount when orderId is supplied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(sample()),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoReceipt('ord_42'));
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.order_id).toBe('ord_42');
      expect(result.current.state.data.status).toBe('paid');
    }
  });

  it('hits the /receipt subpath with bearer auth', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sample()),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoReceipt('ord_x'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders/ord_x/receipt',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
  });

  it('stays idle when orderId is null', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoReceipt(null));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoReceipt('ord_404'));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 404');
    }
  });
});

describe('V-534.AA formatReceiptForClipboard', () => {
  it('includes order id, status, amount, paid_at, payment_id', () => {
    const text = formatReceiptForClipboard(sample());
    expect(text).toContain('Order: ord_42');
    expect(text).toContain('Status: paid');
    expect(text).toContain('Amount: 25.00 EUR');
    expect(text).toContain('Paid at: 2026-05-11T09:55:00.000Z');
    expect(text).toContain('Payment id: np_x');
  });

  it('omits paid_at + payment_id when null', () => {
    const text = formatReceiptForClipboard(sample({ paid_at: null, payment_id: null }));
    expect(text).not.toContain('Paid at:');
    expect(text).not.toContain('Payment id:');
  });

  it('accepts a custom vendor label', () => {
    const text = formatReceiptForClipboard(sample(), 'Acme Co.');
    expect(text.split('\n')[0]).toBe('Acme Co. receipt');
  });
});
