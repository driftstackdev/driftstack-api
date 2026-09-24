/* eslint-disable @typescript-eslint/require-await -- the Tauri plugin mocks mirror app-shell-sign-out */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * GUI audit #5 — sign-out on a shared Mac left the previous account's data for
 * whoever signed in next: the AI chat history (full transcripts), the saved
 * proxies WITH their credentials (and the vault key that decrypts them), the
 * cached readings about them, the profile bindings and notes, and any open
 * Simulator window still driving a live session. Sign-out removed the account
 * key and nothing else.
 *
 * ⭐ The REAL <App/> is mounted signed in as account A, over per-file stand-ins
 * for the Tauri store and keychain, with A's data put there by the app's own
 * writers where one exists. Then the customer signs out — from the sidebar, and
 * from Settings — and every store is read back.
 */

// ── Tauri stand-ins ─────────────────────────────────────────────────────────
const files = new Map<string, Map<string, unknown>>();
function file(name: string): Map<string, unknown> {
  let m = files.get(name);
  if (m === undefined) {
    m = new Map();
    files.set(name, m);
  }
  return m;
}
const keychain = new Map<string, string>();
const invoked: string[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: { key?: string; value?: string }) => {
    invoked.push(cmd);
    if (cmd === 'secret_load') return keychain.get(args?.key ?? '') ?? null;
    if (cmd === 'secret_save') {
      keychain.set(args?.key ?? '', args?.value ?? '');
      return undefined;
    }
    if (cmd === 'secret_delete') {
      keychain.delete(args?.key ?? '');
      return undefined;
    }
    return undefined;
  }),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async get<T>(k: string): Promise<T | undefined> {
      return file(this.name).get(k) as T | undefined;
    }
    async set(k: string, v: unknown): Promise<void> {
      file(this.name).set(k, v);
    }
    async delete(k: string): Promise<boolean> {
      return file(this.name).delete(k);
    }
    async save(): Promise<void> {}
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({ onOpenUrl: vi.fn(async () => () => undefined) }));
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

const ACCOUNT_A_KEY = 'ds_live_account_a_key';
const A_CHAT_TEXT = 'log into my bank for account A';

async function seedAccountA(): Promise<string> {
  file('settings.json').set('driftstack', {
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
  });
  keychain.set('api_key:api.driftstack.dev', ACCOUNT_A_KEY);

  // A saved proxy with a password, through the app's own writer (so the
  // ciphertext envelope and the vault key are really created), synced to A.
  const { addProxy, setProxyServerId } = await import('../../src/lib/proxies');
  const proxy = await addProxy({
    label: 'Account A residential',
    host: '203.0.113.10',
    port: 1080,
    username: 'alice',
    password: 'account-a-proxy-password',
    scheme: 'socks5',
  });
  await setProxyServerId(proxy.id, 'prx_owned_by_account_a');

  file('agent-chats.json').set('chats', [
    {
      id: 'chat_a',
      title: A_CHAT_TEXT,
      profileId: 'prof_a',
      model: 'claude-sonnet-5',
      turns: [{ role: 'user', text: A_CHAT_TEXT }],
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  file('proxy-probe-cache.json').set('probes', {
    [proxy.id]: { ok: true, at: 2, exitIp: '203.0.113.99' },
  });
  file('settings.json').set('profile_bindings', [
    {
      profileId: 'prof_a',
      defaultProxyId: proxy.id,
      currentSessionId: 'ses_a',
      lastLaunchedAt: null,
    },
  ]);
  file('profiles-meta.json').set('profiles', {
    prof_a: { folder: '', tags: [], note: 'account A private note', icon: '' },
  });
  return proxy.id;
}

function isEmptyish(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Everything of account A the next person could otherwise see or use. */
async function expectNothingOfAccountA(proxyId: string): Promise<void> {
  const { loadChats } = await import('../../src/lib/chat-history');
  const { listProxies } = await import('../../src/lib/proxies');
  expect((await loadChats()).map((c) => c.title)).toEqual([]);
  expect((await listProxies()).map((p) => p.label)).toEqual([]);
  // The ciphertext and the key that decrypts it — both gone.
  expect(isEmptyish(file('settings.json').get('proxies'))).toBe(true);
  expect(isEmptyish(file('settings.json').get('proxy_secret_envelopes_v2'))).toBe(true);
  expect(keychain.has('proxy_vault_key')).toBe(false);
  expect(keychain.has(`proxy_secret:${proxyId}`)).toBe(false);
  // Cached readings, bindings and private notes.
  expect(isEmptyish(file('proxy-probe-cache.json').get('probes'))).toBe(true);
  expect(isEmptyish(file('settings.json').get('profile_bindings'))).toBe(true);
  expect(isEmptyish(file('profiles-meta.json').get('profiles'))).toBe(true);
  // Every open Simulator window was asked to close.
  expect(invoked).toContain('close_simulator_windows');
  // And the key itself, as before.
  expect(keychain.has('api_key:api.driftstack.dev')).toBe(false);
}

beforeEach(() => {
  // Each arm is a fresh app run: module-level caches (the proxy vault key, the
  // settings module) must not carry over from the previous arm's sign-out.
  vi.resetModules();
  files.clear();
  keychain.clear();
  invoked.length = 0;
  // A structural fetch double for the shell's background reads.
  window.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
});

afterEach(() => {
  cleanup();
});

describe('signing out leaves nothing of the account for the next person', () => {
  it('CRITICAL Sidebar → Sign out clears chats, proxies with their credentials, cached data, and Simulator windows', async () => {
    const proxyId = await seedAccountA();
    // The seed is real: A's data is there before sign-out.
    const { loadChats } = await import('../../src/lib/chat-history');
    expect((await loadChats()).map((c) => c.title)).toEqual([A_CHAT_TEXT]);
    expect(keychain.has('proxy_vault_key')).toBe(true);

    const { App } = await import('../../src/App');
    render(<App />);
    await waitFor(() =>
      expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument(),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Sign out/ }));
    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument(), {
      timeout: 3000,
    });

    await waitFor(() => expectNothingOfAccountA(proxyId), { timeout: 3000 });
  });

  it('CRITICAL Settings → Sign out does the same', async () => {
    const proxyId = await seedAccountA();
    const { App } = await import('../../src/App');
    // As main.tsx mounts it: Settings' sign-out asks through the confirm dialog.
    const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');
    render(
      <ConfirmProvider>
        <App />
      </ConfirmProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText('Welcome to Driftstack')).not.toBeInTheDocument(),
    );
    // Cmd+, opens Settings.
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByText('Welcome to Driftstack')).toBeInTheDocument(), {
      timeout: 3000,
    });

    await waitFor(() => expectNothingOfAccountA(proxyId), { timeout: 3000 });
  });
});
