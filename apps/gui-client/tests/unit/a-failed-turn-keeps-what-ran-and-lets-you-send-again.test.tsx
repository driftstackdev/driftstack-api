// Two failures the customer met as one: after ANY error, pressing Send again
// replayed the identical error forever, and the screen had already thrown away
// the evidence of what actually happened.
//
// B4 — the idempotency receipt was minted per logical turn and cleared ONLY on
// success. A typed terminal (a 402 consent prompt, a 409, a 500) left it set, so
// the next Send reused the same key and the server replayed its stored terminal
// failure. The worst case was the obvious one: the customer clicks "Enable AI
// features", fixes the actual cause, presses Send, and is told again that AI
// features are not enabled.
//
// B6 — the catch cleared `liveSteps` and rolled the user's own message back off
// the screen. Steps that had really dispatched (and been billed) vanished, and
// every typed problem collapsed into one sentence — "The item changed or is
// busy" — that named neither the cause nor the fix.
//
// ⛔ Both decisions are made on the problem TYPE. A prose-matching version of
// either would pass the same happy-path assertions and break the first time the
// server reworded a message, so the arms here use typed problems whose wording
// carries no signal at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
  ConflictError,
  ForbiddenError,
  InternalError,
  InvalidKeyError,
  TransportError,
  type AgentMessageResponse,
  type AgentSession,
} from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();

// ⛔ ONE client object, module-scoped. `useSettings` memoises the SDK client on
// [apiKey, baseUrl, workspace], and the chat now treats a CHANGE of that object
// as the auth boundary — it is what tells sign-out (and a re-sign-in under a
// different key) apart from an ordinary re-render. A mock that built a fresh
// literal per call reported a sign-out on every render.
const CLIENT = { agentSessions: { create, message, close } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: CLIENT }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
}));

const { useAgentChat, turnReceiptIsSpent, interruptedTurnReason, phaseCaption } =
  await import('../../src/lib/use-agent-chat');

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  stop_on_exit_ip_change: false,
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

const NAV = { kind: 'navigate', url: 'https://example.com' } as const;
const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [NAV],
  results: [{ kind: 'success', intent: NAV, summary: 'ok' }],
  ok: true,
};

/** A typed RFC 7807 problem with wording that carries no information, so an
 *  arm that passes here cannot be reading the sentence. */
function problem(type: string, status: number, extra: Record<string, unknown> = {}) {
  return { type, title: 'x', status, detail: 'x', ...extra } as never;
}

function receiptKeys(): string[] {
  return message.mock.calls.map((c) => (c[2] as { idempotencyKey: string }).idempotencyKey);
}

describe('B4 — a typed terminal spends the receipt; a dropped connection does not', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it.each([
    ['a 402 consent prompt', new BundledLlmConsentRequiredError(problem('x', 402))],
    ['a 409 busy conflict', new ConflictError(problem('x', 409))],
    [
      'a 409 idempotency mismatch',
      new ConflictError(problem('x', 409, { idempotency_status: 'mismatch' })),
    ],
    [
      // ⛔ A 502 BY STATUS, and still "nothing ran": the route raises it while
      // resolving the credential, before the planner exists. It is also the
      // single Send this whole fix is about — the one right after the customer
      // adds the key they were just told was missing.
      'the no-Anthropic-key refusal, which is a 502',
      new ByokAnthropicRequiredError(problem('x', 502)),
    ],
  ])('%s lets the SAME message be sent again under a NEW key', async (_label, err) => {
    message.mockRejectedValueOnce(err).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('go to example.com');
    });
    await act(async () => {
      await result.current.send('go to example.com');
    });

    expect(message).toHaveBeenCalledTimes(2);
    const keys = receiptKeys();
    expect(keys[0]).toBeTruthy();
    // The heart of the bug: identical turns, and the second MUST NOT reuse the
    // key whose terminal the server has already stored.
    expect(keys[1]).not.toBe(keys[0]);
    expect(result.current.turns.at(-1)?.response).toEqual(DONE);
  });

  it('a dropped stream keeps the key, so the retry is still the SAME turn', async () => {
    // The opposite case, and the reason this cannot simply clear on every error:
    // a transport failure says nothing about whether the server ran the turn, so
    // repeating it under a new key could re-dispatch — and re-bill — real
    // browser work.
    message.mockRejectedValueOnce(new TransportError('Load failed', 0)).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('go to example.com');
    });
    await act(async () => {
      await result.current.send('go to example.com');
    });

    const keys = receiptKeys();
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ['a 500, whose outcome the server itself calls unknown', new InternalError(problem('x', 500))],
    [
      'a 409 that carries partial results — proof the plan was running',
      new ConflictError(
        problem('x', 409, {
          partial_results: [{ kind: 'success', intent: NAV, summary: 'tapped Buy now' }],
          ai_control_unavailable: true,
        }),
      ),
    ],
    [
      'a closed-session 409 that settled real spend',
      new ConflictError(problem('x', 409, { session_status: 'closed', tokens_consumed: 412 })),
    ],
  ])('%s KEEPS the key, so a re-send replays instead of re-running the plan', async (_l, err) => {
    // ⛔ The reason the receipt exists at all. The route stores a terminal for
    // every typed failure precisely so "retrying must replay the same terminal
    // problem rather than guessing that the action is safe to repeat". A fresh
    // key discards that and re-dispatches the whole plan — including the tap the
    // interrupted turn is showing the customer as already done.
    message.mockRejectedValueOnce(err).mockRejectedValueOnce(err);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to the shop and buy the thing');
    });
    await act(async () => {
      await result.current.send('go to the shop and buy the thing');
    });
    const keys = receiptKeys();
    expect(keys[1]).toBe(keys[0]);
  });

  it('a 409 that says the original is STILL RUNNING keeps the key', async () => {
    // `in_progress` is the server saying it has not settled this key yet.
    // Minting a new one would start a second turn beside the live one.
    message
      .mockRejectedValueOnce(
        new ConflictError(problem('x', 409, { idempotency_status: 'in_progress' })),
      )
      .mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to example.com');
    });
    await act(async () => {
      await result.current.send('go to example.com');
    });
    const keys = receiptKeys();
    expect(keys[1]).toBe(keys[0]);
  });

  it('decides on the problem type, not on its prose', () => {
    // Identical wording, opposite verdicts — a prose matcher cannot pass this.
    expect(turnReceiptIsSpent(new ConflictError(problem('x', 409)))).toBe(true);
    expect(turnReceiptIsSpent(new TransportError('x', 409))).toBe(false);
    expect(turnReceiptIsSpent(new Error('conflict'))).toBe(false);
    // Same status, same wording, opposite verdicts — the declared extension is
    // the only thing separating "nothing ran" from "part of it did".
    expect(
      turnReceiptIsSpent(new ConflictError(problem('x', 409, { usage: { total_tokens: 12 } }))),
    ).toBe(false);
    expect(turnReceiptIsSpent(new InternalError(problem('x', 500)))).toBe(false);
  });
});

describe('B6 — an interrupted turn keeps the message and the steps that ran', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('keeps the user bubble and shows the steps the server says already ran', async () => {
    const partial = [{ kind: 'success', intent: NAV, summary: 'opened example.com' }];
    message.mockRejectedValueOnce(
      new ConflictError(problem('x', 409, { partial_results: partial, session_status: 'closed' })),
    );
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to example.com and buy the thing');
    });

    const user = result.current.turns.filter((t) => t.role === 'user');
    expect(user).toHaveLength(1);
    expect(user[0]?.text).toBe('go to example.com and buy the thing');

    const agent = result.current.turns.filter((t) => t.role === 'agent');
    expect(agent).toHaveLength(1);
    expect(agent[0]?.interrupted?.steps).toEqual(partial);
    // A closed session is named as such, with the one action that helps.
    expect(agent[0]?.interrupted?.reason).toMatch(/session ended/i);
    expect(agent[0]?.interrupted?.reason).toMatch(/new session/i);
    // The caller is told not to restore the draft, or the message shows twice.
    expect(result.current.lastSendKeptMessage()).toBe(true);
  });

  it('falls back to the steps IT streamed when the problem carries none', async () => {
    const streamed = { kind: 'success', intent: NAV, summary: 'opened example.com' };
    message.mockImplementationOnce(
      (_id: string, _msg: string, opts: { onStep: (s: unknown) => void }) => {
        opts.onStep({ index: 0, result: streamed });
        return Promise.reject(new InternalError(problem('x', 500)));
      },
    );
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to example.com');
    });
    const agent = result.current.turns.filter((t) => t.role === 'agent');
    expect(agent[0]?.interrupted?.steps).toEqual([streamed]);
    // The transient live list is handed off, not left duplicating the turn.
    expect(result.current.liveSteps).toEqual([]);
  });

  it('gives each typed problem its own sentence instead of one collapsed message', () => {
    const sentences = [
      interruptedTurnReason(new ConflictError(problem('x', 409, { session_status: 'closed' }))),
      interruptedTurnReason(new ConflictError(problem('x', 409, { session_status: 'paused' }))),
      interruptedTurnReason(new ConflictError(problem('x', 409, { turn_in_progress: true }))),
      interruptedTurnReason(new ConflictError(problem('x', 409, { ai_control_unavailable: true }))),
      interruptedTurnReason(new BundledLlmConsentRequiredError(problem('x', 402))),
      interruptedTurnReason(new TransportError('x', 0)),
      interruptedTurnReason(new InternalError(problem('x', 500))),
    ];
    // Distinct, and none of them is the old catch-all.
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const s of sentences) expect(s).not.toMatch(/changed or is busy/i);
  });

  it('tells a PAUSED session to resume and a CLOSED one to start again — never the reverse', () => {
    // ⛔ The server says opposite things for these two ("Resume this agent
    // session" vs "Start a new agent session") and publishes the typed status so
    // a client can tell them apart. Folding them together sends the owner of a
    // live, resumable, still-billable session off to abandon it.
    const paused = interruptedTurnReason(
      new ConflictError(problem('x', 409, { session_status: 'paused' })),
    );
    expect(paused).toMatch(/resume/i);
    expect(paused).not.toMatch(/new session/i);

    const closed = interruptedTurnReason(
      new ConflictError(problem('x', 409, { session_status: 'closed' })),
    );
    expect(closed).toMatch(/new session/i);
    expect(closed).not.toMatch(/resume/i);
  });

  it('does not tell the customer their API key was rejected for a plain 403', () => {
    // A 403 on this route is also "you do not own this session" and "your plan
    // does not include this". Sending that customer to replace a key that works
    // is a wrong instruction, not merely a vague one — so only the TYPED key
    // problems get the key sentence.
    expect(interruptedTurnReason(new ForbiddenError(problem('x', 403)))).not.toMatch(/API key/i);
    expect(interruptedTurnReason(new InvalidKeyError(problem('x', 401)))).toMatch(
      /Driftstack API key was rejected/i,
    );
  });

  it('shows ONE explanation, not an interrupted turn contradicted by a banner', async () => {
    // Before: the turn said "Continue in a new session" while the banner beside
    // it said "The item changed or is busy. Refresh and try again." — two
    // different instructions for one failure, on one screen.
    message.mockRejectedValueOnce(
      new ConflictError(problem('x', 409, { session_status: 'closed' })),
    );
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to example.com');
    });
    expect(result.current.turns.at(-1)?.interrupted?.reason).toMatch(/new session/i);
    expect(result.current.error).toBeNull();
  });

  it('keeps the bundled-LLM banner, because that one is a BUTTON and not a sentence', async () => {
    // The negative control for the arm above: suppressing every banner would
    // also remove the only in-app way to enable AI features or raise the limit.
    message.mockRejectedValueOnce(new BundledLlmConsentRequiredError(problem('x', 402)));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      await result.current.send('go to example.com');
    });
    expect(result.current.error?.kind).toBe('bundled_llm_consent');
  });

  it('a soft Stop still removes the bubble — the keep is for real failures only', async () => {
    let settle: (r: AgentMessageResponse) => void = () => undefined;
    message.mockImplementationOnce(
      () =>
        new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        }),
    );
    const { result } = renderHook(() => useAgentChat());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.send('go to example.com');
      await Promise.resolve();
    });
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      settle(DONE);
      await pending;
    });
    expect(result.current.turns).toHaveLength(0);
    expect(result.current.lastSendKeptMessage()).toBe(false);
  });
});

describe('B2 — the hook reads the additive progress frames and ignores the rest', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('surfaces the phase, the plan and the running step, then clears them on settle', async () => {
    let emit: (e: { type: string; data: unknown }) => void = () => undefined;
    let settle: (r: AgentMessageResponse) => void = () => undefined;
    message.mockImplementationOnce(
      (
        _id: string,
        _msg: string,
        opts: { onEvent: (e: { type: string; data: unknown }) => void },
      ) => {
        emit = opts.onEvent;
        return new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        });
      },
    );
    const { result } = renderHook(() => useAgentChat());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.send('go to example.com');
      // The session create resolves on a microtask, so message() — and with it
      // the onEvent sink — only exists after the queue drains.
      await Promise.resolve();
    });

    act(() => {
      emit({ type: 'phase', data: { phase: 'planning' } });
    });
    expect(result.current.livePhase).toBe('Planning…');

    act(() => {
      emit({
        type: 'plan',
        data: { total: 2, labels: ['Opening example.com', 'Taking a screenshot'] },
      });
      emit({ type: 'step_start', data: { index: 1, total: 2, label: 'Taking a screenshot' } });
    });
    expect(result.current.livePlan).toEqual({
      total: 2,
      labels: ['Opening example.com', 'Taking a screenshot'],
    });
    expect(result.current.liveStepIndex).toBe(1);

    await act(async () => {
      settle(DONE);
      await pending;
    });
    expect(result.current.livePhase).toBeNull();
    expect(result.current.livePlan).toBeNull();
    expect(result.current.liveStepIndex).toBeNull();
  });

  it('⛔ a SECOND plan frame is folded into the turn’s one step list at its offset — it does not replace the first', async () => {
    // A turn is a loop now: look, plan as far as it can see, act, look again, and
    // each pass sends its own `plan` frame. Replacing the live plan with each one
    // put the new captions at indices the view had already marked done (it hides
    // `i < liveSteps.length`, in the TURN's index space), so every later
    // segment's first steps vanished from the screen.
    let emit: (e: { type: string; data: unknown }) => void = () => undefined;
    let settle: (r: AgentMessageResponse) => void = () => undefined;
    message.mockImplementationOnce(
      (
        _id: string,
        _msg: string,
        opts: { onEvent: (e: { type: string; data: unknown }) => void },
      ) => {
        emit = opts.onEvent;
        return new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        });
      },
    );
    const { result } = renderHook(() => useAgentChat());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.send('search for a trail stove');
      await Promise.resolve();
    });

    act(() => {
      emit({ type: 'plan', data: { total: 2, labels: ['Opening the site', 'Waiting'] } });
      emit({ type: 'phase', data: { phase: 'reading_page', segment: 2, cause: 'continue' } });
    });
    expect(result.current.livePhase).toBe('Looking at the page…');
    act(() => {
      emit({ type: 'phase', data: { phase: 'planning', segment: 2, cause: 'continue' } });
    });
    expect(result.current.livePhase).toBe('Continuing…');

    act(() => {
      emit({
        type: 'plan',
        data: { total: 4, offset: 2, segment: 2, labels: ['Typing the search', 'Pressing Enter'] },
      });
      emit({ type: 'step_start', data: { index: 2, total: 4, label: 'Typing the search' } });
    });
    expect(result.current.livePlan).toEqual({
      total: 4,
      labels: ['Opening the site', 'Waiting', 'Typing the search', 'Pressing Enter'],
    });
    // The running marker indexes the SAME list, so it lands on the right caption.
    expect(result.current.livePlan?.labels[result.current.liveStepIndex ?? -1]).toBe(
      'Typing the search',
    );

    await act(async () => {
      settle(DONE);
      await pending;
    });
    expect(result.current.livePlan).toBeNull();
  });

  it('an event name this build has never heard of changes nothing and breaks nothing', async () => {
    // The set is open by design: the server adds progress events without a
    // version bump, so an unknown name must be a no-op, not an error and not a
    // blanked caption.
    let emit: (e: { type: string; data: unknown }) => void = () => undefined;
    let settle: (r: AgentMessageResponse) => void = () => undefined;
    message.mockImplementationOnce(
      (
        _id: string,
        _msg: string,
        opts: { onEvent: (e: { type: string; data: unknown }) => void },
      ) => {
        emit = opts.onEvent;
        return new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        });
      },
    );
    const { result } = renderHook(() => useAgentChat());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.send('go to example.com');
      await Promise.resolve();
    });
    act(() => {
      emit({ type: 'phase', data: { phase: 'planning' } });
      emit({ type: 'thinking_token', data: { token: 'hmm' } });
      emit({ type: 'phase', data: { phase: 'a_phase_from_the_future' } });
      emit({ type: 'plan', data: { nonsense: true } });
    });
    // The truthful caption survives an unknown phase rather than being replaced
    // by a raw token or blanked.
    expect(result.current.livePhase).toBe('Planning…');
    expect(result.current.livePlan).toBeNull();

    await act(async () => {
      settle(DONE);
      await pending;
    });
    expect(result.current.turns.at(-1)?.response).toEqual(DONE);
  });

  it('shows the streamed ANSWER while the turn is still running', async () => {
    // ⛔ The server streams the answer specifically so it does not wait behind
    // the terminal body — and for a while nothing on this side read the frame,
    // so the emit bought the customer nothing at all. This asserts the text is
    // visible while `sending` is still true, which is the only state in which
    // the stream is worth anything, and that it hands off cleanly afterwards.
    let emit: (e: { type: string; data: unknown }) => void = () => undefined;
    let settle: (r: AgentMessageResponse) => void = () => undefined;
    message.mockImplementationOnce(
      (
        _id: string,
        _msg: string,
        opts: { onEvent: (e: { type: string; data: unknown }) => void },
      ) => {
        emit = opts.onEvent;
        return new Promise<AgentMessageResponse>((resolve) => {
          settle = resolve;
        });
      },
    );
    const { result } = renderHook(() => useAgentChat());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.send('go to ifconfig.me and tell me the IP');
      await Promise.resolve();
    });
    act(() => {
      emit({ type: 'answer', data: { answer: 'Your IP address is 203.0.113.7.' } });
    });
    expect(result.current.sending).toBe(true);
    expect(result.current.liveAnswer).toBe('Your IP address is 203.0.113.7.');

    await act(async () => {
      settle(DONE);
      await pending;
    });
    // The settled turn owns the text now; leaving the preview up would show it
    // twice.
    expect(result.current.liveAnswer).toBeNull();
  });

  it('captions only the phases it knows', () => {
    expect(phaseCaption('planning')).toBe('Planning…');
    expect(phaseCaption('reading_page')).toBe('Reading the page…');
    expect(phaseCaption('toString')).toBeNull();
    expect(phaseCaption('whatever_comes_next')).toBeNull();
  });
});
