/* eslint-disable @typescript-eslint/require-await */
// Owner follow-up, 2026-09-24: sign-out now removes the previous account's
// local chats, saved proxies and their passwords, notes and bindings — and the
// sidebar's sign-out was ONE click (⌘⇧L too), while the Settings confirm only
// talked about the API key. Every path must ask first, and say plainly what
// leaves this computer and what stays (recordings; nothing changes on the
// account). Cancel must leave everything as it was.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const KEY = 'api_key:api.driftstack.dev';

beforeEach(() => {
  // A fresh App per arm: the settings module caches what it loaded, and an arm
  // that signs out must not hand the next one a signed-out shell.
  vi.resetModules();
  invokeStore.clear();
  tauriStore.clear();
  tauriStore.set('driftstack', { baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null });
  invokeStore.set(KEY, 'ds_live_test_existing_key');
  window.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
});

afterEach(() => {
  cleanup();
});

async function renderSignedIn(): Promise<void> {
  const { App } = await import('../../src/App');
  const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');
  render(
    <ConfirmProvider>
      <App />
    </ConfirmProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument());
  await screen.findByRole('button', { name: /Sign out/ }, { timeout: 5000 });
}

/** What the dialog must say, read from the dialog itself. */
function expectItSaysWhatLeavesAndWhatStays(dialog: HTMLElement): void {
  const text = dialog.textContent ?? '';
  // Removed from this computer.
  expect(text).toMatch(/removes from this computer/i);
  expect(text).toMatch(/API key/);
  expect(text).toMatch(/AI chat history/);
  expect(text).toMatch(/saved proxies with their passwords/);
  expect(text).toMatch(/notes, folders and tags/);
  expect(text).toMatch(/which proxy each profile uses/);
  // Kept.
  expect(text).toMatch(/recordings stay on this computer/i);
  expect(text).toMatch(/Nothing changes on your Driftstack account/);
}

describe('signing out asks first and says what leaves this computer', () => {
  it('CRITICAL the sidebar button asks before signing out, and Cancel keeps everything', async () => {
    await renderSignedIn();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    const dialog = await screen.findByRole('dialog');
    expectItSaysWhatLeavesAndWhatStays(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invokeStore.get(KEY)).toBe('ds_live_test_existing_key');
    expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument();
  });

  it('CRITICAL ⌘⇧L asks too, and Escape cancels it', async () => {
    await renderSignedIn();
    fireEvent.keyDown(window, { key: 'L', metaKey: true, shiftKey: true });

    const dialog = await screen.findByRole('dialog');
    expectItSaysWhatLeavesAndWhatStays(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invokeStore.get(KEY)).toBe('ds_live_test_existing_key');
  });

  it('confirming signs out (the positive control for the two arms above)', async () => {
    await renderSignedIn();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(invokeStore.has(KEY)).toBe(false);
  });

  it('CRITICAL Settings asks with the same words — not only about the API key', async () => {
    await renderSignedIn();
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const settingsSignOut = await waitFor(
      () => {
        const inSettings = screen
          .getAllByRole('button')
          .find((b) => b.textContent === 'Sign out' && b.className.includes('btn-secondary'));
        expect(inSettings).toBeDefined();
        return inSettings as HTMLElement;
      },
      { timeout: 3000 },
    );
    fireEvent.click(settingsSignOut);
    const dialog = await screen.findByRole('dialog');
    expectItSaysWhatLeavesAndWhatStays(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invokeStore.get(KEY)).toBe('ds_live_test_existing_key');
  });

  it('names every thing sign-out actually removes — a new step without words here reds this', async () => {
    const { SIGN_OUT_CONFIRM_MESSAGE } = await import('../../src/lib/forget-signed-out-account');
    const source = readFileSync(
      resolve(__dirname, '../../src/lib/forget-signed-out-account.ts'),
      'utf8',
    );
    const steps = [...source.matchAll(/\['([^']+)', \(\) =>/g)].map((m) => m[1]);
    // Non-vacuity: the steps were found.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    const saidAs: Record<string, RegExp> = {
      'Simulator windows': /open iPhone window closes/,
      'AI chat history': /AI chat history/,
      'saved proxies': /saved proxies with their passwords/,
      'proxy readings': /proxy check results/,
      'profile bindings': /which proxy each profile uses/,
      'profile notes': /notes, folders and tags/,
    };
    for (const step of steps) {
      const phrase = saidAs[step as string];
      expect(phrase, `sign-out step "${String(step)}" has no words in the confirm`).toBeDefined();
      expect(SIGN_OUT_CONFIRM_MESSAGE).toMatch(phrase as RegExp);
    }
  });
});
