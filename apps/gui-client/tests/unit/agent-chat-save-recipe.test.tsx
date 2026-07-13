// Save-as-recipe (AgentChatView) — the chat → reusable-flow loop. The SDK
// recipes.create had zero GUI callers until this feature; here we render the
// chat with a controllable useAgentChat, assert the button only enables once a
// turn actually executed a plan, then save and assert the SDK call + the
// success toast carry the session id and trimmed label.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type { ChatTurn, UseAgentChatResult } from '../../src/lib/use-agent-chat';
import { ConfirmProvider } from '../../src/components/ConfirmProvider';

const createRecipe = vi.fn(() => Promise.resolve({ id: 'rec_1', label: 'My flow' }));
const pushToast = vi.fn();
// LiveAutomationPanel fetches the per-session LiveKit token via this method. The
// live-view tests below swap its implementation per case (503, success, count).
const livekitToken = vi.fn(() => Promise.resolve({ ws_url: '', room: '', token: '' }));

const client = {
  recipes: { create: (body: unknown) => createRecipe(body) },
  agentSessions: { livekitToken: (id: string) => livekitToken(id) },
  // AgentChatView loads profiles in a mount effect; yield nothing. A plain
  // generator satisfies the `for await…of` consumer without a needless async.
  profiles: {
    iterate: function* () {
      // no profiles in this harness
    },
  },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client, settings: { apiKey: 'sk-test' } }),
}));
// Stub the live-stream panel: the retry-success path renders it, and the real
// one opens a LiveKit connection on mount (no transport in jsdom). A marker div
// is enough to assert the panel mounted.
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
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
    deniedTurnIds: new Set<number>(),
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
    const btn = screen.getByRole('button', { name: 'Save as task' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Escape closes the save dialog (a11y)', () => {
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({
      session: SESSION,
      turns: [{ id: 1, role: 'user', text: 'open example.com' }, planTurn],
    });
    render(<AgentChatView />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as task' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('guards a typed draft across backdrop, Escape, and Cancel, then clears it after discard', async () => {
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({
      session: SESSION,
      turns: [{ id: 1, role: 'user', text: 'open example.com' }, planTurn],
    });
    render(
      <ConfirmProvider>
        <AgentChatView />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save as task' }));
    const saveDialog = await screen.findByRole('dialog', { name: 'Save chat as task' });
    const name = within(saveDialog).getByPlaceholderText('e.g. Add 3 items to cart');
    fireEvent.change(name, { target: { value: 'half-typed name' } });

    // An easy-to-miss backdrop click asks instead of erasing the draft.
    fireEvent.click(saveDialog.parentElement!);
    let discardDialog = await screen.findByRole('dialog', {
      name: 'Discard this unsaved task draft?',
    });
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Cancel' }));
    expect((name as HTMLInputElement).value).toBe('half-typed name');
    await waitFor(() => expect(name).toHaveFocus());

    // Escape follows the same path; cancelling the confirmation keeps the text.
    fireEvent.keyDown(window, { key: 'Escape' });
    discardDialog = await screen.findByRole('dialog', {
      name: 'Discard this unsaved task draft?',
    });
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Cancel' }));
    expect((name as HTMLInputElement).value).toBe('half-typed name');
    await waitFor(() => expect(name).toHaveFocus());

    // Explicit Cancel is guarded too. Confirming is the one path that clears.
    fireEvent.click(within(saveDialog).getByRole('button', { name: 'Cancel' }));
    discardDialog = await screen.findByRole('dialog', {
      name: 'Discard this unsaved task draft?',
    });
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Save chat as task' })).toBeNull(),
    );

    // Reopen — the confirmed-discard draft is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Save as task' }));
    const reopened: HTMLInputElement = await screen.findByPlaceholderText(
      'e.g. Add 3 items to cart',
    );
    expect(reopened.value).toBe('');
  });

  it('saves the chat as a recipe with the session id + trimmed label, then toasts', async () => {
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({
      session: SESSION,
      turns: [{ id: 1, role: 'user', text: 'open example.com' }, planTurn],
    });
    render(<AgentChatView />);

    const open = screen.getByRole('button', { name: 'Save as task' });
    expect((open as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(open);

    const name = await screen.findByPlaceholderText('e.g. Add 3 items to cart');
    fireEvent.change(name, { target: { value: '  Open example  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() => expect(createRecipe).toHaveBeenCalledTimes(1));
    expect(createRecipe).toHaveBeenCalledWith({
      agent_session_id: 'agt_42',
      label: 'Open example',
    });
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Task saved' })),
    );
  });

  it('surfaces an error and does not toast when the create fails', async () => {
    createRecipe.mockRejectedValueOnce(new Error('quota exceeded'));
    const planTurn: ChatTurn = { id: 2, role: 'agent', response: PLAN_EXECUTED };
    chatState = baseChat({ session: SESSION, turns: [planTurn] });
    render(<AgentChatView />);

    fireEvent.click(screen.getByRole('button', { name: 'Save as task' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Add 3 items to cart'), {
      target: { value: 'Flow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));

    expect(await screen.findByText('quota exceeded')).toBeTruthy();
    expect(pushToast).not.toHaveBeenCalled();
  });
});

describe('AgentChatView live-view toggle (narrow widths)', () => {
  it('a "Live view" toggle reveals the live pane as an overlay (it is not silently dropped below lg)', () => {
    chatState = baseChat({ session: SESSION, turns: [] });
    const { container } = render(<AgentChatView />);
    const pane = container.querySelector('[data-component="ai-automation-live-pane"]');
    // Closed initially → the pane carries the `hidden` class (no overlay).
    expect(pane?.className).toContain('hidden');
    // Toggle it open.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle live view' }));
    // Now it's a fixed slide-over (not hidden) with a Close affordance.
    expect(pane?.className).toContain('fixed');
    expect(pane?.className).not.toContain('hidden');
    expect(screen.getByRole('button', { name: 'Close live view' })).toBeTruthy();
    // The toggle label flips to Hide.
    expect(screen.getByRole('button', { name: 'Toggle live view' })).toHaveTextContent('Hide live');
  });
});

describe('AgentChatView live-view token-fetch failure (friendly copy + Retry)', () => {
  beforeEach(() => {
    livekitToken.mockReset();
    // Default to a resolving stub; cases that need a failure override it.
    livekitToken.mockResolvedValue({ ws_url: '', room: '', token: '' });
  });

  /** A 503 from livekitToken, carrying a numeric `.status` exactly like the SDK
   *  DriftstackError does. Reject with a real Error (not a bare object) so the
   *  promise-rejection lint stays happy; the status field is declared on a typed
   *  local so the assignment isn't an unsafe `any` member access. */
  function reject503(): void {
    const err: Error & { status: number } = Object.assign(
      new Error('HTTP 503: Service Unavailable'),
      { status: 503 },
    );
    livekitToken.mockRejectedValueOnce(err);
  }

  it('finding #2 — a 503/DriverNotIntegrated shows the calm "simulated" steady-state with NO Retry (a Retry would 503 forever)', async () => {
    reject503();
    chatState = baseChat({ session: SESSION, turns: [] });
    render(<AgentChatView />);

    // The simulated-deployment copy mirrors the chat banner — honest "not available
    // yet", not an alarming failure — and never leaks the raw "HTTP 503" jargon.
    expect(await screen.findByText('Live view not available yet')).toBeTruthy();
    expect(
      screen.getByText(
        'Browser actions are simulated in this deployment — the live device view turns on when the live driver is enabled.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/HTTP 503/)).toBeNull();
    // The dead-end Retry loop is GONE: a 503 never recovers here, so no Retry button.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('maps a network/transport failure to a connection message (raw text not surfaced) — and keeps a Retry', async () => {
    livekitToken.mockRejectedValueOnce(new Error('fetch failed'));
    chatState = baseChat({ session: SESSION, turns: [] });
    render(<AgentChatView />);

    expect(
      await screen.findByText(
        "Couldn't reach the live-stream server — check your connection, then retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/fetch failed/)).toBeNull();
    // A genuine transport blip IS recoverable in place — keep the Retry affordance.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Retry re-runs the token fetch on a transient network failure — recovering in place', async () => {
    // First attempt is a TRANSIENT network failure (Retry-able); the retry resolves.
    livekitToken.mockRejectedValueOnce(new Error('fetch failed'));
    chatState = baseChat({ session: SESSION, turns: [] });
    render(<AgentChatView />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(livekitToken).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    // Bumping retryNonce re-runs the effect → a second fetch attempt.
    await waitFor(() => expect(livekitToken).toHaveBeenCalledTimes(2));
  });
});

describe('AgentChatView Model/Profile select locking', () => {
  it('disables Model + Profile during the FIRST send (sending:true, turns empty) so they cannot desync the session', () => {
    // started is false (turns.length===0) during the first send; without the
    // `|| chat.sending` guard the selects stayed enabled and a post-Send change
    // created the session with the OLD model/profile while the header showed the
    // new one.
    chatState = baseChat({ session: null, sending: true, turns: [] });
    render(<AgentChatView />);
    expect(screen.getByLabelText<HTMLSelectElement>('Model').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Profile').disabled).toBe(true);
  });

  it('leaves Model + Profile enabled before any send (idle, nothing in flight)', () => {
    chatState = baseChat({ session: null, sending: false, turns: [] });
    render(<AgentChatView />);
    expect(screen.getByLabelText<HTMLSelectElement>('Model').disabled).toBe(false);
    expect(screen.getByLabelText<HTMLSelectElement>('Profile').disabled).toBe(false);
  });
});
