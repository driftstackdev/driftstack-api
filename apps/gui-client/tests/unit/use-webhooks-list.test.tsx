// V-534.S — unit tests for useWebhooksList.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { WebhooksListResponse } from '../../src/lib/use-webhooks-list';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useWebhooksList } = await import('../../src/lib/use-webhooks-list');

const SAMPLE: WebhooksListResponse = {
  webhooks: [
    {
      id: 'wh_1',
      url: 'https://hooks.example/a',
      events: ['session.completed'],
      description: null,
      active: true,
      disabledAt: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      counts: { delivered: 12, failed: 1, dlq: 0 },
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
  vi.useRealTimers();
});

describe('V-534.S useWebhooksList — auto-fetch', () => {
  it('transitions loading → ready', async () => {
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
    const { result } = renderHook(() => useWebhooksList());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.webhooks).toHaveLength(1);
      expect(result.current.state.data.webhooks[0]?.counts.delivered).toBe(12);
    }
  });

  it('calls /v1/webhooks with the bearer Authorization header', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useWebhooksList());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.driftstack.dev/v1/webhooks');
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer sk_test');
    expect(init?.signal).toBeTruthy();
  });
});

describe('V-534.S useWebhooksList — error paths', () => {
  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useWebhooksList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/API key/);
    }
  });

  it('surfaces HTTP non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useWebhooksList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe(
        'The service is temporarily unavailable. Try again shortly.',
      );
    }
  });

  it('surfaces network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const { result } = renderHook(() => useWebhooksList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('Check your connection and try again.');
    }
  });
});

describe('V-534.S useWebhooksList — manual mode', () => {
  it('aborts a stalled refetch after 15 seconds and restores an actionable error state', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const { result } = renderHook(() => useWebhooksList({ manual: true }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refetch();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Webhook request timed out. Check your connection and try again.',
    });
  });

  it('starts idle when manual=true', () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWebhooksList({ manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetch() advances from idle to ready', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWebhooksList({ manual: true }));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
