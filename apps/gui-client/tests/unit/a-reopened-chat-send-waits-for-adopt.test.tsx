// N5 — reopening a saved chat fires a background adopt() that reattaches to the
// chat's still-live server session. If a send fires BEFORE adopt settles, it takes
// the no-live-session path and creates a NEW session "continuing from" the still-
// active id, which the server rejects with a 409 surfaced to the customer as
// "The item changed or is busy. Refresh and try again." (api-errors.ts, HTTP 409).
//
// The fix gates the send — both the Send button's `disabled` and submit()'s own
// guard (the Enter-to-send path) — on `chat.adopting`, so the reattach resolves
// first: an active session is adopted (the send then messages it, no continue-from)
// and a closed one is continued cleanly. These arms pin both halves of that gate.
//
// Mirrors agent-chat-egress-proxy.test.tsx's render harness, but with a COMPLETE
// UseAgentChatResult so it does not add to the tsconfig.test.json backlog.

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
function chatWith(adopting: boolean): UseAgentChatResult {
  return {
    turns: [],
    session: null,
    sending: false,
    liveSteps: [],
    error: null,
    pendingConfirmation: null,
    deniedTurnIds: new Set<number>(),
    approvedTurnIds: new Set<number>(),
    send,
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    cancel: vi.fn(),
    restore: vi.fn(),
    adopt: vi.fn(),
    adopting,
    restoredHistoryCount: 0,
    restoredSessionId: null,
  };
}

vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: h.useAgentChat }));

const { AgentChatView } = await import('../../src/views/AgentChatView');

const PROMPT = /Describe a task in plain English/i;

beforeEach(() => {
  vi.clearAllMocks();
  // A profile with no bound proxy → egress resolves to operator-default (settled,
  // not pending/blocked), so `adopting` is the ONLY thing that can gate the send.
  h.listBindings.mockResolvedValue([]);
  h.listProxies.mockResolvedValue([]);
});

describe('N5 — a reopened chat holds the send until adopt() settles', () => {
  it('disables Send AND drops the Enter-to-send path while adopting', async () => {
    h.useAgentChat.mockReturnValue(chatWith(true));
    render(<AgentChatView initialProfileId="prof_x" />);
    // Let the proxy resolution settle so the only remaining gate is `adopting`.
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'reopen and go' } });

    const sendBtn = screen.getByRole('button', { name: /^send$/i });
    // The button gate. Reverting `chat.adopting` from the disabled list re-enables it.
    expect(sendBtn).toBeDisabled();

    // The Enter path is a SEPARATE guard in submit() — a disabled button does not
    // cover it, so a mutation dropping `chat.adopting` from submit() stays green
    // without this arm.
    send.mockClear();
    fireEvent.keyDown(screen.getByPlaceholderText(PROMPT), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
  });

  it('enables Send once adopt has settled (the gate is adopting, not a permanent block)', async () => {
    // The vacuity control: with adopting=false and everything else valid, Send MUST
    // be enabled — otherwise the disabled arm above would pass even if Send were
    // wired off entirely.
    h.useAgentChat.mockReturnValue(chatWith(false));
    render(<AgentChatView initialProfileId="prof_x" />);
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'reopen and go' } });
    expect(screen.getByRole('button', { name: /^send$/i })).not.toBeDisabled();
  });
});
