/* eslint-disable @typescript-eslint/require-await */
// Regression: a malformed /v1/account/me payload (the `teams` array missing —
// a partial/legacy response, a deploy-time blip, or a future field rename) must
// NOT blank the founder's entire window.
//
// Root cause this guards: the SDK's account.me() does NO shape validation — it
// casts the JSON. Several shell consumers read `accountMe.teams.length` /
// `accountMe.teams.map(...)` / `accountMe.teams.some(...)`. The Sidebar (and the
// App-shell palette build) render OUTSIDE the per-view ErrorBoundary, so a throw
// there bubbles to RootErrorBoundary and blanks the whole window with no Retry.
//
// Defended at three layers: SettingsContext normalizes `teams` to [] at the
// source (refreshAccountMe), and the Sidebar + App-shell palette optional-chain
// `teams` defensively. This test renders the full App shell with a /me that omits
// teams and asserts the chrome (Sidebar Settings nav + Sign out) renders instead
// of the window blanking.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const invokeStore = new Map<string, string>();
const tauriStore = new Map<string, unknown>();

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
  // Boot SIGNED IN (key present) so the shell mounts past the wizard and the
  // Sidebar renders — the exact post-onboarding shell-mount path.
  tauriStore.set('driftstack', {
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  });
  invokeStore.set('api_key:api.driftstack.dev', 'ds_live_test_existing_key');

  // MALFORMED /account/me: a non-null object with `teams` MISSING entirely.
  // tier is team-capable so the Team item's teamCapableTier branch is exercised
  // too. Caps present so the usage rows render. No `teams` field anywhere.
  const malformedMe = {
    id: 'acc_test',
    email: 'founder@example.com',
    tier: 'enterprise',
    concurrent_session_active: 0,
    concurrent_session_cap: 5,
    profile_count: 0,
    profile_cap: 10,
  };
  // @ts-expect-error vitest fetch mock
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes('/account/me') ? malformedMe : { data: [], has_more: false };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
});

afterEach(() => {
  cleanup();
});

describe('App shell — survives a malformed /account/me (teams missing)', () => {
  it('renders the shell chrome instead of blanking the window', async () => {
    const { App } = await import('../../src/App');
    render(<App />);

    // The shell must mount past the wizard.
    await waitFor(() => {
      expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
    });

    // Sidebar chrome renders — proves the teams-missing render did not throw to
    // RootErrorBoundary. Before the guards, accountMe.teams.length threw here.
    expect(await screen.findByRole('button', { name: /Settings/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Sign out/i })).toBeInTheDocument();
  });
});
