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
    expect(screen.getByText('solo_manual')).toBeTruthy();
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

  it('surfaces an HTTP error from /v1/account/me', async () => {
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
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/401/));
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
