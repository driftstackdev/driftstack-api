// Save-as-recipe (AgentChatView) — the chat → reusable-flow loop. The SDK
// recipes.create had zero GUI callers until this feature; here we render the
// chat with a controllable useAgentChat, assert the button only enables once a
// turn actually executed a plan, then save and assert the SDK call + the
// success toast carry the session id and trimmed label.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';

const createRecipe = vi.fn(() => Promise.resolve({ id: 'rec_1', label: 'My flow' }));
const pushToast = vi.fn();

const client = {
  recipes: { create: (body: unknown) => createRecipe(body) },
  // AgentChatView loads profiles in a mount effect; yield nothing. A plain
  // generator satisfies the `for await…of` consumer without a needless async.
  profiles: {
    iterate: function* () {
      // no profiles in this harness
    },
  },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client }),
}));
vi.mock('../../src/lib/toasts', () => ({
  useToasts: () => ({ push: pushToast }),
}));

// Controllable chat: tests swap `chatState` before each render.
let chatState: UseAgentChatResult;
vi.mock('../../src/lib/use-agent-chat', () => ({
  useAgentChat: () => chatState,
}));

const { AgentChatView } = await import('../../src/views/AgentChatView');

const SESSION: AgentSession = {
  id: 'agt_42',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-opus-4-7',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

const PLAN_EXECUTED: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [{ kind: 'navigate', url: 'https://example.com' }],
  results: [
    { kind: 'success', intent: { kind: 'navigate', url: 'https://example.com' }, summary: 'ok' },
  ],
  ok: true,
};

function baseChat(overrides: Partial<UseAgentChatResult> = {}): UseAgentChatResult {
  return {
    turns: [],
    session: null,
    sending: false,
    error: null,
    pendingConfirmation: null,
    send: vi.fn(() => Promise.resolve()),
    approve: vi.fn(() => Promise.resolve()),
    deny: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

describe('AgentChatView Save-as-recipe', () => {
  beforeEach(() => {
    createRecipe.mockClear();
    pushToast.mockClear();
  });

  it('disables Save-as-recipe until a plan has actually executed', () => {
    // A clarify-only turn contributes no intents → still disabled.
    const clarifyTurn: ChatTurn = {
      id: 2,
      role: 'agent',
      response: { kind: 'clarify', session: SESSION, clarifying_question: 'which site?' },
    };
    chatState = baseChat({
      session: SESSION,
      turns: [{ id: 1, role: 'user', text: 'do a thing' }, clarifyTurn],
    });
    render(<AgentChatView />);
    const btn = screen.getByRole('button', { name: 'Save as recipe' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the chat as a recipe with the session id + trimmed label, then toasts', async () => {
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({
      session: SESSION,
      turns: [{ id: 1, role: 'user', text: 'open example.com' }, planTurn],
    });
    render(<AgentChatView />);

    const open = screen.getByRole('button', { name: 'Save as recipe' });
    expect((open as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(open);

    const name = await screen.findByPlaceholderText('e.g. Add 3 items to cart');
    fireEvent.change(name, { target: { value: '  Open example  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));

    await waitFor(() => expect(createRecipe).toHaveBeenCalledTimes(1));
    expect(createRecipe).toHaveBeenCalledWith({
      agent_session_id: 'agt_42',
      label: 'Open example',
    });
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Recipe saved' })),
    );
  });

  it('surfaces an error and does not toast when the create fails', async () => {
    createRecipe.mockRejectedValueOnce(new Error('quota exceeded'));
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({ session: SESSION, turns: [planTurn] });
    render(<AgentChatView />);

    fireEvent.click(screen.getByRole('button', { name: 'Save as recipe' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Add 3 items to cart'), {
      target: { value: 'Flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));

    expect(await screen.findByText('quota exceeded')).toBeTruthy();
    expect(pushToast).not.toHaveBeenCalled();
  });
});
