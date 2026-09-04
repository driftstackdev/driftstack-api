// V-534.L — unit tests for SettingsAccountCard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

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

// ⛔ V-1611 — this fixture used to be `{ account: { id, ... } }`, which the
// server has never sent. It agreed with the component's wrong assumption instead
// of with the route, so the suite stayed green while the Settings tab crashed in
// production on the SUCCESS path. The FLAT shape below is what
// `GET /v1/account/me` actually returns; a cross-source guard now pins that so a
// fixture cannot be the only description of the contract again.
const ACCOUNT = { id: 'acc_test123', email: 'user@example.com', tier: 'solo_manual' };

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(link.getAttribute('href')).toBe('https://app.driftstack.io/billing/');
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
    expect(link.getAttribute('href')).toBe('http://localhost:5173/billing/');
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

  it.each([
    [404, 'Account info is not available for this key.'],
    [429, 'Too many requests. Wait a moment, then retry.'],
    [503, 'The account service is temporarily unavailable. Try again shortly.'],
    [418, "Couldn't load account info. Check the server URL, then retry."],
  ])('maps HTTP %s to actionable copy without raw status/body text', async (status, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status,
          json: () => Promise.resolve({ detail: 'private host node.internal token=secret' }),
        } as unknown as Response),
      ),
    );
    render(<SettingsAccountCard />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expected));
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      new RegExp(`HTTP|${status.toString()}|node\\.internal|token=secret`, 'i'),
    );
  });

  it('cancels an unread HTTP error body before rendering status guidance', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 })),
      ),
    );
    render(<SettingsAccountCard />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/api key wasn't accepted/i),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('humanizes a network error instead of exposing the raw exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    render(<SettingsAccountCard />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/check your connection/i),
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/offline/i);
  });

  it('replaces indefinite loading with actionable timeout feedback after 15 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );
    render(<SettingsAccountCard />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/request took too long/i);
    expect(screen.queryByText(/loading account/i)).toBeNull();
  });

  it('aborts its active account request on unmount', () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );

    const { unmount } = render(<SettingsAccountCard />);
    expect(signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
