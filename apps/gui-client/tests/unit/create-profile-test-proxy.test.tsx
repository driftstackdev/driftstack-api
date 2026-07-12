// Behavior coverage for the create-profile modal's "Test proxy" button
// (CreateProfileModal.handleTestDraftProxy inside ProfilesView). Distinct
// from the Proxies-tab handler covered in proxies-view-test-button:
// here the proxy is an unsaved inline draft. This pins the empty-host
// guard — the "Test proxy" button is disabled until a host is entered,
// so the native probe can't fire on an empty draft — and the happy
// path that forwards a filled draft to testProxy.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const testProxy = vi.fn(() =>
  Promise.resolve({
    reachable: true,
    auth_ok: true,
    udp_associate: true,
    latency_ms: 12,
    message: 'ok',
  }),
);

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [] }),
        iterate: function* () {},
        create: vi.fn(() => Promise.resolve({ id: 'prof_1' })),
      },
      sessions: { list: () => Promise.resolve({ data: [] }) },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 0,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
  };
  return { useSettings: () => stable };
});

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: (input: unknown) => testProxy(input),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

async function openCreateModal(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  // Empty state CTA opens the modal. With no saved proxies the modal's
  // proxy selector defaults to the inline "create-new" SOCKS5 form, so
  // the "Test proxy" button is present without further interaction.
  const open = await screen.findByRole('button', { name: 'Create your first profile' });
  fireEvent.click(open);
  // Configurator port (2026-06-12): the proxy mini-form lives behind the
  // Proxy tab now — select it so the Test button renders.
  fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
}

describe('create-profile modal "Test proxy" draft validation', () => {
  beforeEach(() => {
    testProxy.mockClear();
  });

  it('empty host → Test button disabled, native probe cannot be invoked', async () => {
    await openCreateModal();
    const testBtn = await screen.findByRole('button', { name: 'Test proxy' });
    // The button guards the empty-host case (the handler also validates
    // defensively); a disabled button means the probe never fires.
    expect(testBtn).toBeDisabled();
    fireEvent.click(testBtn);
    expect(testProxy).not.toHaveBeenCalled();
  });

  it('valid host + default port → forwards the draft to the native probe', async () => {
    await openCreateModal();
    const host = await screen.findByPlaceholderText(/Host \(e\.g\. proxy\.example\.com\)/);
    fireEvent.change(host, { target: { value: 'proxy.example.com' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Test proxy' }));

    expect(testProxy).toHaveBeenCalledTimes(1);
    expect(testProxy).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'proxy.example.com', port: 1080 }),
    );
  });

  it('humanizes a thrown native probe exception', async () => {
    testProxy.mockRejectedValueOnce(new Error('offline helper stack /private/tmp/proxy'));
    await openCreateModal();
    const host = await screen.findByPlaceholderText(/Host \(e\.g\. proxy\.example\.com\)/);
    fireEvent.change(host, { target: { value: 'proxy.example.com' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Test proxy' }));

    await waitFor(() =>
      expect(screen.getByText('Check your connection and try again.')).toBeTruthy(),
    );
    expect(screen.queryByText(/private\/tmp|offline helper stack/i)).toBeNull();
  });

  it('the device picker makes ALL selectable (launch+available) archetypes clickable — not only iPhone 17', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const open = await screen.findByRole('button', { name: 'Create your first profile' });
    fireEvent.click(open);
    // The redesigned device picker lives on the default '📱 Identity' tab. Each
    // list row carries a '✓ bit-exact' (selectable) or 'reference' badge; a row
    // is keyboard-selectable (tabindex 0) iff its status is in
    // SELECTABLE_STATUSES {launch, available}. The picker must NOT regress to
    // status==='launch' (which left only iPhone 17 clickable).
    const bitExact = await screen.findAllByText('✓ bit-exact');
    // The full catalog (1 launch + 80 available) → far more than one selectable row.
    expect(bitExact.length).toBeGreaterThan(1);
    // Each '✓ bit-exact' badge sits inside a SELECTABLE option row (focusable,
    // not aria-disabled).
    for (const badge of bitExact) {
      const row = badge.closest('[role="option"]');
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute('tabindex', '0');
      expect(row).toHaveAttribute('aria-disabled', 'false');
    }
    // The Randomize button is enabled (≥ 2 selectable devices visible).
    expect(screen.getByRole('button', { name: /Randomize/ })).not.toBeDisabled();
  });
});
