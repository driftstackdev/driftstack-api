// A customer on included AI usage picks Opus 5 and presses Send. The server
// refuses — Opus runs only on the customer's own Anthropic key — with a 403 that
// carries `requires_own_key: true` and the `model` it refused. The chat had no
// case for it, so the turn read "This turn stopped before it finished. The steps
// above are what ran." when nothing had run at all, and no banner said anything
// either: a refusal the customer could not understand, with no way forward.
//
// ⛔ The refusal is recognised by the TYPED extension. Every problem built here
// carries the meaningless detail "x", so an arm that passes cannot be reading
// the sentence — and a 403 whose wording SAYS "own key" but carries no extension
// must not be taken for it, because a 403 on this route is also "not your
// session" and "not in your plan".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DEFAULT_AGENT_MODEL } from '@driftstack/api-types';
import { ByokAnthropicRequiredError, ForbiddenError, InternalError } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
const get = vi.fn();

// ⛔ ONE client object, module-scoped: the chat treats a CHANGE of the client
// object as the auth boundary, so a fresh literal per render reads as a sign-out.
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
      yield { id: 'prof_x', name: 'Bank profile' };
    },
  },
};

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: CLIENT,
    settings: { apiKey: 'sk-test', baseUrl: 'https://api.example.test' },
  };
  return { useSettings: () => stable };
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
  loadChats: () => Promise.resolve([]),
  upsertChat: () => Promise.resolve([]),
  deleteChat: () => Promise.resolve([]),
  deriveChatTitle: () => 'Chat',
  chatTurnCount: (c: { turns: unknown[] }) => c.turns.length,
}));

const { interruptedTurnReason, ownKeyModelRefusal } = await import('../../src/lib/use-agent-chat');
const { AgentChatView } = await import('../../src/views/AgentChatView');
const { AgentChatProvider } = await import('../../src/lib/AgentChatProvider');

/** A typed RFC 7807 problem whose wording carries no information. */
function problem(status: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'https://errors.driftstack.dev/forbidden',
    title: 'x',
    status,
    detail: 'x',
    ...extra,
  } as never;
}

function ownKeyRefusal(model: unknown): ForbiddenError {
  return new ForbiddenError(problem(403, { requires_own_key: true, model }));
}

const NOTHING_RAN = /steps above/i;
const PROMPT = /Describe a task in plain English/i;

describe('the own-key refusal sentence', () => {
  it('names the refused model, says what works, and never claims steps ran', () => {
    const reason = interruptedTurnReason(ownKeyRefusal('claude-opus-5'));
    expect(reason).toBe(
      'Opus 5 runs only on your own Anthropic key. Add your key in the web dashboard at app.driftstack.io, then send the message again, or start a new chat with Sonnet 5.',
    );
    expect(reason).not.toMatch(NOTHING_RAN);
  });

  it('GUI audit #4 — both own-key sentences point to the web dashboard, never to Settings', () => {
    // The app's own browser sign-in key is refused the Anthropic-key save by
    // design, so "Add your key in Settings" sent the customer to a field that
    // could never save it.
    const missing = interruptedTurnReason(new ByokAnthropicRequiredError(problem(402)));
    const ownKeyOnly = interruptedTurnReason(ownKeyRefusal('claude-opus-5'));
    for (const reason of [missing, ownKeyOnly]) {
      expect(reason).not.toMatch(/Settings/);
      expect(reason).toMatch(/in the web dashboard at app\.driftstack\.io/);
    }
  });

  it('names whichever own-key-only model was refused, not a hard-coded one', () => {
    expect(interruptedTurnReason(ownKeyRefusal('claude-opus-4-8'))).toMatch(
      /^Opus 4\.8 runs only on your own Anthropic key\./,
    );
  });

  it('an id this build does not know still gets the own-key sentence, without a raw id', () => {
    // The server refuses UNPRICED models the same way, and those are exactly the
    // ids a picker built before them has no label for.
    const reason = interruptedTurnReason(ownKeyRefusal('claude-opus-9'));
    expect(reason).toMatch(/^The model this chat uses runs only on your own Anthropic key\./);
    expect(reason).not.toContain('claude-opus-9');
    expect(interruptedTurnReason(ownKeyRefusal(undefined))).toMatch(
      /^The model this chat uses runs only/,
    );
  });

  it('never suggests switching to the very model that was refused', () => {
    const reason = interruptedTurnReason(ownKeyRefusal(DEFAULT_AGENT_MODEL));
    expect(reason).toMatch(/runs only on your own Anthropic key/);
    expect(reason).not.toMatch(/new chat with/i);
  });

  it('CONTROL — a plain 403 still does not mention any key', () => {
    const plain = interruptedTurnReason(new ForbiddenError(problem(403)));
    expect(plain).not.toMatch(/API key/i);
    expect(plain).not.toMatch(/own .*key/i);
    expect(ownKeyModelRefusal(new ForbiddenError(problem(403)))).toBeNull();
  });

  it('CONTROL — wording that SAYS "own key" without the extension is not the refusal', () => {
    const worded = new ForbiddenError({
      type: 'https://errors.driftstack.dev/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'claude-opus-5 requires your own Anthropic key (requires_own_key)',
    });
    expect(ownKeyModelRefusal(worded)).toBeNull();
    expect(interruptedTurnReason(worded)).not.toMatch(/own Anthropic key/i);
    // Only a literal `true` counts: a string "true" is not the declared flag.
    expect(ownKeyModelRefusal(new ForbiddenError(problem(403, { requires_own_key: 'true' })))).toBe(
      null,
    );
    // And an untyped throw is never it.
    expect(ownKeyModelRefusal(new Error('requires_own_key'))).toBeNull();
    expect(ownKeyModelRefusal(new InternalError(problem(500)))).toBeNull();
  });
});

describe('the chat shows the own-key refusal where the customer is looking', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    close.mockReset();
    get.mockReset();
  });

  it('a refused first send renders the own-key sentence in the transcript, not "the steps above"', async () => {
    // The create-time refusal: the session never exists, so nothing ran.
    create.mockRejectedValue(ownKeyRefusal('claude-opus-5'));
    render(<AgentChatView initialProfileId="prof_x" />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    // Let the proxy resolution settle so Send is not held on it.
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.change(screen.getByPlaceholderText(PROMPT), {
      target: { value: 'find me a flight' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(
      await screen.findByText(/Opus 5 runs only on your own Anthropic key/),
    ).toBeInTheDocument();
    expect(screen.getByText(/start a new chat with Sonnet 5/)).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_RAN)).toBeNull();
    // The customer's own message stays on screen beside the explanation.
    expect(screen.getByText('find me a flight')).toBeInTheDocument();
    expect(message).not.toHaveBeenCalled();
  });

  it('a refusal on a later turn (a key that expired mid-chat) says the same', async () => {
    const session = {
      id: 'agt_1',
      account_id: 'acc_1',
      driftstack_session_id: null,
      status: 'active',
      closed_reason: null,
      stop_on_exit_ip_change: false,
      token_budget_total: 100_000,
      token_budget_remaining: 90_000,
      transcript_length: 0,
      closed_at: null,
      created_by_user_id: null,
      mode: 'ai',
      model: 'claude-opus-5',
      pair_mode_state: null,
      created_at: '2026-09-19T00:00:00Z',
      updated_at: '2026-09-19T00:00:01Z',
    };
    create.mockResolvedValue(session);
    // The view polls a live session's status for its badge.
    get.mockResolvedValue(session);
    message.mockRejectedValue(ownKeyRefusal('claude-opus-5'));
    render(<AgentChatView initialProfileId="prof_x" />, { wrapper: AgentChatProvider });
    await waitFor(() => expect(screen.getByPlaceholderText(PROMPT)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.change(screen.getByPlaceholderText(PROMPT), { target: { value: 'next step' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(
      await screen.findByText(/Opus 5 runs only on your own Anthropic key/),
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTHING_RAN)).toBeNull();
  });
});
