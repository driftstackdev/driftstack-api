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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: {
    apiKey: string | null;
    baseUrl: string;
    telemetryOptIn: boolean | null;
    startUrl?: string;
  };
  loading: boolean;
  client: null;
  accountMe: null;
  refreshAccountMe: () => Promise<void>;
  update: (next: Record<string, unknown>) => Promise<void>;
}
const useSettingsMock = vi.fn<() => MockSettings>();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
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

function renderWithToasts(): void {
  render(
    <ToastProvider>
      <SettingsView />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SettingsView (V-288 jsdom + RTL foundation)', () => {
  it('renders without crashing in the no-API-key-yet state', () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    // The first-run panel is the load-bearing assertion: confirms the
    // component reached the render path that depends on settings.apiKey.
    expect(screen.getByText(/no api key yet/i)).toBeInTheDocument();

    // The shared title + section labels are also rendered — sanity
    // that the larger tree mounted, not just the conditional panel.
    expect(screen.getByText(/api connection/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with browser/i })).toBeInTheDocument();
  });

  it('Copy key writes the REAL (unmasked) API key to the clipboard and shows a "Copied" toast', async () => {
    const realKey = 'ds_live_abcdef0123456789zzzz';
    useSettingsMock.mockReturnValue({
      settings: { apiKey: realKey, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    renderWithToasts();

    // The displayed key is masked; the copy must use the full real key.
    expect(screen.queryByText(realKey)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy key/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(realKey));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('a non-http(s) Start URL shows an inline error, blocks Save, and never silently keeps the old value', () => {
    const update = vi.fn(() => Promise.resolve());
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
        startUrl: 'https://driftstack.dev',
      },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update,
    });
    renderWithToasts();

    const startInput = screen.getByPlaceholderText<HTMLInputElement>('https://driftstack.dev');
    // Type a rejected scheme.
    fireEvent.change(startInput, { target: { value: 'javascript:alert(1)' } });

    // Inline error surfaces…
    expect(screen.getByRole('alert')).toHaveTextContent(/isn.t a valid http\(s\) URL/i);
    // …the field is flagged invalid…
    expect(startInput.getAttribute('aria-invalid')).toBe('true');
    // …and Save is disabled (so the silent old-value fallback can't fire).
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Clicking the (disabled) Save is a no-op — no persist with the bad value.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).not.toHaveBeenCalled();

    // Correcting it clears the error + re-enables Save.
    fireEvent.change(startInput, { target: { value: 'https://example.com' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('the Connected banner masks the key with the shared prefix-aware mask (not 16 contiguous chars)', () => {
    const realKey = 'ds_live_abcdef0123456789zzzz';
    useSettingsMock.mockReturnValue({
      settings: { apiKey: realKey, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    // The shared maskApiKey strips the ds_live_ prefix + shows only 4 body chars:
    // ds_live_abcd…zzzz. The old inline mask leaked 16 contiguous real chars
    // (ds_live_abcdef01…zzzz).
    expect(screen.getByText(/ds_live_abcd…zzzz/)).toBeInTheDocument();
    // The over-exposing 12-from-start body must NOT appear anywhere.
    expect(screen.queryByText(/abcdef0123/)).toBeNull();
    expect(screen.queryByText(realKey)).toBeNull();
  });

  it('Reset to default resets the self-hosted base URL draft to the default constant', () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'ds_live_x', baseUrl: 'http://10.0.0.5:9000', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    const urlField = screen.getByPlaceholderText<HTMLInputElement>('http://localhost:3000');
    expect(urlField.value).toBe('http://10.0.0.5:9000');

    // Query by exact button text rather than the accessible-name role matcher:
    // the "Cloud"/"Self-hosted" deployment toggles confuse a fuzzy name regex.
    fireEvent.click(screen.getByText('Reset to default'));
    expect(urlField.value).toBe('http://localhost:3000');
  });
});
