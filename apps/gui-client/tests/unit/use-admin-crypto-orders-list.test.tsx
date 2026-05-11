// V-534.AG — unit tests for useAdminCryptoOrdersList.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminCryptoOrdersList } = await import('../../src/lib/use-admin-crypto-orders-list');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.AG useAdminCryptoOrdersList', () => {
  it('fetches /v1/admin/crypto-orders on mount + sets ready state', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => {
      expect(result.current.state.kind).toBe('ready');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/v1/admin/crypto-orders');
  });

  it('appends status + search + accountId + limit to the URL', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() =>
      useAdminCryptoOrdersList({
        status: 'paid',
        search: 'PO-9',
        accountId: 'acc_x',
        limit: 100,
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('status=paid');
    expect(url).toContain('search=PO-9');
    expect(url).toContain('account_id=acc_x');
    expect(url).toContain('limit=100');
  });

  it('trims and omits empty-string search / accountId', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminCryptoOrdersList({ search: '   ', accountId: '' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('search=');
    expect(url).not.toContain('account_id=');
  });

  it('maps HTTP error to error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => {
      expect(result.current.state.kind).toBe('error');
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 403');
    }
  });

  it('refetch re-runs the request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
