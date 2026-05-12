// V-534.BD — unit tests for useAdminOrderEvents.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminOrderEvents } = await import('../../src/lib/use-admin-order-events');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.BD useAdminOrderEvents', () => {
  it('idle when orderId is null', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminOrderEvents(null));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches /events on mount and exposes the timeline', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            events: [
              { status: 'pending', at: '2026-05-11T10:00:00.000Z', source: 'create' },
              { status: 'paid', at: '2026-05-11T10:30:00.000Z', source: 'ipn' },
            ],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminOrderEvents('ord_a'));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.events).toHaveLength(2);
      expect(result.current.state.events[0]?.source).toBe('create');
      expect(result.current.state.events[1]?.source).toBe('ipn');
    }
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/v1/admin/crypto-orders/ord_a/events');
  });

  it('encodes the orderId in the URL', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminOrderEvents('ord/with?special'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('ord%2Fwith%3Fspecial');
  });

  it('reports HTTP errors', async () => {
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
    const { result } = renderHook(() => useAdminOrderEvents('ord_a'));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toContain('404');
    }
  });

  it('reports a missing API key', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderHook(() => useAdminOrderEvents('ord_a'));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });
});
