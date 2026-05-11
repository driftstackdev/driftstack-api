// V-534.J — unit tests for useCryptoCheckout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoCheckoutResponse } from '../../src/lib/use-crypto-checkout';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoCheckout } = await import('../../src/lib/use-crypto-checkout');

const SAMPLE: CryptoCheckoutResponse = {
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

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.J useCryptoCheckout — initial state', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useCryptoCheckout());
    expect(result.current.state.kind).toBe('idle');
  });
});

describe('V-534.J useCryptoCheckout.start — happy path', () => {
  it('transitions idle → loading → ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.order.order_id).toBe('ord_abc123def456');
      expect(result.current.state.order.provider).toBe('stub');
    }
  });

  it('serialises product + price + currency in the request body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
      });
    });
    const callArgs = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callArgs?.method).toBe('POST');
    const rawBody = typeof callArgs?.body === 'string' ? callArgs.body : '';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toEqual({
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'USD',
    });
  });
});

describe('V-534.J useCryptoCheckout.start — error paths', () => {
  it('error when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.local' },
    });
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/API key/);
    } else {
      throw new Error('expected error state');
    }
  });

  it('error when fetch returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/422/);
    } else {
      throw new Error('expected error state');
    }
  });

  it('error when fetch rejects with a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('network down');
    } else {
      throw new Error('expected error state');
    }
  });
});

describe('V-534.J useCryptoCheckout.reset', () => {
  it('returns the hook to idle from any state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    expect(result.current.state.kind).toBe('ready');
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.kind).toBe('idle');
  });
});
