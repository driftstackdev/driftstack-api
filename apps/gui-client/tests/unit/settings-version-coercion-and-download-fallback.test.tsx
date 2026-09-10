// Guard for two Settings-view defects (audit):
//
//   #7  A /version response whose git_sha is not a string (the endpoint is
//       parsed WITHOUT runtime validation) used to flow through
//       `body.git_sha ?? 'unknown'` unchanged — a NUMBER survived — and then
//       reached the "✓ Reachable · {version.slice(0, 7)}" chip, where `.slice`
//       is not a function on a number and crashed the whole Settings render.
//       The sibling ConnectivityView already guards the same field with a
//       `typeof … === 'string'` check; SettingsView now does too.
//
//   #13 A downloadOnly update (a platform that cannot install for itself — its
//       install() only ever rejects) used to render the same Install button as
//       a self-installable one, so clicking it failed and stranded the customer
//       on "Retry install" with no way forward. It now renders a Download link
//       to the release, mirroring UpdateBanner's downloadOnly handling.
//
// Reuses the proven SettingsView jsdom harness (SettingsContext, browser
// sign-in and the updater module mocked at the module boundary), so a mount
// failure has nothing to do with the behaviour under test.

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

// The offered update, swapped per test. SettingsView calls checkForUpdateVerbose
// from the "Check for updates" button (#6) — never on mount — so this is inert for
// the connection-test case below.
let available: unknown = null;
vi.mock('../../src/lib/updater', () => ({
  checkForUpdate: () => Promise.resolve(available),
  checkForUpdateVerbose: () =>
    Promise.resolve(
      available === null ? { status: 'none' } : { status: 'found', update: available },
    ),
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

function renderView(): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsView />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

const checkBtn = (): HTMLElement =>
  document.querySelector('[data-action="check-for-updates"]') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  available = null;
});

describe('SettingsView — version coercion + download fallback', () => {
  it('#7 — a non-string git_sha from /version coerces to "unknown" and does not crash the reachable chip', async () => {
    // First-run (apiKey null) so the account card + Connected panel stay out of
    // the way; the "Test connection" button lives in the always-rendered
    // "API & connection" panel regardless.
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    // A 200 whose git_sha is a NUMBER, not a string — exactly the unvalidated
    // shape that reverting the fix lets reach `.slice(0, 7)`.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ git_sha: 12345 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    // With the fix the chip renders the coerced string "unknown". Reverting to
    // `body.git_sha ?? 'unknown'` leaves version === 12345 (a number), and the
    // `.slice(0, 7)` in the chip throws during render — this findByText then
    // never resolves and the test fails.
    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.getByText(/Reachable/)).toBeInTheDocument();
  });

  it('#13 — a downloadOnly update offers a Download link, not a stuck Install/Retry button', async () => {
    const downloadUrl = 'https://github.com/driftstackdev/driftstack-api/releases/latest';
    available = {
      version: '0.2.0',
      currentVersion: '0.1.0',
      notes: null,
      downloadOnly: true,
      downloadUrl,
      // Contract of a downloadOnly update: install() only ever rejects, which is
      // exactly why the Install button must not be offered for it.
      install: vi.fn(() => Promise.reject(new Error('This platform installs updates manually.'))),
    };
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
        startUrl: 'https://driftstack.io',
      },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    // Keep the embedded ConnectivityView's /version probe off the real network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline in test'))),
    );
    renderView();

    fireEvent.click(checkBtn());

    // A Download anchor pointing at the release must appear…
    const link = (await waitFor(() => {
      const el = document.querySelector('[data-action="download-update"]');
      if (el === null) throw new Error('no download link yet');
      return el;
    })) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(downloadUrl);

    // …and the Install/Retry button must NOT — reverting the fix renders the
    // button (whose click can only reject) and no download link, failing both
    // the waitFor above and this assertion.
    expect(document.querySelector('[data-action="install-update-now"]')).toBeNull();
  });
});
