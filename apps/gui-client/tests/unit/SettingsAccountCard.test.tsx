// V-534.L — unit tests for SettingsAccountCard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

// The card now offers a click-to-copy account id, which pushes a toast — so it
// depends on <ToastProvider>. Mock useToasts (mirrors the sibling views' tests)
// so the card mounts without a provider tree.
vi.mock('../../src/lib/toasts', () => ({
  useToasts: () => ({ push: vi.fn() }),
}));

const { SettingsAccountCard } = await import('../../src/components/SettingsAccountCard');

const ACCOUNT = {
  account: { id: 'acc_test123', email: 'user@example.com', tier: 'solo_manual' },
};

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.L SettingsAccountCard — fetch happy path', () => {
  it('renders the account id, email, and tier once /v1/account/me resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(ACCOUNT),
        } as unknown as Response),
      ),
    );
    render(<SettingsAccountCard />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading account/i);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.getByText('acc_test123')).toBeTruthy();
    expect(screen.getByText('user@example.com')).toBeTruthy();
    // Tier is humanized ('solo_manual' → 'Solo Manual') so the card never shows
    // a raw lowercase database slug to the customer.
    expect(screen.getByText('Solo Manual')).toBeTruthy();
  });

  it('points the "Manage billing" link to the prod dashboard for prod baseUrls', () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk', baseUrl: 'https://api.driftstack.dev' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(ACCOUNT),
        } as unknown as Response),
      ),
    );
    render(<SettingsAccountCard />);
    const link = screen.getByRole('link', { name: /manage billing/i });
    expect(link.getAttribute('href')).toBe('https://app.driftstack.dev/billing');
  });

  it('points "Manage billing" at localhost for local dev baseUrls', () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk', baseUrl: 'http://localhost:8787' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(ACCOUNT),
        } as unknown as Response),
      ),
    );
    render(<SettingsAccountCard />);
    const link = screen.getByRole('link', { name: /manage billing/i });
    expect(link.getAttribute('href')).toBe('http://localhost:5173/billing');
  });
});

describe('V-534.L SettingsAccountCard — failure paths', () => {
  it('shows the error message when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    render(<SettingsAccountCard />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no api key/i));
  });

  it('maps an HTTP 401 from /v1/account/me to plain-English guidance (not a raw "HTTP 401")', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    render(<SettingsAccountCard />);
    // errorMessageForStatus(401) → actionable copy, and no bare "HTTP 401".
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/api key wasn't accepted/i),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/HTTP 401/);
  });

  it('surfaces a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    render(<SettingsAccountCard />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/offline/));
  });
});
