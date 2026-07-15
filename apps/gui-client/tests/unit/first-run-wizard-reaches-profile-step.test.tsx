/* eslint-disable @typescript-eslint/require-await */
// Regression: the first-run wizard must reach its "First profile" step after a
// valid API key is entered — it must NOT unmount the moment the key is saved.
//
// Root cause this guards: validateAndSave() persists the key via
// SettingsContext.update() (so the ProfileStep's client is authenticated)
// BEFORE advancing to the profile step. If the App-shell wizard gate keys only
// on `settings.apiKey === null`, that save flips the gate and unmounts the
// wizard mid-flow — the customer never sees the First-profile step the stepper
// advertises and is dropped straight into the app shell. The gate latches the
// wizard active until its onComplete (skip / created) instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const invokeStore = new Map<string, string>();
const tauriStore = new Map<string, unknown>();
let failSecretSave = false;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'secret_load') return invokeStore.get(args.key) ?? null;
    if (cmd === 'secret_save') {
      if (failSecretSave) {
        throw new Error(
          'securityd denied /Users/customer/Library/Keychains token=first-run-secret',
        );
      }
      invokeStore.set(args.key, args.value ?? '');
      return undefined;
    }
    if (cmd === 'secret_delete') {
      invokeStore.delete(args.key);
      return undefined;
    }
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
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

beforeEach(() => {
  invokeStore.clear();
  tauriStore.clear();
  failSecretSave = false;
  // Boot with NO key (cloud baseUrl present, but no api_key) → first-run wizard.
  tauriStore.set('driftstack', {
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  });
  // Every authenticated call resolves 200. account.me() needs a teams array +
  // cap fields (the shell reads them on mount); list calls return an empty page.
  const me = {
    tier: 'personal',
    teams: [],
    concurrent_session_active: 0,
    concurrent_session_cap: 5,
    profile_count: 0,
    profile_cap: 10,
  };
  // @ts-expect-error vitest fetch mock
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes('/account/me') ? me : { data: [], has_more: false };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
});

afterEach(() => {
  cleanup();
});

describe('First-run wizard — reaches the First-profile step after key validation', () => {
  it('does not unmount the wizard when the key save flips apiKey non-null', async () => {
    const { App } = await import('../../src/App');
    render(<App />);

    // Wizard Welcome appears (no key on boot).
    await waitFor(() => {
      expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument();
    });

    // Welcome → Deployment → Sign in.
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));
    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    // Switch to paste-key path + validate a key. validateAndSave persists the
    // key (apiKey becomes non-null) THEN advances to the profile step.
    await userEvent.click(
      screen.getByRole('button', { name: /have an api key\? paste it instead/i }),
    );
    await userEvent.type(screen.getByLabelText(/api key/i), 'ds_live_test_key');
    await userEvent.click(screen.getByRole('button', { name: /validate \+ continue/i }));

    // The First-profile step must render — NOT the app shell. Before the fix the
    // wizard unmounted the instant the key saved and this heading never showed.
    await waitFor(
      () => {
        expect(screen.getByText(/create your first profile/i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('stays retryable when the credential store rejects the key, then advances after access returns', async () => {
    const { App } = await import('../../src/App');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /get started/i }));
    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /have an api key\? paste it instead/i }),
    );
    await userEvent.type(screen.getByLabelText(/api key/i), 'ds_live_retryable_key');

    failSecretSave = true;
    await userEvent.click(screen.getByRole('button', { name: /validate \+ continue/i }));

    expect(
      await screen.findByText("Couldn't complete setup. Check the details and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/create your first profile/i)).toBeNull();
    expect(
      screen.queryByText(/securityd|\/Users\/customer|Keychains|token=first-run-secret/i),
    ).toBeNull();
    expect(invokeStore.has('api_key:api.driftstack.dev')).toBe(false);

    failSecretSave = false;
    await userEvent.click(screen.getByRole('button', { name: /validate \+ continue/i }));
    await waitFor(() => expect(screen.getByText(/create your first profile/i)).toBeInTheDocument());
    expect(invokeStore.get('api_key:api.driftstack.dev')).toBe('ds_live_retryable_key');
  });
});
