// The chat's model picker listed Opus unconditionally. On an account with no
// Anthropic key of its own, picking it led straight into a refusal: the
// deployment's key never runs an own-key-only model (CLAUDE_MODEL_KEY_POLICY).
//
// The picker now reads that policy. Only a KNOWN "no key" marks those models —
// disabled, and labelled with why — and they stay IN the list, because a
// reopened chat stored on Opus must still match an option (a controlled select
// with no matching option silently shows the first one, i.e. a model the chat
// never ran on). Unknown status — no account API on the client, a failed read —
// leaves every model selectable; the turn's own refusal covers that case.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { CLAUDE_MODEL_KEY_POLICY, DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

interface KeyStatus {
  has_key: boolean;
  set_at: string | null;
  last_used_at: string | null;
}

const h = vi.hoisted(() => ({
  useAgentChat: vi.fn<(opts: object) => UseAgentChatResult>(),
  loadChats: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
  getByokAnthropicKey: vi.fn<() => Promise<KeyStatus>>(),
  client: null as null | Record<string, unknown>,
}));

const BASE_CLIENT = {
  profiles: {
    iterate: function* () {
      yield { id: 'prof_x', name: 'Bank profile' };
    },
  },
  agentSessions: { livekitToken: () => Promise.resolve({ ws_url: '', room: '', token: '' }) },
};
/** The client most chat tests use: no `account` resource at all. */
const CLIENT_WITHOUT_ACCOUNT = BASE_CLIENT;
const CLIENT_WITH_ACCOUNT = {
  ...BASE_CLIENT,
  account: { getByokAnthropicKey: h.getByokAnthropicKey },
};

vi.mock('../../src/lib/SettingsContext', () => {
  const settings = { apiKey: 'sk-test', baseUrl: 'https://api.example.test' };
  return { useSettings: () => ({ client: h.client, settings }) };
});
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
vi.mock('../../src/lib/account-proxies', () => ({ createProxy: vi.fn(), updateProxy: vi.fn() }));
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => h.loadChats(),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
  chatTurnCount: (c: { turns: unknown[] }) => c.turns.length,
}));
vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: h.useAgentChat }));

const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

// COMPLETE UseAgentChatResult so this double adds nothing to the test-type backlog.
function chatWith(over: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: null,
    sending: false,
    liveSteps: [],
    livePhase: null,
    livePlan: null,
    liveStepIndex: null,
    liveAnswer: null,
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    send: vi.fn(() => Promise.resolve(true)),
    lastSendKeptMessage: () => false,
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    cancel: vi.fn(),
    stoppedTurnStillRunning: false,
    restore: vi.fn(),
    adopt: vi.fn(),
    adopting: false,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
    ...over,
  };
}

// Derived from the shared policy, so the picker is held to what the server
// enforces rather than to a second hand-kept list.
const POLICY = Object.entries(CLAUDE_MODEL_KEY_POLICY);
const OWN_KEY_ONLY = POLICY.filter(([, p]) => p === 'own_key_only').map(([id]) => id);
const ANY_KEY = POLICY.filter(([, p]) => p === 'any_key').map(([id]) => id);
const SUFFIX = '(needs your own key)';

function modelSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Model' });
}
function option(id: string): HTMLOptionElement {
  const el = modelSelect().querySelector<HTMLOptionElement>(`option[value="${id}"]`);
  if (el === null) throw new Error(`no option for ${id}`);
  return el;
}

async function renderView(): Promise<void> {
  render(<AgentChatView initialProfileId="prof_x" />, { wrapper: AgentChatProvider });
  await waitFor(() => expect(modelSelect()).toBeInTheDocument());
}

/** Let the key-status read settle, whatever it resolved to. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function expectEveryModelSelectable(): void {
  for (const id of [...OWN_KEY_ONLY, ...ANY_KEY]) {
    expect(option(id).disabled, id).toBe(false);
    expect(option(id).textContent, id).not.toContain(SUFFIX);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.client = CLIENT_WITH_ACCOUNT;
  h.loadChats.mockResolvedValue([]);
  h.useAgentChat.mockReturnValue(chatWith());
});

describe('the model picker and the account’s own key', () => {
  it('with no own key, the own-key-only models are disabled and say why; Sonnet 5 is selectable', async () => {
    // The two the product decision is about, whatever else the policy lists.
    expect(OWN_KEY_ONLY).toContain('claude-opus-5');
    expect(ANY_KEY).toContain(DEFAULT_AGENT_MODEL);
    h.getByokAnthropicKey.mockResolvedValue({ has_key: false, set_at: null, last_used_at: null });
    await renderView();

    await waitFor(() => expect(option('claude-opus-5').disabled).toBe(true));
    expect(option('claude-opus-5').textContent).toBe(`Opus 5 ${SUFFIX}`);
    for (const id of OWN_KEY_ONLY) {
      expect(option(id).disabled, id).toBe(true);
      expect(option(id).textContent, id).toContain(SUFFIX);
    }
    for (const id of ANY_KEY) {
      expect(option(id).disabled, id).toBe(false);
      expect(option(id).textContent, id).not.toContain(SUFFIX);
    }
    // Still listed — disabled, not removed.
    expect(modelSelect().options).toHaveLength(6);

    // Sonnet 5 is the default and stays a real choice: move away and back.
    expect(modelSelect().value).toBe('claude-sonnet-5');
    fireEvent.change(modelSelect(), { target: { value: 'claude-haiku-4-5' } });
    expect(modelSelect().value).toBe('claude-haiku-4-5');
    fireEvent.change(modelSelect(), { target: { value: 'claude-sonnet-5' } });
    expect(modelSelect().value).toBe('claude-sonnet-5');
  });

  it('CONTROL — with an own key, every model is selectable and unlabelled', async () => {
    h.getByokAnthropicKey.mockResolvedValue({
      has_key: true,
      set_at: '2026-09-01T00:00:00Z',
      last_used_at: null,
    });
    await renderView();
    await waitFor(() => expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1));
    await settle();
    expectEveryModelSelectable();
  });

  it('with no account API on the client, the picker still renders every model enabled', async () => {
    h.client = CLIENT_WITHOUT_ACCOUNT;
    await renderView();
    await settle();
    expect(modelSelect().options).toHaveLength(6);
    expectEveryModelSelectable();
  });

  it('a failed key-status read leaves every model enabled (unknown is not "no key")', async () => {
    h.getByokAnthropicKey.mockRejectedValue(new Error('offline'));
    await renderView();
    await waitFor(() => expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1));
    await settle();
    expectEveryModelSelectable();
  });

  it('a key-status read that throws synchronously does not take the chat down', async () => {
    h.getByokAnthropicKey.mockImplementation(() => {
      throw new Error('not a promise');
    });
    await renderView();
    await settle();
    expectEveryModelSelectable();
  });

  it('reads the status once when the view mounts and again on the next visit — it does not poll', async () => {
    h.getByokAnthropicKey.mockResolvedValue({ has_key: false, set_at: null, last_used_at: null });
    // Fake timers from BEFORE the mount, so a poll the view arms is one this test
    // controls: without them, a timer-driven re-read would simply not have fired
    // yet within the test's few real milliseconds, and "once" would prove nothing.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = render(<AgentChatView initialProfileId="prof_x" />, {
        wrapper: AgentChatProvider,
      });
      await waitFor(() => expect(option('claude-opus-5').disabled).toBe(true));
      await settle();
      expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1);
      // A long stay on the view: an interval or a re-arming timeout would read again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60_000);
      });
      expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1);
      first.unmount();
    } finally {
      vi.useRealTimers();
    }

    // Back from Settings with a key added: the next mount reads it fresh.
    h.getByokAnthropicKey.mockResolvedValue({
      has_key: true,
      set_at: '2026-09-19T00:00:00Z',
      last_used_at: null,
    });
    await renderView();
    await waitFor(() => expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(2));
    await settle();
    expectEveryModelSelectable();
  });

  it('a reopened chat stored on Opus 5 still shows Opus 5 when the account has no key', async () => {
    h.getByokAnthropicKey.mockResolvedValue({ has_key: false, set_at: null, last_used_at: null });
    const turns = [{ id: 1, role: 'user' as const, text: 'book a table' }];
    h.loadChats.mockResolvedValue([
      {
        id: 'chat_1',
        title: 'Chat',
        profileId: 'prof_x',
        model: 'claude-opus-5',
        turns,
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'agt_old',
      },
    ]);
    await renderView();
    await waitFor(() => expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1));
    await settle();

    const row = (await screen.findByText('Chat')).closest('button');
    expect(row).not.toBeNull();
    // Opening it restores its turns, which is what locks the picker to its model.
    h.useAgentChat.mockReturnValue(chatWith({ turns }));
    fireEvent.click(row as HTMLButtonElement);

    // The select shows the model the chat actually ran on, labelled with why it
    // is unavailable for a new chat — not a silent fallback to the first option.
    await waitFor(() => expect(modelSelect().value).toBe('claude-opus-5'));
    const selected = modelSelect().selectedOptions[0];
    expect(selected?.textContent).toBe(`Opus 5 ${SUFFIX}`);
    expect(modelSelect()).toBeDisabled();
  });

  async function openStoredOpusChat(hasKey: boolean): Promise<void> {
    h.getByokAnthropicKey.mockResolvedValue({ has_key: hasKey, set_at: null, last_used_at: null });
    const turns = [{ id: 1, role: 'user' as const, text: 'book a table' }];
    h.loadChats.mockResolvedValue([
      {
        id: 'chat_1',
        title: 'Chat',
        profileId: 'prof_x',
        model: 'claude-opus-5',
        turns,
        createdAt: 1,
        updatedAt: 2,
        sessionId: 'agt_old',
      },
    ]);
    await renderView();
    await waitFor(() => expect(h.getByokAnthropicKey).toHaveBeenCalledTimes(1));
    await settle();
    const row = (await screen.findByText('Chat')).closest('button');
    h.useAgentChat.mockReturnValue(chatWith({ turns }));
    fireEvent.click(row as HTMLButtonElement);
    await waitFor(() => expect(modelSelect().value).toBe('claude-opus-5'));
    // New chat empties the conversation, which unlocks the picker.
    h.useAgentChat.mockReturnValue(chatWith());
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  }

  it('a New chat opened from a reopened Opus chat starts on the default model when the account has no key', async () => {
    await openStoredOpusChat(false);
    await waitFor(() => expect(modelSelect().value).toBe(DEFAULT_AGENT_MODEL));
    expect(modelSelect()).not.toBeDisabled();
  });

  it('CONTROL — with an own key, a New chat keeps the model the customer was using', async () => {
    await openStoredOpusChat(true);
    await waitFor(() => expect(modelSelect()).not.toBeDisabled());
    expect(modelSelect().value).toBe('claude-opus-5');
  });
});
