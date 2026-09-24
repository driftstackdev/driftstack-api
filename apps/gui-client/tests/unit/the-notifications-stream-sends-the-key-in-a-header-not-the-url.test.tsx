import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * GUI audit #15 — the notifications stream sent the account key, which never
 * expires, in its URL on every launch (`?ds_token=<key>`), because a browser
 * EventSource cannot set headers. The server redacts that parameter in its own
 * logs, but anything in between that logs URLs — a CDN or edge in front of the
 * API, a corporate TLS-inspecting proxy — saw the key. The stream is now read
 * with `fetch`, which can send `Authorization: Bearer …`; the server's
 * `requireAuthEventSource` reads that header first. The URL carries no
 * credential.
 */

const KEY = 'ds_live_account_key_that_never_expires';
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ settings: { apiKey: KEY, baseUrl: 'https://api.driftstack.dev/' } }),
}));

const { useNotifications } = await import('../../src/lib/use-notifications');

function sseResponse(frames: string): Response {
  const bytes = new TextEncoder().encode(frames);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        // The stream stays open, as a live SSE stream does.
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const INCIDENT = {
  kind: 'incident.broadcast',
  accountId: 'acc_1',
  incidentId: 'inc_1',
  severity: 'minor',
  title: 'Degraded launches in one region',
  at: '2026-09-24T00:00:00.000Z',
};

let fetchSpy: MockInstance<typeof globalThis.fetch>;
beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(
        sseResponse(
          `: heartbeat\n\nevent: incident.broadcast\ndata: ${JSON.stringify(INCIDENT)}\n\n`,
        ),
      ),
    );
});
afterEach(() => {
  fetchSpy.mockRestore();
});

/** The request URL as a string, whatever form fetch was given it in. */
function urlOf(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

describe('the notifications stream', () => {
  it('CRITICAL carries the account key in the Authorization header, never in the URL', async () => {
    const { result, unmount } = renderHook(() => useNotifications());
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const href = url === undefined ? '' : urlOf(url);
    expect(href).toBe('https://api.driftstack.dev/v1/account/me/notifications');
    expect(href).not.toContain(KEY);
    expect(href).not.toContain('ds_token');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    // …and the stream still works: the frame arrives as an event.
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0]).toMatchObject({
      kind: 'incident.broadcast',
      incidentId: 'inc_1',
    });
    expect(result.current.connection).toBe('open');
    unmount();
  });

  it('a refused key closes the stream (as a browser EventSource does) rather than retrying it', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const { result, unmount } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.connection).toBe('closed'));
    unmount();
  });
});
