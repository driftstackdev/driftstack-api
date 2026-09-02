// "Check for updates at settings detects there's a new update, but tells it will
// update later (already bad) instead of asking to update now, and then does
// nothing." (owner item N-8, verbatim.)
//
// Both halves were true. checkForUpdate() returns an AvailableUpdate carrying a
// working install() closure — the update BANNER calls it (App.tsx:698) — and
// Settings stored the object only to interpolate `.version` into the copy "it
// will install shortly". Nothing ever called install(), so a customer who went
// looking for an update was promised one and never got it.
//
// Reuses the proven SettingsView harness: this view pulls in the settings
// context, browser sign-in, toasts and confirm, and a hand-rolled mock chain
// fails to mount for reasons that have nothing to do with updates.

// V-288 — first jsdom + React Testing Library test under the new
// gui-jsdom Vitest project. Renders SettingsView without crashing
// and asserts the no-API-key-yet panel shows when settings.apiKey
// is null.
//
// SettingsContext + useBrowserSignIn are mocked at module level so
// the test doesn't reach into Tauri's plugin-store / plugin-shell
// runtime. The component itself runs unmocked — this is a real
// render of the production component tree, wrapped in the real
// ToastProvider (SettingsView now pushes a "Copied" toast).
//
// Pattern this test establishes:
//   - vi.mock the lib/SettingsContext + lib/browser-sign-in modules
//     to supply synthetic values.
//   - render() the component with @testing-library/react.
//   - screen.getByText / queryByText for assertions.
//   - cleanup() runs automatically via the V-288 setup.ts afterEach.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: {
    apiKey: string | null;
    baseUrl: string;
    telemetryOptIn: boolean | null;
    startUrl?: string;
  };
  loading: boolean;
  client: MockClient | null;
  accountMe: null;
  refreshAccountMe: () => Promise<void>;
  update: (next: Record<string, unknown>) => Promise<void>;
}

interface MockClient {
  account: {
    getBundledLlmSettings: () => Promise<{
      consent: boolean;
      monthly_cap_usd_cents: number;
    }>;
    getBundledLlmStatus: () => Promise<{
      consent: boolean;
      cap_cents: number;
      used_this_month_cents: number;
      remaining_cents: number;
      refused_count_this_month: number;
      month_started_at: string;
    }>;
    updateBundledLlmSettings: (body: {
      consent: boolean;
      monthly_cap_usd_cents: number;
    }) => Promise<{ consent: boolean; monthly_cap_usd_cents: number }>;
    getByokAnthropicKey: () => Promise<{
      has_key: boolean;
      set_at: string | null;
      last_used_at: string | null;
    }>;
    setByokAnthropicKey: (key: string) => Promise<{ set_at: string }>;
    testByokAnthropicKey: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    clearByokAnthropicKey: () => Promise<void>;
  };
}

function makeClient(overrides: Partial<MockClient['account']> = {}): MockClient {
  return {
    account: {
      getBundledLlmSettings: vi.fn(() =>
        Promise.resolve({ consent: false, monthly_cap_usd_cents: 0 }),
      ),
      getBundledLlmStatus: vi.fn(() =>
        Promise.resolve({
          consent: false,
          cap_cents: 0,
          used_this_month_cents: 0,
          remaining_cents: 0,
          refused_count_this_month: 0,
          month_started_at: '2026-07-01T00:00:00.000Z',
        }),
      ),
      updateBundledLlmSettings: vi.fn((body) => Promise.resolve(body)),
      getByokAnthropicKey: vi.fn(() =>
        Promise.resolve({ has_key: false, set_at: null, last_used_at: null }),
      ),
      setByokAnthropicKey: vi.fn(() => Promise.resolve({ set_at: '2026-07-15T00:00:00.000Z' })),
      testByokAnthropicKey: vi.fn(() => Promise.resolve({ ok: true as const })),
      clearByokAnthropicKey: vi.fn(() => Promise.resolve()),
      ...overrides,
    },
  };
}
const useSettingsMock = vi.fn<() => MockSettings>();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const install = vi.fn(() => Promise.resolve());
let available: unknown = null;
vi.mock('../../src/lib/updater', () => ({
  checkForUpdate: () => Promise.resolve(available),
}));

vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: (): {
    state: { kind: 'idle' };
    start: () => void;
    cancel: () => void;
  } => ({
    state: { kind: 'idle' },
    start: vi.fn(),
    cancel: vi.fn(),
  }),
}));

const { SettingsView } = await import('../../src/views/SettingsView');
const { ToastProvider } = await import('../../src/lib/toasts');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

function renderWithToasts(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsView />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const BASE_SETTINGS: MockSettings = {
  settings: {
    apiKey: 'ds_live_x',
    baseUrl: 'https://api.driftstack.dev',
    telemetryOptIn: null,
    startUrl: 'https://driftstack.dev',
  },
  loading: false,
  client: makeClient(),
  accountMe: null,
  refreshAccountMe: () => Promise.resolve(),
  update: () => Promise.resolve(),
};

const checkBtn = (): HTMLElement =>
  document.querySelector('[data-action="check-for-updates"]') as HTMLElement;
const installBtn = (): HTMLElement | null =>
  document.querySelector('[data-action="install-update-now"]');
const statusText = (): string =>
  document.querySelector('[data-field="update-check-result"]')?.textContent ?? '';

describe('Settings offers to install the update it just found (N-8)', () => {
  beforeEach(() => {
    install.mockReset();
    install.mockImplementation(() => Promise.resolve());
    available = { version: '0.1.13', currentVersion: '0.1.12', notes: null, install };
    useSettingsMock.mockReturnValue(BASE_SETTINGS);
  });

  it('renders an Install button naming the version', async () => {
    renderWithToasts();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(installBtn()).not.toBeNull());
    expect(installBtn()?.textContent).toContain('0.1.13');
  });

  it('CLICKING it actually installs — the defect was that nothing did', async () => {
    renderWithToasts();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(installBtn()).not.toBeNull());
    const b = installBtn();
    if (b === null) throw new Error('no install button');
    fireEvent.click(b);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it('stops promising an install it will not perform', async () => {
    // Whatever the copy becomes, it must not repeat "it will install shortly"
    // while nothing installs.
    renderWithToasts();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(installBtn()).not.toBeNull());
    expect(statusText()).not.toContain('install shortly');
  });

  it('offers NO install button when there is nothing to install', async () => {
    // Vacuity control: the arms above pass because an update was found, not
    // because the button always renders.
    available = null;
    renderWithToasts();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(statusText()).toContain('latest version'));
    expect(installBtn()).toBeNull();
  });

  it('surfaces a failed install and offers a retry', async () => {
    // install() leaves the running app untouched on failure, so the customer is
    // not stranded — say so rather than spinning.
    install.mockImplementation(() => Promise.reject(new Error('signature check failed')));
    renderWithToasts();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(installBtn()).not.toBeNull());
    const b = installBtn();
    if (b === null) throw new Error('no install button');
    fireEvent.click(b);
    await waitFor(() => expect(statusText()).toContain("Couldn't install"));
    expect(installBtn()?.textContent).toContain('Retry');
  });
});
