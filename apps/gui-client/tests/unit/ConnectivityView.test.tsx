// ConnectivityView — jsdom + React Testing Library coverage for the
// embedded "Connection test" panel's API-key row.
//
// SettingsContext is mocked at module level so the test doesn't reach
// Tauri's plugin runtime. The component renders unmocked — a real
// render of the production tree.
//
// Focus: the API-key row uses the shared, prefix-aware maskApiKey
// (audit) — a `ds_live_` key renders `ds_live_abcd…zzzz`, NOT the
// old non-standard inline `slice(0, 8)…slice(-4)` (which printed
// `ds_live_a…zzzz` — 8 chars from the start). And the null case shows
// the "configure under Settings" nudge.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DriftstackError } from '../../src/lib/client';

interface MockClient {
  sessions: {
    list: (input: { limit: number }) => Promise<{ data: unknown[] }>;
  };
}

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
const useSettingsMock = vi.fn<() => MockSettings>();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { ConnectivityView } = await import('../../src/views/ConnectivityView');

function baseSettings(apiKey: string | null): MockSettings {
  return {
    settings: { apiKey, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
    loading: false,
    client: null,
    accountMe: null,
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
  };
}

function settingsWithClient(client: MockClient): MockSettings {
  return { ...baseSettings('ds_live_test'), client };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // The /version effect fires a fetch on mount; stub it out per-test
  // where needed, but always clear so it doesn't leak across tests.
});

describe('ConnectivityView API-key row masking (audit)', () => {
  it('bounds the background version probe and aborts it on unmount', () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );
    useSettingsMock.mockReturnValue(baseSettings(null));

    const { unmount } = render(<ConnectivityView embedded />);
    expect(capturedSignal).toBeTruthy();
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('hides untyped transport internals from a failed connectivity result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('background version probe unavailable'))),
    );
    useSettingsMock.mockReturnValue(
      settingsWithClient({
        sessions: {
          list: () =>
            Promise.reject(
              new Error(
                'getaddrinfo ENOTFOUND private-api.internal /Users/customer/.config token=secret',
              ),
            ),
        },
      }),
    );

    render(<ConnectivityView embedded />);
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    expect(
      await screen.findByText(
        'Connectivity check failed. Verify the API URL and key in Settings, then try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-api\.internal|\/Users\/customer|token=secret/i)).toBeNull();
  });

  it('preserves typed API problem guidance and kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('background version probe unavailable'))),
    );
    useSettingsMock.mockReturnValue(
      settingsWithClient({
        sessions: {
          list: () =>
            Promise.reject(
              new DriftstackError({
                kind: 'invalid_key',
                status: 401,
                type: 'https://errors.driftstack.dev/invalid-key',
                title: 'Invalid API key',
                detail: 'Create a new key in the dashboard, then update Settings.',
              }),
            ),
        },
      }),
    );

    render(<ConnectivityView embedded />);
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    expect(
      await screen.findByText(
        'Invalid API key: Create a new key in the dashboard, then update Settings.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('· invalid_key')).toBeInTheDocument();
  });

  it('renders a ds_live_ key with the shared prefix-aware mask (ds_live_abcd…zzzz, NOT the old slice(0,8))', () => {
    // The /version effect calls fetch on mount — make it reject so the
    // server-info rows stay hidden and don't interfere.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in test'))),
    );
    useSettingsMock.mockReturnValue(baseSettings('ds_live_abcdef0123456789zzzz'));

    render(<ConnectivityView embedded />);

    // Shared mask: prefix verbatim + 4 body chars + ellipsis + 4 suffix.
    expect(screen.getByText('ds_live_abcd…zzzz')).toBeInTheDocument();
    // The old inline slice(0, 8)…slice(-4) form must NOT appear — that
    // printed 8 chars from the start (ds_live_a…zzzz).
    expect(screen.queryByText('ds_live_a…zzzz')).toBeNull();
    // The full secret must never be on-screen.
    expect(screen.queryByText('ds_live_abcdef0123456789zzzz')).toBeNull();
  });

  it('shows the "configure under Settings" nudge when no key is set', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in test'))),
    );
    useSettingsMock.mockReturnValue(baseSettings(null));

    render(<ConnectivityView embedded />);

    expect(screen.getByText('not set — configure under Settings')).toBeInTheDocument();
  });
});
