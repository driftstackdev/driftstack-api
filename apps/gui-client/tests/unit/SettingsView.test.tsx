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

describe('SettingsView (V-288 jsdom + RTL foundation)', () => {
  it('renders without crashing in the no-API-key-yet state', () => {
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: null,
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
        startUrl: 'https://driftstack.dev',
      },
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

  it('clearing the Start URL field saves the DEFAULT (not the old custom value) and re-syncs the field', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
        // A custom start URL the customer previously saved.
        startUrl: 'https://shop.example.com',
      },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update,
    });
    renderWithToasts();

    const startInput = screen.getByDisplayValue<HTMLInputElement>('https://shop.example.com');
    // Clear the field — intent is "reset to default", not "keep my old custom URL".
    fireEvent.change(startInput, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The persisted startUrl must be the DEFAULT, not the prior custom value — a
    // blank-clear that silently kept the old value left the field stuck/dirty.
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[0]).toMatchObject({ startUrl: 'https://driftstack.dev' });
    // And the field re-syncs to the saved default instead of staying blank.
    expect(startInput.value).toBe('https://driftstack.dev');
  });

  it('coalesces rapid Save clicks into one credential-store write', async () => {
    let releaseUpdate!: () => void;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        }),
    );
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: null,
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

    fireEvent.change(screen.getByPlaceholderText('https://driftstack.dev'), {
      target: { value: 'https://example.com' },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    releaseUpdate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
  });

  it('shows a safe persistence failure, skips key validation, and permits one retry', async () => {
    const update = vi
      .fn<MockSettings['update']>()
      .mockRejectedValueOnce(
        new Error('securityd denied /Users/customer/Library/Keychains token=private-key'),
      )
      .mockResolvedValueOnce();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ git_sha: 'settings-test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: null,
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

    fireEvent.change(screen.getByPlaceholderText('https://driftstack.dev'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText("Couldn't save settings")).toBeInTheDocument();
    expect(screen.getByText(/system credential store, then try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/securityd|\/Users\/customer|token=private-key/i)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/account/me'))).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
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
    // (ds_live_abcdef01…zzzz). The masked form now appears in BOTH the banner AND
    // the embedded connectivity probe (which also adopted the shared mask — audit),
    // so assert ≥1 occurrence rather than exactly one.
    expect(screen.getAllByText(/ds_live_abcd…zzzz/).length).toBeGreaterThanOrEqual(1);
    // The over-exposing 12-from-start body must NOT appear anywhere (banner OR probe).
    expect(screen.queryByText(/abcdef0123/)).toBeNull();
    // The connectivity probe's old 8-from-start slice (ds_live_…) must not leak either.
    expect(screen.queryByText(/abcdef01…/)).toBeNull();
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

  it('aborts and invalidates a stale connection test when deployment changes', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    let resolveProbe!: (response: Response) => void;
    let probeSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        probeSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        });
      }),
    );
    renderWithToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(probeSignal).toBeInstanceOf(AbortSignal));
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();

    fireEvent.click(screen.getByText('Self-hosted'));
    expect(probeSignal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Test connection' })).not.toBeDisabled();

    resolveProbe(
      new Response(JSON.stringify({ git_sha: 'stale123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.resolve();
    expect(screen.queryByText(/Reachable/)).toBeNull();
    expect(screen.queryByText(/stale123/)).toBeNull();
  });

  it('keeps target-aware connection guidance without raw network internals', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(new Error('Load failed private-api.internal /Users/customer token=secret')),
      ),
    );
    renderWithToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(
      await screen.findByText(/Couldn't reach https:\/\/api\.driftstack\.dev/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-api|\/Users|token=secret|Underlying error/i)).toBeNull();
  });

  it('maps a failed connection response without rendering a bare HTTP status', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev', telemetryOptIn: null },
      loading: false,
      client: null,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 503 }))),
    );
    renderWithToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(
      await screen.findByText(/The service is temporarily unavailable\. Try again shortly\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('HTTP 503')).toBeNull();
  });

  it('aborts post-save key validation on unmount', async () => {
    const update = vi.fn(() => Promise.resolve());
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: null,
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
    let validationSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        validationSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const view = renderWithToasts();
    fireEvent.change(screen.getByPlaceholderText('ds_live_…'), {
      target: { value: 'ds_live_new_key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(validationSignal).toBeInstanceOf(AbortSignal));
    expect(screen.getByText('Saved. Validating key…')).toBeInTheDocument();
    view.unmount();
    expect(validationSignal?.aborted).toBe(true);
  });

  it('owns one AI billing PATCH and freezes the consent/cap draft until it settles', async () => {
    let releaseSave!: (value: { consent: boolean; monthly_cap_usd_cents: number }) => void;
    const updateBundledLlmSettings = vi.fn(
      () =>
        new Promise<{ consent: boolean; monthly_cap_usd_cents: number }>((resolve) => {
          releaseSave = resolve;
        }),
    );
    const client = makeClient({ updateBundledLlmSettings });
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
      },
      loading: false,
      client,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    const consent = await screen.findByRole<HTMLInputElement>('checkbox');
    const cap = screen.getByRole<HTMLInputElement>('spinbutton');
    fireEvent.click(consent);
    fireEvent.change(cap, { target: { value: '25.00' } });
    const save = screen.getByRole('button', { name: 'Save AI billing settings' });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(updateBundledLlmSettings).toHaveBeenCalledTimes(1);
    expect(updateBundledLlmSettings).toHaveBeenCalledWith({
      consent: true,
      monthly_cap_usd_cents: 2500,
    });
    expect(consent).toBeDisabled();
    expect(cap).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save AI billing settings' })).toBeDisabled();

    releaseSave({ consent: true, monthly_cap_usd_cents: 2500 });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(consent).not.toBeDisabled());
    expect(cap).not.toBeDisabled();
  });

  it('invalidates an older AI billing save on client replacement and releases failure for retry', async () => {
    let resolveOld!: (value: { consent: boolean; monthly_cap_usd_cents: number }) => void;
    const oldUpdate = vi
      .fn<MockClient['account']['updateBundledLlmSettings']>()
      .mockRejectedValueOnce(new Error('private billing backend detail'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      );
    const oldClient = makeClient({ updateBundledLlmSettings: oldUpdate });
    const newClient = makeClient({
      getBundledLlmSettings: vi.fn(() =>
        Promise.resolve({ consent: false, monthly_cap_usd_cents: 500 }),
      ),
    });
    let currentClient = oldClient;
    useSettingsMock.mockImplementation(() => ({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
      },
      loading: false,
      client: currentClient,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    }));
    const view = renderWithToasts();

    const cap = await screen.findByRole<HTMLInputElement>('spinbutton');
    fireEvent.change(cap, { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save AI billing settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't save/i);
    expect(screen.queryByText(/private billing backend detail/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save AI billing settings' }));
    expect(oldUpdate).toHaveBeenCalledTimes(2);

    currentClient = newClient;
    view.rerender(
      <ToastProvider>
        <ConfirmProvider>
          <SettingsView />
        </ConfirmProvider>
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('5.00'),
    );

    resolveOld({ consent: true, monthly_cap_usd_cents: 1000 });
    await Promise.resolve();
    expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('5.00');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('owns BYOK Test and Clear as one action so a cleared key cannot regain stale Working state', async () => {
    let releaseTest!: (result: { ok: true }) => void;
    let releaseClear!: () => void;
    const testByokAnthropicKey = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseTest = resolve;
        }),
    );
    const clearByokAnthropicKey = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        }),
    );
    const client = makeClient({
      getByokAnthropicKey: vi.fn(() =>
        Promise.resolve({
          has_key: true,
          set_at: '2026-07-15T00:00:00.000Z',
          last_used_at: null,
        }),
      ),
      testByokAnthropicKey,
      clearByokAnthropicKey,
    });
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
      },
      loading: false,
      client,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    const test = await screen.findByRole('button', { name: 'Test Anthropic key' });
    const clear = screen.getByRole('button', { name: 'Clear' });
    fireEvent.click(test);
    fireEvent.click(test);

    expect(testByokAnthropicKey).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Test Anthropic key' })).toBeDisabled();
    expect(clear).toBeDisabled();
    fireEvent.click(clear);
    expect(clearByokAnthropicKey).not.toHaveBeenCalled();

    releaseTest({ ok: true });
    expect(await screen.findByText('✓ Working')).toBeInTheDocument();
    await waitFor(() => expect(clear).not.toBeDisabled());

    fireEvent.click(clear);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear key' }));
    await waitFor(() => expect(clearByokAnthropicKey).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test Anthropic key' })).toBeDisabled();

    releaseClear();
    expect(await screen.findByPlaceholderText('sk-ant-…')).toBeInTheDocument();
    expect(screen.queryByText('✓ Working')).toBeNull();
  });

  it('owns BYOK Set through metadata refresh and its one automatic connection test', async () => {
    let releaseSet!: () => void;
    let releaseTest!: (result: { ok: true }) => void;
    const setByokAnthropicKey = vi.fn(
      () =>
        new Promise<{ set_at: string }>((resolve) => {
          releaseSet = () => resolve({ set_at: '2026-07-15T00:00:00.000Z' });
        }),
    );
    const testByokAnthropicKey = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          releaseTest = resolve;
        }),
    );
    const getByokAnthropicKey = vi
      .fn<MockClient['account']['getByokAnthropicKey']>()
      .mockResolvedValueOnce({ has_key: false, set_at: null, last_used_at: null })
      .mockResolvedValue({
        has_key: true,
        set_at: '2026-07-15T00:00:00.000Z',
        last_used_at: null,
      });
    const client = makeClient({
      getByokAnthropicKey,
      setByokAnthropicKey,
      testByokAnthropicKey,
    });
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
      },
      loading: false,
      client,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    const draft = await screen.findByPlaceholderText('sk-ant-…');
    fireEvent.change(draft, { target: { value: 'sk-ant-customer-secret' } });
    const set = screen.getByRole('button', { name: 'Set key' });
    fireEvent.click(set);
    fireEvent.click(set);

    expect(setByokAnthropicKey).toHaveBeenCalledTimes(1);
    expect(setByokAnthropicKey).toHaveBeenCalledWith('sk-ant-customer-secret');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    releaseSet();
    await waitFor(() => expect(testByokAnthropicKey).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Test Anthropic key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();

    releaseTest({ ok: true });
    expect(await screen.findByText('✓ Working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Anthropic key' })).not.toBeDisabled();
    expect(testByokAnthropicKey).toHaveBeenCalledTimes(1);
  });

  it('releases a failed BYOK Set owner for one honest retry', async () => {
    const setByokAnthropicKey = vi
      .fn<MockClient['account']['setByokAnthropicKey']>()
      .mockRejectedValueOnce(new Error('provider write failed with secret=private'))
      .mockResolvedValueOnce({ set_at: '2026-07-15T00:00:00.000Z' });
    const getByokAnthropicKey = vi
      .fn<MockClient['account']['getByokAnthropicKey']>()
      .mockResolvedValueOnce({ has_key: false, set_at: null, last_used_at: null })
      .mockResolvedValue({
        has_key: true,
        set_at: '2026-07-15T00:00:00.000Z',
        last_used_at: null,
      });
    const testByokAnthropicKey = vi.fn(() => Promise.resolve({ ok: true as const }));
    const client = makeClient({
      getByokAnthropicKey,
      setByokAnthropicKey,
      testByokAnthropicKey,
    });
    useSettingsMock.mockReturnValue({
      settings: {
        apiKey: 'ds_live_x',
        baseUrl: 'https://api.driftstack.dev',
        telemetryOptIn: null,
      },
      loading: false,
      client,
      accountMe: null,
      refreshAccountMe: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
    });
    renderWithToasts();

    fireEvent.change(await screen.findByPlaceholderText('sk-ant-…'), {
      target: { value: 'sk-ant-retry' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't save your Anthropic key/i);
    expect(screen.queryByText(/secret=private|provider write failed/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
    await waitFor(() => expect(setByokAnthropicKey).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('✓ Working')).toBeInTheDocument();
    expect(testByokAnthropicKey).toHaveBeenCalledTimes(1);
  });
});
