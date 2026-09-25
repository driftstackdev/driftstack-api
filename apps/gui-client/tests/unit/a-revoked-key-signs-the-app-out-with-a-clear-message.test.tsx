/* eslint-disable @typescript-eslint/require-await */
// Owner decision, 2026-09-24: when the server says the app's OWN key is revoked
// or not recognised, the app signs out with a clear message ("Your sign-in was
// revoked — sign in again") instead of leaving every screen failing behind a
// banner. ONLY on that confirmed answer — a 401 whose problem type is
// revoked-key or invalid-key. Never on a network failure, a timeout, a 5xx or
// any other 401: the key may be fine and the server merely unreachable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const keychain = new Map<string, string>();
const tauriStore = new Map<string, unknown>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'secret_load') return keychain.get(args.key) ?? null;
    if (cmd === 'secret_save') keychain.set(args.key, args.value ?? '');
    if (cmd === 'secret_delete') keychain.delete(args.key);
    return undefined;
  }),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    async get<T>(k: string): Promise<T | null> {
      return (tauriStore.get(k) as T) ?? null;
    }
    async set(k: string, v: unknown): Promise<void> {
      tauriStore.set(k, v);
    }
    async save(): Promise<void> {}
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const KEY = 'api_key:api.driftstack.dev';

function problem(status: number, type: string): Response {
  return new Response(JSON.stringify({ type, title: 'x', status, detail: 'x' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

/** Every API read answers with `answer()`; /version answers OK so the pill is calm. */
function serverAnswers(answer: () => Promise<Response>): void {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/version')) return new Response('{}', { status: 200 });
    return answer();
  });
}

beforeEach(async () => {
  vi.resetModules();
  keychain.clear();
  tauriStore.clear();
  tauriStore.set('driftstack', { baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null });
  keychain.set(KEY, 'ds_live_test_existing_key');
});

afterEach(() => {
  cleanup();
});

async function renderApp(): Promise<void> {
  const { App } = await import('../../src/App');
  const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');
  render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>,
  );
}

describe('a revoked key signs the app out with a clear message', () => {
  it('CRITICAL revoked-key: signed out, the key is gone, and the notice says why', async () => {
    serverAnswers(async () => problem(401, 'https://errors.driftstack.dev/revoked-key'));
    await renderApp();

    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument(), {
      timeout: 5000,
    });
    const notice = document.querySelector<HTMLElement>('[data-component="key-refused-notice"]');
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute('role', 'alert');
    expect(
      within(notice as HTMLElement).getByText('Your sign-in was revoked — sign in again'),
    ).toBeInTheDocument();
    expect(within(notice as HTMLElement).getByText(/Recordings stay\./)).toBeInTheDocument();
    expect(keychain.has(KEY)).toBe(false);
  });

  it('invalid-key: the same, with its own words', async () => {
    serverAnswers(async () => problem(401, 'https://errors.driftstack.dev/invalid-key'));
    await renderApp();
    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(
      await screen.findByText('Your sign-in is no longer valid — sign in again'),
    ).toBeInTheDocument();
    expect(keychain.has(KEY)).toBe(false);
  });

  it.each([
    ['a network failure', async () => Promise.reject(new TypeError('Failed to fetch')), false],
    [
      'a 5xx problem',
      async () => problem(503, 'https://errors.driftstack.dev/driver-not-integrated'),
      false,
    ],
    [
      'a bare 401 (not a key verdict)',
      async () => problem(401, 'https://errors.driftstack.dev/unauthorized'),
      true,
    ],
    [
      "an expired key (not one of the owner's two)",
      async () => problem(401, 'https://errors.driftstack.dev/expired-key'),
      true,
    ],
    [
      'a 401 that is not a problem document',
      async () => new Response('nope', { status: 401 }),
      true,
    ],
  ] as const)('CRITICAL %s never signs anyone out', async (_name, answer, is401) => {
    serverAnswers(answer);
    await renderApp();
    await screen.findByRole('button', { name: /Sign out/ }, { timeout: 5000 });
    if (is401) {
      // Non-vacuity: the 401 WAS seen — it raised the re-auth banner — and
      // still signed nobody out.
      expect(
        await screen.findByText(/Your API key expired or was revoked/, {}, { timeout: 5000 }),
      ).toBeInTheDocument();
    } else {
      // Long enough for the account read to have been answered or be retrying.
      await new Promise((r) => setTimeout(r, 800));
      expect(window.fetch).toHaveBeenCalled();
    }
    expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
    expect(document.querySelector('[data-component="key-refused-notice"]')).toBeNull();
    expect(keychain.get(KEY)).toBe('ds_live_test_existing_key');
  });
});

describe('the API client reports only a confirmed refusal of its own key', () => {
  it('keyRefusalOf reads a clone and leaves the body for the caller', async () => {
    const { keyRefusalOf } = await import('../../src/lib/client');
    const res = problem(401, 'https://errors.driftstack.dev/revoked-key');
    expect(await keyRefusalOf(res)).toBe('revoked');
    // The SDK still gets the whole problem document.
    expect(((await res.json()) as { type: string }).type).toBe(
      'https://errors.driftstack.dev/revoked-key',
    );
    expect(
      await keyRefusalOf(problem(403, 'https://errors.driftstack.dev/revoked-key')),
    ).toBeNull();
  });

  it('the refusal names the key the refused request carried, so a replaced key is not signed out', async () => {
    const { buildClient, subscribeKeyRefused } = await import('../../src/lib/client');
    window.fetch = vi.fn(async () => problem(401, 'https://errors.driftstack.dev/revoked-key'));
    const seen: Array<{ apiKey: string; baseUrl: string; reason: string }> = [];
    const stop = subscribeKeyRefused((r) => seen.push(r));
    const client = buildClient('ds_live_old_key', 'https://api.driftstack.dev/');
    await client?.account.me().catch(() => undefined);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    stop();
    expect(seen[0]).toEqual({
      apiKey: 'ds_live_old_key',
      baseUrl: 'https://api.driftstack.dev',
      reason: 'revoked',
    });
  });
});
