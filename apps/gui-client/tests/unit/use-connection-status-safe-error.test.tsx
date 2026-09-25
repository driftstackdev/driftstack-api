import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_ANSWERING_YET, useConnectionStatus } from '../../src/lib/use-connection-status';
import { RIDE_OUT_BUDGET_MS, resetApiReachabilityForTests } from '../../src/lib/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // The server's reachability is shared with the API client (module state).
  resetApiReachabilityForTests();
});

describe('useConnectionStatus safe diagnostics', () => {
  it('does not retain native network exception text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(
          new Error('getaddrinfo ENOTFOUND private-api.internal /Users/customer token=secret'),
        ),
      ),
    );

    // 2026-09-24 — no answer reads as "not answering, retrying" while young (a
    // restart looks like this), and as Offline once it has lasted. Neither
    // state may carry the native exception text.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));

    await waitFor(() => expect(result.current.state).toBe('degraded'));
    expect(result.current.lastError).toBe(NOT_ANSWERING_YET);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RIDE_OUT_BUDGET_MS + 4_000);
    });
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(result.current.lastError).toBe('Connection check failed. Open Settings and try again.');
    expect(result.current.lastError).not.toMatch(/private-api|\/Users|token=secret/i);
  });

  it.each([
    [401, 'Your sign-in or API key was not accepted. Check Settings and try again.', 'offline'],
    // GUI audit #20 — a server that answers 429 / 5xx is busy, not offline.
    [429, 'The server is receiving too many requests. Try again shortly.', 'degraded'],
    [503, 'The service is temporarily unavailable. Try again shortly.', 'degraded'],
    [418, 'The server returned an unexpected response. Check Settings and try again.', 'offline'],
  ])('maps HTTP %i without exposing a bare status', async (status, expected, state) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status }))),
    );

    const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));

    await waitFor(() => expect(result.current.state).toBe(state));
    expect(result.current.lastError).toBe(expected);
    expect(result.current.lastError).not.toContain(`HTTP ${status.toString()}`);
  });

  it('keeps timeout guidance explicit without retaining the thrown message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(new DOMException('private upstream timed out token=secret', 'AbortError')),
      ),
    );

    const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));

    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(result.current.lastError).toBe(
      'Connection check timed out. Check your connection and try again.',
    );
    expect(result.current.lastError).not.toContain('token=secret');
  });

  it('preserves successful driver and live-agent observability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ driver: 'mock', agent_execution: 'live' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));

    await waitFor(() => expect(result.current.state).toBe('connected'));
    expect(result.current.driver).toBe('mock');
    expect(result.current.agentExecution).toBe('live');
    expect(result.current.lastError).toBeNull();
    expect(result.current.lastOkAt).not.toBeNull();
  });
});
