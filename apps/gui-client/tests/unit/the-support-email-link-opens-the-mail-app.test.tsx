import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * GUI audit #21 — Settings → Need help → the support address did nothing.
 *
 * In the desktop app a link leaves the window only through the shell plugin's
 * click handler, and that handler takes an `http(s)://`, `mailto:` or `tel:`
 * link ONLY when it has `target="_blank"` (tauri-plugin-shell `init-iife.js`).
 * The mailto had no target, so the click tried to navigate the app's own window
 * to `mailto:` instead of opening the mail app. Same shape as the Status and
 * Docs links beside it now.
 */

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    settings: {
      apiKey: 'ds_live_x',
      baseUrl: 'https://api.driftstack.dev',
      telemetryOptIn: null,
      startUrl: 'https://driftstack.io',
    },
    loading: false,
    client: null,
    accountMe: null,
    activeWorkspace: null,
    refreshAccountMe: () => Promise.resolve(),
    update: () => Promise.resolve(),
  }),
}));
vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({ state: { kind: 'idle' }, start: vi.fn(), cancel: vi.fn() }),
}));

const { SettingsView } = await import('../../src/views/SettingsView');
const { ToastProvider } = await import('../../src/lib/toasts');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

describe('the support address in Settings', () => {
  it('CRITICAL is a link the shell plugin will hand to the mail app', () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <SettingsView />
        </ConfirmProvider>
      </ToastProvider>,
    );
    const link = screen.getByRole('link', { name: 'support@driftstack.dev' });
    expect(link).toHaveAttribute('href', 'mailto:support@driftstack.dev');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
