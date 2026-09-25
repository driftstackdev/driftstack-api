// GUI audit #9 — "Sign in with browser" binds the flow to a secret that never
// leaves the app (RFC 7636 PKCE, S256).
//
// Before this, the app sent only `state` at initiate and `{code, state}` at
// exchange, and both values also travel in the sign-in link and in the
// `driftstack://auth/callback` hand-off. Anyone who read either URL could
// collect the key. Now the app makes a fresh `code_verifier` per attempt, sends
// only its SHA-256 (`code_challenge`, method S256) at initiate, keeps the
// verifier in memory, and sends it only in the exchange body — on the poll path
// and on the deep-link path alike.
//
// The server half (it refuses an exchange without the matching verifier) is
// proven in apps/server/tests/integration/a-leaked-desktop-sign-in-link-cannot-collect-the-key.test.ts.

import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(() => Promise.resolve()),
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));

const { useBrowserSignIn } = await import('../../src/lib/browser-sign-in');
const { open: mockOpenInBrowser } = await import('@tauri-apps/plugin-shell');

const CODE = 'abc123code-abc123code-abc123code';
const BROWSER_URL = `http://localhost:5173/cli/authorize?code=${CODE}&state=from-server`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

let fetchSpy: MockInstance<typeof globalThis.fetch>;
let sent: Sent[];

beforeEach(() => {
  vi.mocked(mockOpenInBrowser).mockClear();
  sent = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function serve(exchangeReplies: Array<() => Response>): void {
  fetchSpy.mockImplementation((input, init) => {
    // The hook always passes a string URL and a JSON string body.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as Record<string, unknown>;
    sent.push({ url, body });
    if (url.endsWith('/v1/auth/cli-authorize/initiate')) {
      return Promise.resolve(
        json({
          code: CODE,
          user_code: 'ABCD-EFGH',
          browser_url: BROWSER_URL,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
      );
    }
    const next = exchangeReplies.shift();
    return Promise.resolve(next ? next() : json({ status: 'pending' }));
  });
}

const bound = () =>
  json({ status: 'bound', api_key: 'ds_test_key_for_this_app', account_id: 'acc_1' });

describe('GUI audit #9 — the code verifier stays in the app', () => {
  it('CRITICAL initiate carries only the S256 challenge; the exchange carries the verifier that hashes to it; neither the opened link nor any state the UI sees contains the verifier', async () => {
    serve([() => json({ status: 'pending' }), bound]);
    const onSuccess = vi.fn(() => Promise.resolve());
    const seenStates: string[] = [];
    const { result } = renderHook(() => {
      const hook = useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        clientLabel: 'test',
        onSuccess,
        __pollIntervalMs: 5,
        __pollTimeoutMs: 2000,
      });
      seenStates.push(JSON.stringify(hook.state));
      return hook;
    });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('success'), { timeout: 2000 });
    expect(onSuccess).toHaveBeenCalledWith('ds_test_key_for_this_app', 'acc_1');

    const initiate = sent.find((s) => s.url.endsWith('/initiate'));
    const exchanges = sent.filter((s) => s.url.endsWith('/exchange'));
    expect(initiate?.body['code_challenge_method']).toBe('S256');
    const challenge = initiate?.body['code_challenge'];
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(initiate?.body).not.toHaveProperty('code_verifier');

    expect(exchanges.length).toBeGreaterThanOrEqual(2);
    const verifiers = new Set(exchanges.map((e) => e.body['code_verifier']));
    expect(verifiers.size).toBe(1);
    const verifier = [...verifiers][0];
    expect(typeof verifier).toBe('string');
    expect(verifier as string).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(s256(verifier as string)).toBe(challenge);

    // The verifier never goes anywhere a third party can read.
    expect(mockOpenInBrowser).toHaveBeenCalledWith(BROWSER_URL);
    expect(BROWSER_URL).not.toContain(verifier as string);
    for (const state of seenStates) expect(state).not.toContain(verifier as string);
  });

  it('a deep-link hand-off triggers an exchange that still carries the verifier (the hand-off itself cannot collect the key)', async () => {
    serve([bound]);
    let deliver: ((urls: string[]) => void) | null = null;
    const onSuccess = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      useBrowserSignIn({
        baseUrl: 'http://localhost:3000',
        onSuccess,
        // No poll in this window: the only exchange is the one the hand-off fires.
        __pollIntervalMs: 60_000,
        __pollTimeoutMs: 120_000,
        __onOpenUrl: (handler) => {
          deliver = handler;
          return Promise.resolve(() => {});
        },
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('waiting'));
    const waiting = result.current.state;
    if (waiting.kind !== 'waiting') throw new Error('not waiting');
    await waitFor(() => expect(deliver).not.toBeNull());

    const handOff =
      'driftstack://auth/callback?code=' +
      encodeURIComponent(waiting.code) +
      '&state=' +
      encodeURIComponent(waiting.state);
    act(() => deliver?.([handOff]));
    await waitFor(() => expect(result.current.state.kind).toBe('success'));

    const initiate = sent.find((s) => s.url.endsWith('/initiate'));
    const exchange = sent.find((s) => s.url.endsWith('/exchange'));
    expect(exchange?.body['code']).toBe(CODE);
    expect(typeof exchange?.body['code_verifier']).toBe('string');
    expect(s256(exchange?.body['code_verifier'] as string)).toBe(initiate?.body['code_challenge']);
    expect(handOff).not.toContain(exchange?.body['code_verifier'] as string);
  });

  it('every attempt makes a fresh verifier', async () => {
    const challenges: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      serve([bound]);
      const { result, unmount } = renderHook(() =>
        useBrowserSignIn({
          baseUrl: 'http://localhost:3000',
          onSuccess: () => Promise.resolve(),
          __pollIntervalMs: 5,
          __pollTimeoutMs: 2000,
        }),
      );
      act(() => result.current.start());
      await waitFor(() => expect(result.current.state.kind).toBe('success'));
      challenges.push(sent.find((s) => s.url.endsWith('/initiate'))?.body['code_challenge']);
      unmount();
      sent = [];
    }
    expect(challenges[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenges[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenges[0]).not.toBe(challenges[1]);
  });
});
