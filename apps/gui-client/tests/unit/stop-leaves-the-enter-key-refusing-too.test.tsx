// P6 — Stop leaves the ENTER KEY offering the send that will be refused.
//
// The client half of P6 disabled the Send BUTTON while the stopped turn is still
// running on the server, and stopped there. `submit()` — the function the button
// AND the ⏎ key both call — never read the new flag, and the composer's own
// placeholder says "⏎ to send". So the 409 this item exists to remove was still
// one keystroke away, and the P6 suite could not see it: it renders the hook and
// never mounts the view, so it proves the flag EXISTS, not that the UI honours
// it.
//
// ⛔ THE CONVENTION WAS ALREADY WRITTEN DOWN three lines above the guard list:
// "The Send button is disabled too; this also guards the Enter-to-send path."
// `chat.adopting` follows it (see a-reopened-chat-send-waits-for-adopt.test.tsx,
// whose harness this file reuses). The new state did not.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

const h = vi.hoisted(() => ({
  listProxies: vi.fn<() => Promise<unknown[]>>(),
  listBindings: vi.fn<() => Promise<unknown[]>>(),
  useAgentChat: vi.fn<(opts: { profileId?: string; proxyId?: string }) => UseAgentChatResult>(),
}));

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: h.listProxies,
  setProxyServerId: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/profile-bindings', () => ({ listBindings: h.listBindings }));
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(),
  updateProxy: vi.fn(),
}));
vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        iterate: function* () {
          yield { id: 'prof_x', name: 'Bank profile' };
        },
      },
      agentSessions: { livekitToken: () => Promise.resolve({ ws_url: '', room: '', token: '' }) },
    },
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
});
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/chat-history', () => ({
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
}));

const send = vi.fn(() => Promise.resolve(true));

// COMPLETE UseAgentChatResult (every field the interface declares) so this mock does
// not add a TS2739 to the pinned tsconfig.test.json backlog.
function chatWith(stoppedTurnStillRunning: boolean): UseAgentChatResult {
  return {
    turns: [],
    session: null,
    sending: false,
    liveSteps: [],
    // B2/B4 — progress captions and the "was the message kept?" accessor are
    // part of the interface now; a double that omits them is incomplete, and
    // this file exists to keep the pinned type backlog from growing.
    livePhase: null,
    livePlan: null,
    liveStepIndex: null,
    liveAnswer: null,
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    send,
    lastSendKeptMessage: () => false,
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    cancel: vi.fn(),
    stoppedTurnStillRunning,
    restore: vi.fn(),
    adopt: vi.fn(),
    // Not adopting and not sending: `stoppedTurnStillRunning` is the ONLY gate
    // in play, so an arm that passes here passes because of it.
    adopting: false,
    adoptError: null,
    restoredHistoryCount: 0,
    restoredSessionId: null,
  };
}

vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: h.useAgentChat }));

const { AgentChatView } = await import('../../src/views/AgentChatView');
// B5 — the chat hook now lives in a provider ABOVE the view switch (leaving the
// AI view used to unmount it and close a running session). The view reads it
// from context, so every render here mounts that provider; the `use-agent-chat`
// mock above is what the provider calls, exactly as the view used to.
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

const PROMPT = /Describe a task in plain English/i;

beforeEach(() => {
  vi.clearAllMocks();
  // A profile with no bound proxy → egress resolves to operator-default (settled,
  // not pending/blocked), so the stopped turn is the ONLY thing that can gate the
  // send.
  h.listBindings.mockResolvedValue([]);
  h.listProxies.mockResolvedValue([]);
});

async function renderComposer(stoppedTurnStillRunning: boolean) {
  h.useAgentChat.mockReturnValue(chatWith(stoppedTurnStillRunning));
  render(<AgentChatView initialProfileId="prof_x" />, { wrapper: AgentChatProvider });
  await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
  await new Promise((r) => setTimeout(r, 0));
  const composer = screen.getByPlaceholderText(PROMPT);
  fireEvent.change(composer, { target: { value: 'the next task' } });
  return composer;
}

describe('P6 — after Stop, the Enter key refuses too', () => {
  it('⛔ PRESSING ENTER DOES NOT SEND while the stopped turn is still running', async () => {
    const composer = await renderComposer(true);
    send.mockClear();
    fireEvent.keyDown(composer, { key: 'Enter' });
    // A disabled button does not cover this path. Removing the guard from
    // submit() leaves every button-level arm green and this one red.
    expect(send).not.toHaveBeenCalled();
  });

  it('the Send button is held for the same reason, and says so on screen', async () => {
    await renderComposer(true);
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    // The customer is looking at the composer when they decide what to type, so
    // the reason belongs there and not only in a hover title.
    expect(screen.getByText(/still finishing the previous task/i)).toBeInTheDocument();
  });

  it('and the customer KEEPS WHAT THEY TYPED — a held send is not a lost message', async () => {
    const composer = await renderComposer(true);
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(composer).toHaveValue('the next task');
  });

  it('⛔ THE VACUITY CONTROL: with no stopped turn, Enter sends exactly as before', async () => {
    const composer = await renderComposer(false);
    send.mockClear();
    // Checked BEFORE the keystroke: a successful send clears the draft, which
    // disables the button for the ordinary empty-composer reason and would make
    // this control pass for the wrong one.
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('the next task');
    expect(screen.queryByText(/still finishing the previous task/i)).toBeNull();
  });
});
