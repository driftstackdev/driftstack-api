// V-534.W — unit tests for useCryptoOrdersList.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CryptoOrdersListData } from '../../src/lib/use-crypto-orders-list';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoOrdersList } = await import('../../src/lib/use-crypto-orders-list');

const SAMPLE: CryptoOrdersListData = {
  orders: [
    {
      order_id: 'ord_1',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
      payment_id: null,
      status: 'pending',
      created_at: '2026-05-11T10:00:00.000Z',
      updated_at: '2026-05-11T10:00:00.000Z',
    },
    {
      order_id: 'ord_2',
      product: 'team_manual',
      price_cents: 8000,
      price_currency: 'EUR',
      payment_id: 'np_42',
      status: 'paid',
      created_at: '2026-05-10T09:00:00.000Z',
      updated_at: '2026-05-10T10:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.W useCryptoOrdersList — auto-fetch', () => {
  it('transitions loading → ready with the orders array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoOrdersList());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.orders).toHaveLength(2);
      expect(result.current.state.data.orders[0]?.order_id).toBe('ord_1');
    }
  });

  it('omits ?limit when not specified', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders',
    );
  });

  it('passes ?limit when specified', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoOrdersList({ limit: 10 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders?limit=10',
    );
  });
});

describe('V-534.W useCryptoOrdersList — error paths', () => {
  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 500');
    }
  });
});

describe('V-534.W useCryptoOrdersList — manual mode', () => {
  it('manual=true starts idle and does not auto-fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetch() advances from idle → ready', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
