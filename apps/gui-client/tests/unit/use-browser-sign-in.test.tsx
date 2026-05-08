// V-289 — useBrowserSignIn hook lifecycle tests.
//
// Covers the V-274 state machine across the V-266 browser-OAuth flow:
//   idle → opening (initiate POST) → waiting (poll loop active)
//        → success (bound; onSuccess fires) | error (rejected / expired / timeout)
//
// Test infra: V-288 jsdom + RTL workspace. Uses real timers with the
// V-289 test-only `__pollIntervalMs` / `__pollTimeoutMs` opts to keep
// each test under ~150ms total wall-time. Fake timers + waitFor()
// deadlock under React's batched setState scheduling, so the hook
// exposes timing knobs for tests instead of forcing the test to
// drive timers manually.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(() => Promise.resolve()),
}));

// V-328 — deep-link plugin mock. Default: register listener that
// never fires (existing tests cover the polling fallback path). New
// V-328 tests pass `__onOpenUrl` directly to drive a synthetic
// deep-link arrival.
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));

const { useBrowserSignIn } = await import('../../src/lib/browser-sign-in');
const { open: mockOpenInBrowser } = await import('@tauri-apps/plugin-shell');

interface FetchResponseShape {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function makeResponse(body: unknown, status = 200): FetchResponseShape {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const initiateBody = {
  code: 'abc123code',
  browser_url: 'http://localhost:5173/cli/authorize?code=abc123code&state=stateXXX',
  expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

// 5ms poll cadence + 100ms backstop — keeps tests fast under real timers.
const TEST_TIMING = { __pollIntervalMs: 5, __pollTimeoutMs: 100 };

function defaultOpts(onSuccess = vi.fn(() => Promise.resolve())) {
  return {
    baseUrl: 'http://localhost:3000',
    clientLabel: 'test',
    onSuccess,
    ...TEST_TIMING,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(mockOpenInBrowser).mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch') as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('useBrowserSignIn — happy path: initiate → poll pending → poll bound → success', () => {
  it('walks the full state machine + fires onSuccess with apiKey + accountId', async () => {
    const onSuccess = vi.fn(() => Promise.resolve());

    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody)) // initiate
      .mockResolvedValueOnce(makeResponse({ status: 'pending' })) // first poll
      .mockResolvedValueOnce(
        makeResponse({
          status: 'bound',
          api_key: 'ds_test_pjv4anxbxksg7xie5c5oxspiqdtyuvcu',
          account_id: 'acc_4b51130b-4621-4d14-affe-89470fe6a297',
        }),
      ); // second poll

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts(onSuccess)));

    expect(result.current.state.kind).toBe('idle');

    act(() => {
      result.current.start();
    });

    // Initiate fetch resolves → open() called + state advances. Under
    // 5ms-poll timing the 'waiting' window is too small to reliably
    // observe; drive directly to the terminal 'success' state.
    await waitFor(
      () => {
        expect(result.current.state.kind).toBe('success');
      },
      { timeout: 200 },
    );

    expect(mockOpenInBrowser).toHaveBeenCalledWith(initiateBody.browser_url);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(
      'ds_test_pjv4anxbxksg7xie5c5oxspiqdtyuvcu',
      'acc_4b51130b-4621-4d14-affe-89470fe6a297',
    );
  });
});

describe('useBrowserSignIn — error paths', () => {
  it('initiate rejection → error state with the server-supplied detail', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse({ detail: 'rate limited' }, 429));

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('error');
    });
    expect(result.current.state.kind === 'error' && result.current.state.message).toBe(
      'rate limited',
    );
  });

  it('exchange returns expired → error state', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody))
      .mockResolvedValue(makeResponse({ status: 'expired' }));

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(
      () => {
        expect(result.current.state.kind).toBe('error');
      },
      { timeout: 200 },
    );
  });

  it('exchange returns 4xx → error state stops the poll loop', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody))
      .mockResolvedValue(makeResponse({ detail: 'state mismatch' }, 400));

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(
      () => {
        expect(result.current.state.kind).toBe('error');
      },
      { timeout: 200 },
    );
    expect(result.current.state.kind === 'error' && result.current.state.message).toBe(
      'state mismatch',
    );
  });

  it('100ms backstop fires on prolonged waiting → error state', async () => {
    fetchSpy.mockImplementation((url: RequestInfo | URL) => {
      // RequestInfo is `string | Request`; both stringify usefully.
      // Forcing through a typed branch avoids the @ts-eslint
      // `no-base-to-string` lint complaint about Request → '[object Object]'.
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (u.includes('/initiate')) return Promise.resolve(makeResponse(initiateBody) as Response);
      // Every poll returns pending — only the timeout will move us forward.
      return Promise.resolve(makeResponse({ status: 'pending' }) as Response);
    });

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('waiting');
    });

    // Backstop is 100ms; wait past it.
    await waitFor(
      () => {
        expect(result.current.state.kind).toBe('error');
      },
      { timeout: 500 },
    );
  });
});

describe('useBrowserSignIn — V-328 deep-link primary path', () => {
  it('deep-link arrival fast-paths to success without waiting for the poll', async () => {
    const onSuccess = vi.fn(() => Promise.resolve());

    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody)) // initiate
      .mockResolvedValueOnce(
        makeResponse({
          status: 'bound',
          api_key: 'ds_test_pjv4anxbxksg7xie5c5oxspiqdtyuvcu',
          account_id: 'acc_4b51130b-4621-4d14-affe-89470fe6a297',
        }),
      ); // exchange triggered by deep-link handler

    let triggerDeepLink: ((urls: string[]) => void) | null = null;
    const __onOpenUrl = vi.fn((handler: (urls: string[]) => void) => {
      triggerDeepLink = handler;
      return Promise.resolve(() => {
        triggerDeepLink = null;
      });
    });

    const { result } = renderHook(() =>
      useBrowserSignIn({
        ...defaultOpts(onSuccess),
        // Make the poll cadence very long so this test is purely about
        // the deep-link path firing the exchange.
        __pollIntervalMs: 60_000,
        __onOpenUrl,
      }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(triggerDeepLink).not.toBeNull();
    });

    // Fire the deep-link with the expected code + state.
    const stateValue =
      result.current.state.kind === 'waiting' ? result.current.state.state : 'unknown';
    act(() => {
      triggerDeepLink!([
        `driftstack://auth/callback?code=${initiateBody.code}&state=${stateValue}`,
      ]);
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('success');
    });

    expect(onSuccess).toHaveBeenCalledWith(
      'ds_test_pjv4anxbxksg7xie5c5oxspiqdtyuvcu',
      'acc_4b51130b-4621-4d14-affe-89470fe6a297',
    );
  });

  it('deep-link with mismatched state is silently ignored (no exchange call)', async () => {
    const onSuccess = vi.fn(() => Promise.resolve());

    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody)) // initiate
      .mockResolvedValue(makeResponse({ status: 'pending' })); // any subsequent poll

    let triggerDeepLink: ((urls: string[]) => void) | null = null;
    const __onOpenUrl = vi.fn((handler: (urls: string[]) => void) => {
      triggerDeepLink = handler;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() =>
      useBrowserSignIn({
        ...defaultOpts(onSuccess),
        __onOpenUrl,
      }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(triggerDeepLink).not.toBeNull();
    });

    // Mismatched state — should be ignored. result stays in waiting.
    act(() => {
      triggerDeepLink!([`driftstack://auth/callback?code=${initiateBody.code}&state=WRONG_STATE`]);
    });

    // Deep-link triggered no exchange (state must match). Existing
    // poll loop still pending.
    await new Promise((r) => setTimeout(r, 30));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('falls back to polling when onOpenUrl throws (plugin unavailable)', async () => {
    const onSuccess = vi.fn(() => Promise.resolve());

    fetchSpy.mockResolvedValueOnce(makeResponse(initiateBody)).mockResolvedValueOnce(
      makeResponse({
        status: 'bound',
        api_key: 'ds_test_pjv4anxbxksg7xie5c5oxspiqdtyuvcu',
        account_id: 'acc_4b51130b-4621-4d14-affe-89470fe6a297',
      }),
    );

    const __onOpenUrl = vi.fn(() => Promise.reject(new Error('plugin unavailable')));

    const { result } = renderHook(() =>
      useBrowserSignIn({
        ...defaultOpts(onSuccess),
        __onOpenUrl,
      }),
    );

    act(() => {
      result.current.start();
    });

    // Polling is still primary in this scenario; success arrives via
    // the second fetch (the exchange call).
    await waitFor(
      () => {
        expect(result.current.state.kind).toBe('success');
      },
      { timeout: 200 },
    );

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('useBrowserSignIn — cleanup paths', () => {
  it('cancel() returns to idle + stops the poll loop', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody))
      .mockResolvedValue(makeResponse({ status: 'pending' }));

    const { result } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('waiting');
    });

    const fetchCallsBeforeCancel = fetchSpy.mock.calls.length;

    act(() => {
      result.current.cancel();
    });
    expect(result.current.state.kind).toBe('idle');

    // After cancel, real-time waiting MUST NOT trigger more fetches.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy.mock.calls.length).toBe(fetchCallsBeforeCancel);
  });

  it('unmount stops timers — no fetches fire after the hook tears down', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(initiateBody))
      .mockResolvedValue(makeResponse({ status: 'pending' }));

    const { result, unmount } = renderHook(() => useBrowserSignIn(defaultOpts()));

    act(() => {
      result.current.start();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('waiting');
    });

    const fetchCallsBeforeUnmount = fetchSpy.mock.calls.length;
    unmount();

    // Wait past several poll intervals after unmount — no leaks.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy.mock.calls.length).toBe(fetchCallsBeforeUnmount);
  });
});
