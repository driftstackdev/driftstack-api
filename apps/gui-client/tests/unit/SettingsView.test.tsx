// V-288 — first jsdom + React Testing Library test under the new
// gui-jsdom Vitest project. Renders SettingsView without crashing
// and asserts the no-API-key-yet panel shows when settings.apiKey
// is null.
//
// SettingsContext + useBrowserSignIn are mocked at module level so
// the test doesn't reach into Tauri's plugin-store / plugin-shell
// runtime. The component itself runs unmocked — this is a real
// render of the production component tree.
//
// Pattern this test establishes:
//   - vi.mock the lib/SettingsContext + lib/browser-sign-in modules
//     to supply synthetic values.
//   - render() the component with @testing-library/react.
//   - screen.getByText / queryByText for assertions.
//   - cleanup() runs automatically via the V-288 setup.ts afterEach.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: (): {
    settings: { apiKey: string | null; baseUrl: string; telemetryOptIn: boolean | null };
    loading: boolean;
    client: null;
    accountMe: null;
    refreshAccountMe: () => Promise<void>;
    update: (next: Record<string, unknown>) => Promise<void>;
  } => ({
    settings: {
      apiKey: null,
      baseUrl: 'https://api.driftstack.dev',
      telemetryOptIn: null,
    },
    loading: false,
    client: null,
    accountMe: null,
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
  }),
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

describe('SettingsView (V-288 jsdom + RTL foundation)', () => {
  it('renders without crashing in the no-API-key-yet state', () => {
    render(<SettingsView />);

    // The first-run panel is the load-bearing assertion: confirms the
    // component reached the render path that depends on settings.apiKey.
    expect(screen.getByText(/no api key yet/i)).toBeInTheDocument();

    // The shared title + section labels are also rendered — sanity
    // that the larger tree mounted, not just the conditional panel.
    expect(screen.getByText(/api connection/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with browser/i })).toBeInTheDocument();
  });
});
