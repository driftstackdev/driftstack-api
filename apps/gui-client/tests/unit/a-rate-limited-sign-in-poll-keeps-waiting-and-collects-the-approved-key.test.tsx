import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

/**
 * GUI audit #8 — browser sign-in gave up on the FIRST rate-limited exchange poll.
 *
 * The exchange endpoint is limited per IP before sign-in (60 a minute), and a
 * desktop polls it about 30 times a minute — so two desktops, or a desktop and
 * the CLI, behind one office or carrier NAT empty the bucket together. One 429
 * ended the flow with "A usage limit was reached… review your plan" (a pre-login
 * IP limit has nothing to do with a plan), and the key the user had ALREADY
 * approved in the browser was never collected — it stays active on the account.
 *
 * Now a 429 is a "slow down": the poll waits the server's Retry-After (never less
 * than its own interval) and keeps going until the flow's own deadline.
 *
 * Real timers with the hook's test cadence knobs, as use-browser-sign-in does.
 */

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));

const { useBrowserSignIn } = await import('../../src/lib/browser-sign-in');

const initiateBody = {
  code: 'abc123code',
  user_code: 'ABCD-EFGH',
  browser_url: 'http://localhost:5173/cli/authorize?code=abc123code',
  expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rateLimited(retryAfter?: string): Response {
  return json(
    {
      type: 'https://errors.driftstack.dev/rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Rate limit exceeded.',
    },
    429,
    retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  );
}

const BOUND = {
  status: 'bound',
  api_key: 'ds_live_the_key_the_user_approved',
  account_id: 'acc_4b51130b-4621-4d14-affe-89470fe6a297',
};

let fetchSpy: MockInstance<typeof globalThis.fetch>;
/** Wall-clock time of every exchange call, relative to the first. */
let exchangeTimes: number[];

/** The request URL as a string, whatever form fetch was given it in. */
function urlOf(url: RequestInfo | URL): string {
  if (typeof url === 'string') return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

function serve(exchangeReplies: Array<() => Response>): void {
  let i = 0;
  fetchSpy.mockImplementation((url: RequestInfo | URL) => {
    const u = urlOf(url);
    if (u.endsWith('/initiate')) return Promise.resolve(json(initiateBody));
    exchangeTimes.push(Date.now());
    const reply = exchangeReplies[Math.min(i, exchangeReplies.length - 1)];
    i += 1;
    return Promise.resolve((reply ?? (() => json({ status: 'pending' })))());
  });
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  exchangeTimes = [];
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('a rate-limited exchange poll during browser sign-in', () => {
  it('CRITICAL keeps waiting, honours Retry-After, and collects the key the user approved', async () => {
    serve([() => rateLimited('1'), () => json(BOUND)]);
    const onSuccess = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        onSuccess,
        __pollIntervalMs: 5,
        __pollTimeoutMs: 5_000,
      }),
    );
    act(() => result.current.start());

    await waitFor(() => expect(result.current.state.kind).toBe('success'), { timeout: 4_000 });
    expect(onSuccess).toHaveBeenCalledWith(BOUND.api_key, BOUND.account_id);
    // One refused poll, then nothing until Retry-After (1 s) had passed.
    expect(exchangeTimes.length).toBe(2);
    const gap = (exchangeTimes[1] ?? 0) - (exchangeTimes[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(950);
  });

  it('CRITICAL is never shown as a usage-limit or plan error while the flow is still open', async () => {
    serve([() => rateLimited('1'), () => json({ status: 'pending' })]);
    const { result } = renderHook(() =>
      useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        onSuccess: vi.fn(),
        __pollIntervalMs: 5,
        __pollTimeoutMs: 5_000,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(exchangeTimes.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(result.current.state.kind).toBe('waiting');
    act(() => result.current.cancel());
  });

  it('a 429 without Retry-After still backs off to the poll interval and carries on', async () => {
    serve([() => rateLimited(), () => json(BOUND)]);
    const onSuccess = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        onSuccess,
        __pollIntervalMs: 50,
        __pollTimeoutMs: 5_000,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('success'), { timeout: 2_000 });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('a Retry-After beyond the flow deadline ends at the deadline, as an expired sign-in', async () => {
    serve([() => rateLimited('120'), () => json(BOUND)]);
    const { result } = renderHook(() =>
      useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        onSuccess: vi.fn(),
        __pollIntervalMs: 5,
        __pollTimeoutMs: 300,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('error'), { timeout: 2_000 });
    expect(result.current.state.kind === 'error' && result.current.state.message).toMatch(
      /Authorization expired/,
    );
    // It did not poll again inside the Retry-After window.
    expect(exchangeTimes.length).toBe(1);
  });
});
