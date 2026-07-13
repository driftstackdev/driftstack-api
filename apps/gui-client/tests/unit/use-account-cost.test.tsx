// V-534.H — unit tests for useAccountCost.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AccountCostResponse } from '../../src/lib/use-account-cost';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAccountCost } = await import('../../src/lib/use-account-cost');

const SAMPLE: AccountCostResponse = {
  account_id: 'acc_test',
  billing_cycle: '2026-05',
  tier: 'api_builder',
  breakdown: {
    computeCents: 120,
    storageCents: 20,
    egressCents: 5,
    emailCents: 5,
    llmCents: 180,
    totalCents: 330,
    thresholdState: 'under-soft',
  },
};

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('V-534.H useAccountCost — auto-fetch on mount', () => {
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
    const { result } = renderHook(() => useAccountCost({ billingCycle: '2026-05' }));
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.breakdown.totalCents).toBe(330);
    }
  });

  it('includes billing_cycle in the query string when provided', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAccountCost({ billingCycle: '2026-04' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(typeof calledUrl).toBe('string');
    expect(calledUrl).toContain('/v1/account/cost?billing_cycle=2026-04');
  });

  it('sends Bearer auth header with the settings apiKey', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAccountCost());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test');
    expect(init.signal).toBeTruthy();
  });
});

describe('V-534.H useAccountCost — error paths', () => {
  it('sets error state on a non-2xx response', async () => {
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
    const { result } = renderHook(() => useAccountCost());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toContain('500');
    }
  });

  it('sets error state when fetch rejects (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const { result } = renderHook(() => useAccountCost());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('Check your connection and try again.');
    }
  });

  it('sets error when apiKey is missing', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.local' },
    });
    const { result } = renderHook(() => useAccountCost());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/api key/i);
    }
  });
});

describe('V-534.H useAccountCost — manual + refetch', () => {
  it('keeps the newest refetch result when an older response arrives late', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
    const { result } = renderHook(() => useAccountCost({ manual: true }));

    const older = result.current.refetch();
    const newer = result.current.refetch();
    resolveSecond(
      new Response(
        JSON.stringify({
          ...SAMPLE,
          breakdown: { ...SAMPLE.breakdown, totalCents: 999 },
        }),
        { status: 200 },
      ),
    );
    await act(async () => newer);
    resolveFirst(
      new Response(
        JSON.stringify({
          ...SAMPLE,
          breakdown: { ...SAMPLE.breakdown, totalCents: 111 },
        }),
        { status: 200 },
      ),
    );
    await act(async () => older);

    expect(result.current.state.kind).toBe('ready');
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.breakdown.totalCents).toBe(999);
    }
  });

  it('manual=true skips auto-fetch; refetch() fires the request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAccountCost({ manual: true }));
    // Give the effect a chance to NOT fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('idle');
    await result.current.refetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
  });
});
