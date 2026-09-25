import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useConnectionStatus } from '../../src/lib/use-connection-status';
import { ConnectionPill } from '../../src/components/ConnectionPill';
import { RIDE_OUT_BUDGET_MS, resetApiReachabilityForTests } from '../../src/lib/client';

/**
 * GUI audit #20 — the title-bar pill said "Offline" for ANY non-OK /version
 * answer, so a server that answered 429 (rate-limited) or 5xx sent customers off
 * to check their network. A server that answers is reachable: those read as a
 * busy server; "Offline" stays for no answer at all.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetApiReachabilityForTests();
});

function answer(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('', { status }))),
  );
}

describe('the connection pill when the server answers but is busy', () => {
  it.each([429, 500, 503])(
    'CRITICAL HTTP %i reads as a busy server, not offline',
    async (status) => {
      answer(status);
      const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));
      await waitFor(() => expect(result.current.state).not.toBe('connecting'));
      expect(result.current.state).toBe('degraded');

      render(<ConnectionPill status={result.current} baseUrl="https://api.driftstack.dev" />);
      expect(screen.getByText('Server busy')).toBeInTheDocument();
      expect(screen.queryByText('Offline')).toBeNull();
    },
  );

  it('CONTROL — no answer at all is still offline once it LASTS (2026-09-24: a restart of a few seconds reads as busy first)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Load failed'))),
    );
    const { result } = renderHook(() => useConnectionStatus('https://api.driftstack.dev'));
    await waitFor(() => expect(result.current.state).toBe('degraded'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RIDE_OUT_BUDGET_MS + 4_000);
    });
    await waitFor(() => expect(result.current.state).toBe('offline'));
  });
});
