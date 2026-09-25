// Owner item 8, 2026-09-24 — "one calm status, not a spray of ERROR lines".
// During the 11:58:53Z production restart the title-bar pill had two ways to be
// wrong: its own /version probe landing in the gap turned it red "Offline" for
// up to 30 s (the next probe), and the API reads failing under it said nothing
// to it at all. The pill now shares the API client's view of the server:
//   • while a restart is being ridden out it reads "Server busy" with a calm
//     tooltip, never "Offline";
//   • it re-checks every 3 s rather than every 30 s, and the moment the API
//     reads get an answer it re-checks at once, so it returns to Connected.

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_ANSWERING_YET, useConnectionStatus } from '../../src/lib/use-connection-status';
import { ConnectionPill } from '../../src/components/ConnectionPill';
import {
  noteApiAnswered,
  noteApiUnreachable,
  resetApiReachabilityForTests,
} from '../../src/lib/client';

const BASE = 'https://api.driftstack.dev';

function version(): Response {
  return new Response(JSON.stringify({ driver: 'webkit' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetApiReachabilityForTests();
});

describe('the connection pill rides out a restart calmly', () => {
  it('CRITICAL a /version probe that lands in the restart reads "Server busy", then Connected within seconds — never Offline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const restartEndsAt = Date.now() + 5_000;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Date.now() < restartEndsAt
          ? Promise.reject(new TypeError('Load failed'))
          : Promise.resolve(version()),
      ),
    );
    const seen = new Set<string>();
    const { result } = renderHook(() => {
      const status = useConnectionStatus(BASE);
      seen.add(status.state);
      return status;
    });

    await waitFor(() => expect(result.current.state).toBe('degraded'));
    expect(result.current.lastError).toBe(NOT_ANSWERING_YET);
    render(<ConnectionPill status={result.current} baseUrl={BASE} />);
    expect(screen.getByText('Server busy')).toBeInTheDocument();

    // Well inside the old 30 s probe interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    await waitFor(() => expect(result.current.state).toBe('connected'));
    expect(seen.has('offline')).toBe(false);
  });

  it("CRITICAL the API client's failing reads turn a Connected pill to the calm state, and their recovery brings it straight back", async () => {
    let serverUp = true;
    const fetchMock = vi.fn(() =>
      serverUp ? Promise.resolve(version()) : Promise.reject(new TypeError('Load failed')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useConnectionStatus(BASE));
    await waitFor(() => expect(result.current.state).toBe('connected'));

    // The Profiles poll's reads find the server gone (client.ts reports it).
    serverUp = false;
    act(() => {
      noteApiUnreachable(`${BASE}/v1/sessions`, 'GET /v1/sessions → network failure');
    });
    expect(result.current.state).toBe('degraded');
    expect(result.current.lastError).toBe(NOT_ANSWERING_YET);

    // A read gets an answer: the pill re-checks now, not in 30 s.
    serverUp = true;
    const probesBefore = fetchMock.mock.calls.length;
    act(() => {
      noteApiAnswered(`${BASE}/v1/sessions`);
    });
    await waitFor(() => expect(result.current.state).toBe('connected'));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(probesBefore);
  });
});
