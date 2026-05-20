/* eslint-disable @typescript-eslint/require-await */
// 2026-05-20 — end-to-end React-testing-library test for the
// App-shell sign-out flow. Customer reports "logout doesn't work"
// repeatedly; rather than guess, instrument the actual click → state
// flow and verify the wizard re-appears.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
// react-testing-library uses jsdom; the dom matchers come from jest-dom.
import '@testing-library/jest-dom/vitest';

// Mock Tauri APIs the App imports (they crash outside the Tauri runtime).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: { key: string; value?: string }) => {
    if (cmd === 'secret_load') return invokeStore.get(args.key) ?? null;
    if (cmd === 'secret_save') {
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
// Shared module-level store so the test can seed baseUrl before the
// component reads from it.
const tauriStore = new Map<string, unknown>();
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
// Sentry init crashes without a real DSN.
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
  Replay: class {},
  BrowserTracing: class {},
}));

const invokeStore = new Map<string, string>();

// Pre-seed an api_key so the App boots PAST the wizard (i.e. signed in).
beforeEach(() => {
  invokeStore.clear();
  tauriStore.clear();
  // Seed both: persistent baseUrl points at cloud + matching scoped key.
  tauriStore.set('driftstack', {
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  });
  invokeStore.set('api_key:api.driftstack.dev', 'ds_live_test_existing_key');
  // (Sign-out is one-click since 2026-05-20 — no confirm() needed.)
  // Mock fetch so accountMe / etc don't fail with real network errors.
  // @ts-expect-error vitest mocks
  window.fetch = vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
});

describe('App shell — sign-out flow', () => {
  it('clicking sidebar Sign out clears keychain and returns to the wizard', async () => {
    const { App } = await import('../../src/App');
    render(<App />);

    // Wait until the shell renders (apiKey is set so wizard is gated past).
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
    });

    // Sidebar Sign out button visible.
    const signOutBtn = await screen.findByRole('button', { name: /Sign out/ });
    expect(signOutBtn).toBeInTheDocument();

    signOutBtn.click();

    // After sign-out, the FirstRunWizard's Welcome heading should appear.
    await waitFor(
      () => {
        expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );

    // Keychain entry should be cleared (both scoped + legacy).
    expect(invokeStore.has('api_key:api.driftstack.dev')).toBe(false);
    expect(invokeStore.has('api_key')).toBe(false);
  });
});
