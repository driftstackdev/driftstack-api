// V-534.Q — unit tests for useAccountMe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { AccountMeData } from '../../src/lib/use-account-me';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAccountMe } = await import('../../src/lib/use-account-me');

const SAMPLE: AccountMeData = {
  account: { id: 'acc_test', email: 'user@example.com', tier: 'solo_manual' },
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

describe('V-534.Q useAccountMe — auto-fetch', () => {
  it('transitions loading → ready with data', async () => {
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
    const { result } = renderHook(() => useAccountMe());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.account.id).toBe('acc_test');
      expect(result.current.state.data.account.tier).toBe('solo_manual');
    }
  });

  it('strips trailing slashes from baseUrl when building the URL', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev///' },
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAccountMe());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.driftstack.dev/v1/account/me');
  });

  it('sends the bearer Authorization header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAccountMe());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer sk_test');
  });
});

describe('V-534.Q useAccountMe — error paths', () => {
  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useAccountMe());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/API key/);
    }
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useAccountMe());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 401');
    }
  });

  it('surfaces network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const { result } = renderHook(() => useAccountMe());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('offline');
    }
  });
});

describe('V-534.Q useAccountMe — manual mode', () => {
  it('starts idle and does not auto-fetch when manual=true', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAccountMe({ manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetch() advances from idle through to ready', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAccountMe({ manual: true }));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
