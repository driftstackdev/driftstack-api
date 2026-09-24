import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BundledLlmConsentRequiredError } from '@driftstack/sdk';

/**
 * GUI audit #10 — in a teammate's workspace, "Save AI billing" (Settings) and
 * "Enable AI features" (the AI chat's consent banner) always fail: the server
 * refuses the bundled-AI settings change for any request acting as another
 * account (`account-bundled-llm.ts`, self workspace only), and the old copy said
 * "try again", which cannot help. Both controls are disabled there, with copy
 * that says the settings belong to the workspace owner and to switch to Personal
 * to change your own.
 */

const OWNER_WORKSPACE = 'acc_the_workspace_owner';
const BELONGS_TO_OWNER =
  /AI settings belong to the workspace owner\. Switch to Personal to change your own\./;

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const get = vi.fn();
const updateBundledLlmSettings = vi.fn((body: { consent?: boolean }) =>
  Promise.resolve({ consent: body.consent ?? true, monthly_cap_usd_cents: 500 }),
);

const CLIENT = {
  agentSessions: {
    create,
    message,
    close,
    get,
    livekitToken: () => Promise.resolve({ ws_url: '', room: '', token: '' }),
  },
  profiles: {
    iterate: function* () {
      yield { id: 'prof_x', name: 'Work profile' };
    },
  },
  account: {
    getBundledLlmSettings: () => Promise.resolve({ consent: false, monthly_cap_usd_cents: 0 }),
    getBundledLlmStatus: () =>
      Promise.resolve({
        consent: false,
        cap_cents: 0,
        used_this_month_cents: 0,
        remaining_cents: 0,
        refused_count_this_month: 0,
        month_started_at: '2026-09-01T00:00:00.000Z',
      }),
    getByokAnthropicKey: () =>
      Promise.resolve({ has_key: false, set_at: null, last_used_at: null }),
    updateBundledLlmSettings,
  },
};

let activeWorkspace: string | null = OWNER_WORKSPACE;
const SETTINGS = {
  apiKey: 'ds_live_member_key',
  baseUrl: 'https://api.example.test',
  telemetryOptIn: null,
  startUrl: 'https://driftstack.io',
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: CLIENT,
    settings: SETTINGS,
    activeWorkspace,
    loading: false,
    accountMe: null,
    refreshAccountMe: () => Promise.resolve(),
    update: () => Promise.resolve(),
  }),
}));
vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({ state: { kind: 'idle' }, start: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
  listBindings: () => Promise.resolve([]),
}));
vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
  chatTurnCount: (c: { turns: unknown[] }) => c.turns.length,
}));

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');
const { SettingsView } = await import('../../src/views/SettingsView');
const { ToastProvider } = await import('../../src/lib/toasts');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

const PROMPT = /Describe a task in plain English/i;

function consentRefusal(): BundledLlmConsentRequiredError {
  return new BundledLlmConsentRequiredError({
    type: 'https://errors.driftstack.dev/bundled-llm-consent-required',
    title: 'Bundled LLM consent required',
    status: 402,
    detail: 'x',
  });
}

async function openConsentBanner(): Promise<HTMLElement> {
  create.mockRejectedValue(consentRefusal());
  render(
    <ToastProvider>
      <AgentChatProvider>
        <AgentChatView initialProfileId="prof_x" />
      </AgentChatProvider>
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'find me a flight' } });
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
  return screen.findByRole('button', { name: /Enable AI features/ });
}

function renderSettings(): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsView />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  create.mockReset();
  message.mockReset();
  close.mockReset();
  get.mockReset();
  updateBundledLlmSettings.mockClear();
  activeWorkspace = OWNER_WORKSPACE;
});

describe("the AI chat's Enable AI features in a teammate's workspace", () => {
  it('CRITICAL is disabled, says the settings belong to the workspace owner, and sends nothing', async () => {
    const enable = await openConsentBanner();
    expect(enable).toBeDisabled();
    expect(screen.getByText(BELONGS_TO_OWNER)).toBeInTheDocument();
    fireEvent.click(enable);
    expect(updateBundledLlmSettings).not.toHaveBeenCalled();
  });

  it('CONTROL — in Personal it is enabled and turns AI features on', async () => {
    activeWorkspace = null;
    const enable = await openConsentBanner();
    expect(enable).not.toBeDisabled();
    expect(screen.queryByText(BELONGS_TO_OWNER)).toBeNull();
    fireEvent.click(enable);
    await waitFor(() => expect(updateBundledLlmSettings).toHaveBeenCalledWith({ consent: true }));
  });
});

describe("Settings' Save AI billing in a teammate's workspace", () => {
  it('CRITICAL Save and both AI billing fields are disabled, with the owner copy', async () => {
    renderSettings();
    const save = await screen.findByRole('button', { name: 'Save AI billing settings' });
    // The settings load first; the disable must hold after they have.
    await waitFor(() =>
      expect(screen.getByLabelText('Use bundled AI billing')).toBeInTheDocument(),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(save).toBeDisabled();
    expect(screen.getByLabelText('Use bundled AI billing')).toBeDisabled();
    expect(screen.getByText(BELONGS_TO_OWNER)).toBeInTheDocument();
    fireEvent.click(save);
    expect(updateBundledLlmSettings).not.toHaveBeenCalled();
  });

  it('CONTROL — in Personal, Save is enabled once the settings load', async () => {
    activeWorkspace = null;
    renderSettings();
    const save = await screen.findByRole('button', { name: 'Save AI billing settings' });
    await waitFor(() => expect(save).not.toBeDisabled());
    expect(screen.queryByText(BELONGS_TO_OWNER)).toBeNull();
  });
});
