import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

/**
 * GUI audit #14 — the shell plugin's URL list in the capability file is never
 * consulted (`open` takes no scope; any http(s) URL passes the plugin's built-in
 * pattern), so the sign-in page URL the server returns from /initiate was opened
 * in the default browser unchecked: a man-in-the-middle, or a server that is not
 * the one it claims to be, could send the customer anywhere.
 *
 * The app now opens it only when it is this deployment's sign-in page for THIS
 * flow: on Driftstack's own cloud, the dashboard's `/cli/authorize`; anywhere,
 * https (or a loopback http for a local server) and carrying the code the server
 * just issued. Anything else ends the flow with a plain error and opens nothing.
 */

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));

const { useBrowserSignIn } = await import('../../src/lib/browser-sign-in');
const { open: openInBrowser } = await import('@tauri-apps/plugin-shell');

function initiate(browserUrl: string): Response {
  return new Response(
    JSON.stringify({
      code: 'abc123code',
      user_code: 'ABCD-EFGH',
      browser_url: browserUrl,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

let fetchSpy: MockInstance<typeof globalThis.fetch>;
beforeEach(() => {
  vi.mocked(openInBrowser).mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
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

async function startWith(baseUrl: string, browserUrl: string): Promise<{ kind: string }> {
  fetchSpy.mockImplementation((url: RequestInfo | URL) =>
    Promise.resolve(
      urlOf(url).endsWith('/initiate')
        ? initiate(browserUrl)
        : new Response(JSON.stringify({ status: 'pending' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
  const { result, unmount } = renderHook(() =>
    useBrowserSignIn({ baseUrl, onSuccess: vi.fn(), __pollIntervalMs: 5, __pollTimeoutMs: 5_000 }),
  );
  act(() => result.current.start());
  await waitFor(() => expect(['waiting', 'error']).toContain(result.current.state.kind));
  const state = result.current.state;
  act(() => result.current.cancel());
  unmount();
  return state;
}

describe('the page browser sign-in opens', () => {
  it.each([
    [
      'a phishing host',
      'https://app-driftstack.io.evil.example/cli/authorize?code=abc123code&state=s',
    ],
    [
      'plain http to a remote host',
      'http://app.driftstack.io/cli/authorize?code=abc123code&state=s',
    ],
    ['another path on the right host', 'https://app.driftstack.io/billing?code=abc123code'],
    ['another flow’s code', 'https://app.driftstack.io/cli/authorize?code=someone-else&state=s'],
    ['a non-web scheme', 'file:///Applications/Calculator.app'],
  ])('CRITICAL on the cloud, %s is refused and nothing is opened', async (_what, browserUrl) => {
    const state = await startWith('https://api.driftstack.dev', browserUrl);
    expect(state.kind).toBe('error');
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('CONTROL — the cloud dashboard sign-in page for this flow is opened', async () => {
    const url = 'https://app.driftstack.io/cli/authorize?code=abc123code&state=s';
    const state = await startWith('https://api.driftstack.dev', url);
    expect(state.kind).toBe('waiting');
    expect(openInBrowser).toHaveBeenCalledWith(url);
  });

  it('CONTROL — a self-hosted server may use its own dashboard host, over https', async () => {
    const url = 'https://dashboard.acme.example/cli/authorize?code=abc123code&state=s';
    const state = await startWith('https://driftstack.acme.example', url);
    expect(state.kind).toBe('waiting');
    expect(openInBrowser).toHaveBeenCalledWith(url);
  });

  it('CONTROL — a local development server may use a loopback http dashboard', async () => {
    const url = 'http://localhost:5173/cli/authorize?code=abc123code&state=s';
    const state = await startWith('http://localhost:3000', url);
    expect(state.kind).toBe('waiting');
  });
});
