// Egress-leak fix (HIGH) — AgentChatView must resolve the SELECTED profile's bound
// proxy to a server proxy_id (the SAME way ProfilesView's manual launch does) and
// thread it to useAgentChat, so an AI session on a proxied profile exits through the
// configured residential proxy instead of silently leaking the operator/datacenter
// IP. This test drives the real resolution path (local proxy + binding stores +
// account-proxies sync) and asserts the proxyId opt the view hands to the hook.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import type { UseAgentChatResult } from '../../src/lib/use-agent-chat';

// Hoisted spies — vitest hoists vi.mock factories above the file, so anything they
// reference (and especially WRITE to) must be created via vi.hoisted, not a plain
// top-level let (a plain assignment inside a hoisted factory deadlocks collection).
const h = vi.hoisted(() => ({
  listProxies: vi.fn<() => Promise<unknown[]>>(),
  setProxyServerId: vi.fn<(id: string, serverId: string) => Promise<unknown>>(() =>
    Promise.resolve(null),
  ),
  listBindings: vi.fn<() => Promise<unknown[]>>(),
  createAccountProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  updateAccountProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  // captures the opts AgentChatView hands to useAgentChat across renders
  useAgentChat: vi.fn<(opts: { profileId?: string; proxyId?: string }) => UseAgentChatResult>(),
}));

// Local stores (Tauri-backed in prod): proxies + their profile bindings live here,
// not on the server. The view reads them to pick + sync the profile's exit.
vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: h.listProxies,
  setProxyServerId: h.setProxyServerId,
}));
vi.mock('../../src/lib/profile-bindings', () => ({ listBindings: h.listBindings }));
// Account-proxies transport: ensureServerProxyId creates/refreshes the encrypted
// account_proxies row and returns its id (the proxy_id passed at launch).
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: h.createAccountProxy,
  updateProxy: h.updateAccountProxy,
}));

// A STABLE client/settings (built once) — the mock MUST return the SAME object
// references every render, or AgentChatView's [client]-keyed effects (profile load
// etc.) re-run on every render and storm into an infinite render loop (a fresh
// object literal per useSettings() call hangs the test).
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

const chatState: UseAgentChatResult = {
  turns: [],
  session: null,
  sending: false,
  error: null,
  pendingConfirmation: null,
  deniedTurnIds: new Set<number>(),
  restoredHistoryCount: 0,
  send: vi.fn(() => Promise.resolve(true)),
  approve: vi.fn(() => Promise.resolve()),
  deny: vi.fn(),
  reset: vi.fn(),
  restore: vi.fn(),
  cancel: vi.fn(),
};
vi.mock('../../src/lib/use-agent-chat', () => ({ useAgentChat: h.useAgentChat }));

const { AgentChatView } = await import('../../src/views/AgentChatView');

/** The opts of the latest useAgentChat render — the proxyId resolves async, so the
 *  LAST call carries the resolved id. */
function lastOpts(): { profileId?: string; proxyId?: string } | undefined {
  const calls = h.useAgentChat.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1]?.[0] : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.useAgentChat.mockReturnValue(chatState);
  h.setProxyServerId.mockResolvedValue(null);
});

describe('AgentChatView egress — resolve the profile proxy → proxyId opt', () => {
  it("syncs the profile's bound local proxy to an account proxy_id and threads it to the hook", async () => {
    // The profile is explicitly bound to a local residential proxy.
    h.listBindings.mockResolvedValue([{ profileId: 'prof_x', defaultProxyId: 'lpx_1' }]);
    h.listProxies.mockResolvedValue([
      { id: 'lpx_1', label: 'Res US', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
    ]);
    // First launch → no cached serverId → create the encrypted account row.
    h.createAccountProxy.mockResolvedValue({ id: 'apx_server_1' });

    render(<AgentChatView initialProfileId="prof_x" />);

    // The view resolves the proxy and re-renders the hook with proxyId set.
    await waitFor(() => expect(lastOpts()?.proxyId).toBe('apx_server_1'));
    expect(lastOpts()?.profileId).toBe('prof_x');
    // The encrypted account row was created from the local proxy's host/port/creds.
    expect(h.createAccountProxy).toHaveBeenCalledTimes(1);
    expect(h.createAccountProxy.mock.calls[0]?.[2]).toMatchObject({ host: '1.2.3.4', port: 1080 });
    // …and the server id was cached back onto the local proxy for next time.
    expect(h.setProxyServerId).toHaveBeenCalledWith('lpx_1', 'apx_server_1');
  });

  it('refreshes (PUT) an already-synced proxy instead of re-creating it', async () => {
    h.listBindings.mockResolvedValue([{ profileId: 'prof_x', defaultProxyId: 'lpx_1' }]);
    h.listProxies.mockResolvedValue([
      {
        id: 'lpx_1',
        label: 'Res US',
        host: '1.2.3.4',
        port: 1080,
        username: 'u',
        password: 'p',
        serverId: 'apx_existing',
      },
    ]);
    h.updateAccountProxy.mockResolvedValue({ id: 'apx_existing' });

    render(<AgentChatView initialProfileId="prof_x" />);

    await waitFor(() => expect(lastOpts()?.proxyId).toBe('apx_existing'));
    expect(h.updateAccountProxy).toHaveBeenCalledTimes(1);
    expect(h.createAccountProxy).not.toHaveBeenCalled();
  });

  it('leaves proxyId undefined when the profile has NO bound proxy (operator-default egress, unchanged)', async () => {
    h.listBindings.mockResolvedValue([]);
    h.listProxies.mockResolvedValue([]);

    render(<AgentChatView initialProfileId="prof_x" />);

    await waitFor(() => expect(lastOpts()?.profileId).toBe('prof_x'));
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOpts()?.proxyId).toBeUndefined();
    expect(h.createAccountProxy).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED: a proxy-sync failure blocks the send instead of launching unproxied', async () => {
    h.listBindings.mockResolvedValue([{ profileId: 'prof_x', defaultProxyId: 'lpx_1' }]);
    h.listProxies.mockResolvedValue([
      { id: 'lpx_1', label: 'Res US', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
    ]);
    // The account-proxy create fails (offline / SSRF-rejected host / unauth).
    h.createAccountProxy.mockRejectedValue(new Error('SSRF: private host rejected'));

    render(<AgentChatView initialProfileId="prof_x" />);

    await waitFor(() => expect(lastOpts()?.profileId).toBe('prof_x'));
    await new Promise((r) => setTimeout(r, 0));
    expect(lastOpts()?.proxyId).toBeUndefined();

    // The assertion that actually matters. Asserting only "proxyId is undefined"
    // passes whether the chat is blocked OR silently launched unproxied, which
    // is why this leak survived a green suite: the server reads an absent
    // proxy_id as operator-default egress, so proceeding here would exit on
    // Driftstack's IP instead of the customer's proxy. ProfilesView.handleLaunch
    // aborts in exactly this case; this view must too.
    const send = chatState.send as unknown as ReturnType<typeof vi.fn>;
    send.mockClear();
    fireEvent.change(screen.getByPlaceholderText(/Describe a task in plain English/i), {
      target: { value: 'go to example.com' },
    });
    const sendBtn = screen.getByRole('button', { name: /^send$/i });
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(send).not.toHaveBeenCalled();

    // Enter-to-send bypasses the button entirely, so the disabled attribute is
    // not the guard here — submit()'s own egress check is. Without this case a
    // mutation deleting that check stays green, because a disabled button
    // swallows the click path on its own.
    fireEvent.keyDown(screen.getByPlaceholderText(/Describe a task in plain English/i), {
      key: 'Enter',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the explicitly-bound proxy was deleted — no reroute AND no unproxied launch', async () => {
    // Binding points at a proxy that no longer exists in the local store.
    h.listBindings.mockResolvedValue([{ profileId: 'prof_x', defaultProxyId: 'lpx_deleted' }]);
    h.listProxies.mockResolvedValue([
      {
        id: 'lpx_other',
        label: 'Other',
        host: '9.9.9.9',
        port: 1080,
        username: null,
        password: null,
      },
    ]);

    render(<AgentChatView initialProfileId="prof_x" />);

    await waitFor(() => expect(lastOpts()?.profileId).toBe('prof_x'));
    await new Promise((r) => setTimeout(r, 0));
    // Not rerouting to proxies[0] was only half of it: the customer explicitly
    // chose an exit for this profile, so launching on the operator default
    // instead leaks their real IP under a setting they believe is active.
    expect(lastOpts()?.proxyId).toBeUndefined();
    expect(h.createAccountProxy).not.toHaveBeenCalled();

    const send = chatState.send as unknown as ReturnType<typeof vi.fn>;
    send.mockClear();
    fireEvent.change(screen.getByPlaceholderText(/Describe a task in plain English/i), {
      target: { value: 'go to example.com' },
    });
    const sendBtn = screen.getByRole('button', { name: /^send$/i });
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(send).not.toHaveBeenCalled();
  });
});
