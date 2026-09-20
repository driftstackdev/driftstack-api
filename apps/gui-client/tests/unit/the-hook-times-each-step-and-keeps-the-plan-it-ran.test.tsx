// §7 (stage 3) — THE HOOK TIMES EACH STEP AND KEEPS THE PLAN IT RAN.
//
// A settled turn used to arrive with two things and lose a third. It kept
// `intents` (raw actions, each one a CSS selector) and `results` (what
// happened), and it threw away the server's own customer-safe CAPTIONS — the
// "Open the best-rated pair under $120" the customer had been watching for the
// last minute. So the moment a turn settled, a failed row stopped saying what
// the agent had been trying to do, and a gated row went with it.
//
// It also threw away the ONLY record of how long anything took. Nobody else
// measures it: the server reports no durations, so if this client does not time
// the frames as they arrive, "0:41" does not exist.
//
// Stage 3 keeps all of it, and the whole design of what it keeps is about the
// case where it CANNOT:
//
//   ⛔ EVERY FIELD IS OPTIONAL, AND AN ABSENT ONE RENDERS AS AN ABSENCE. A turn
//   this client did not watch — a response the server replayed from its
//   idempotency store, a chat restored from disk, a build older than this one —
//   must come out with no clock and no durations, never with zeros.
//
// The arms here drive the REAL hook through a fake transport, frame by frame,
// with a clock this test moves by hand. The pure halves (the formatting, the
// fold, the settle-time copy) are in
// a-turn-says-how-long-it-took-only-when-it-was-timed.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { TransportError, type AgentMessageResponse, type AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();
// Present so `cancel()` takes the real Stop path (the hook falls back to a bare
// detach when the client has no `stop`), which is the THIRD door a turn can
// leave by — see the last arm in this file.
const stop = vi.fn();

// ⛔ ONE client object, module-scoped — the hook treats a CHANGE of this object
// as the auth boundary, so a fresh literal per call reports a sign-out on every
// render (the note in a-failed-turn-keeps-what-ran… explains it in full).
const CLIENT = { agentSessions: { create, message, close, stop } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: CLIENT }),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: () => Promise.resolve(),
  clearSession: () => Promise.resolve(),
}));

const { useAgentChat, STOP_FAILED_REASON, STOP_RETRY_DELAY_MS } =
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

const NAV = { kind: 'navigate', url: 'https://shop.example.com/' } as const;
const TYPE = { kind: 'interact', action: 'type', selector: '#q', value: 'shoes' } as const;
const SHOT = { kind: 'capture', capture: 'screenshot' } as const;

/** The stream's own frames, as the server writes them (see the `plan` /
 *  `step_start` / `notice` writers in the agent-sessions route). */
interface Frame {
  type: string;
  data: unknown;
}
interface MessageOpts {
  onStep?: (step: { index: number; result: unknown }) => void;
  onEvent?: (event: Frame) => void;
}

function planExecuted(results: ReadonlyArray<unknown>): AgentMessageResponse {
  return {
    kind: 'plan-executed',
    session: SESSION,
    intents: [NAV, TYPE, SHOT],
    results: results as never,
    ok: true,
  };
}

const RAN = [
  { kind: 'success', intent: NAV, summary: 'Opened the store' },
  { kind: 'success', intent: TYPE, summary: 'Searched the store' },
  { kind: 'success', intent: SHOT, summary: 'Took a screenshot' },
];

// ─── a clock this test moves by hand ─────────────────────────────────────────
//
// `Date.now` rather than fake timers: the hook reads the clock in four places
// and schedules nothing, so moving the clock is the whole of what a timing test
// needs — and it leaves `await act(...)` running on real microtasks, where
// resolved promises behave.
let clock = 1_700_000_000_000;
const START = clock;
function tick(ms: number): void {
  clock += ms;
}

/** A send held open, so the live fields can be read WHILE the turn runs. */
function heldSend(): { opts: () => MessageOpts; settle: (r: AgentMessageResponse) => void } {
  let captured: MessageOpts = {};
  let resolve!: (r: AgentMessageResponse) => void;
  message.mockImplementation((_sid: string, _msg: string, opts: MessageOpts) => {
    captured = opts;
    return new Promise<AgentMessageResponse>((res) => {
      resolve = res;
    });
  });
  return {
    opts: () => captured,
    settle: (r) => {
      resolve(r);
    },
  };
}

beforeEach(() => {
  create.mockReset();
  message.mockReset();
  close.mockReset();
  stop.mockReset();
  create.mockResolvedValue(SESSION);
  clock = START;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  // A no-op unless an arm faked them; without it, one arm's fake `setTimeout`
  // would outlive it and the next arm's awaits would never resolve.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let the hook's promise chains settle. Five turns of the microtask queue is
 *  what the existing Stop tests use, and this file's arms are the same shape. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('a step is timed from the frame that announced it to the frame that finished it', () => {
  it('⛔ keeps one duration per step, in order, on the settled turn', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });

    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'plan', data: { total: 3, labels: ['Open', 'Search', 'Shoot'] } });
      onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3100);
      onStep?.({ index: 0, result: RAN[0] });
      onEvent?.({ type: 'step_start', data: { index: 1 } });
      tick(1400);
      onStep?.({ index: 1, result: RAN[1] });
      onEvent?.({ type: 'step_start', data: { index: 2 } });
      tick(5200);
      onStep?.({ index: 2, result: RAN[2] });
      await Promise.resolve();
    });

    // Read live, before the settle clears it: the running turn's rows can show
    // a duration as soon as they land, not only once the turn is over.
    expect(result.current.liveStepMs).toEqual([3100, 1400, 5200]);

    tick(2000);
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });

    const turn = result.current.turns.at(-1);
    expect(turn?.timing?.stepMs).toEqual([3100, 1400, 5200]);
    // The whole turn is longer than the sum of its steps — it also planned,
    // and it read the answer back. 3100+1400+5200+2000.
    expect(turn?.timing?.elapsedMs).toBe(11_700);
  });

  it('⛔ times the turn from SEND, so the silence before the first frame is counted', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    // The clock is live the moment the customer presses Send — the 10-30s
    // before the server says anything is the part of a turn that feels longest,
    // and a clock that started at the first frame would hide exactly that.
    expect(result.current.liveStartedAt).toBe(START);

    tick(27_000);
    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'plan', data: { total: 1, labels: ['Open'] } });
      onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3000);
      onStep?.({ index: 0, result: RAN[0] });
      await Promise.resolve();
    });
    await act(async () => {
      held.settle(planExecuted([RAN[0]]));
      await sent;
    });

    expect(result.current.turns.at(-1)?.timing?.elapsedMs).toBe(30_000);
    // And the live clock is put away with the rest of the live progress.
    expect(result.current.liveStartedAt).toBeNull();
  });

  it('a step whose start was never announced has NO duration, and its neighbours keep theirs', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3100);
      onStep?.({ index: 0, result: RAN[0] });
      // No step_start for index 1 — a dropped frame, or a server that does not
      // send them for every step.
      tick(1400);
      onStep?.({ index: 1, result: RAN[1] });
      onEvent?.({ type: 'step_start', data: { index: 2 } });
      tick(5200);
      onStep?.({ index: 2, result: RAN[2] });
      await Promise.resolve();
    });
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });

    // ⛔ null, never 0: the middle row shows no time at all rather than
    // claiming the step was instant.
    expect(result.current.turns.at(-1)?.timing?.stepMs).toEqual([3100, null, 5200]);
  });
});

describe('a turn this client never watched is stored with no timing at all', () => {
  it('⛔ a response that arrives whole — the server replaying a stored terminal — carries neither plan nor timing', async () => {
    message.mockResolvedValue(planExecuted(RAN));
    const { result } = renderHook(() => useAgentChat());
    tick(2000);
    await act(async () => {
      await result.current.send('search the store');
    });

    const turn = result.current.turns.at(-1);
    expect(turn?.response?.kind).toBe('plan-executed');
    // The send was timed — every send is — but nothing of the turn was seen,
    // so there is nothing honest to say about how long the turn took.
    expect(turn?.timing).toBeUndefined();
    expect(turn?.plan).toBeUndefined();
  });

  it('⛔ drops the durations when the settled results are not the steps that streamed', async () => {
    // A duration is POSITIONAL — `stepMs[i]` is read against `results[i]`. A
    // turn whose settled list is longer than the streamed one would hang step
    // 2's time off step 3, which is not an approximation but a wrong sentence.
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'plan', data: { total: 3, labels: ['Open', 'Search', 'Shoot'] } });
      onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3100);
      onStep?.({ index: 0, result: RAN[0] });
      await Promise.resolve();
    });
    tick(1000);
    await act(async () => {
      held.settle(planExecuted(RAN)); // three results, one streamed step
      await sent;
    });

    const turn = result.current.turns.at(-1);
    expect(turn?.timing?.stepMs).toBeUndefined();
    // The turn's own clock is still true — it is not positional.
    expect(turn?.timing?.elapsedMs).toBe(4100);
    // And the captions the customer watched are still kept.
    expect(turn?.plan?.labels).toEqual(['Open', 'Search', 'Shoot']);
  });
});

describe('the plan the customer watched survives the settle', () => {
  it('keeps the server’s captions and the kind of each step', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    await act(async () => {
      held.opts().onEvent?.({
        type: 'plan',
        data: {
          total: 3,
          labels: ['Open the store', 'Search the store', 'Screenshot the page'],
          intents: [NAV, TYPE, SHOT],
        },
      });
      await Promise.resolve();
    });
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });

    const plan = result.current.turns.at(-1)?.plan;
    expect(plan?.labels).toEqual(['Open the store', 'Search the store', 'Screenshot the page']);
    // ⛔ `type`, not `interact`: an interact step reports the ACTION, which is
    // the thing a customer can picture and the thing the row draws.
    expect(plan?.kinds).toEqual(['navigate', 'type', 'capture']);
  });

  it('remembers WHERE the agent looked at the page and made a new plan', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'plan', data: { total: 2, labels: ['Open the store', 'Search'] } });
      onStep?.({ index: 0, result: RAN[0] });
      onStep?.({ index: 1, result: RAN[1] });
      // The second pass, and the reason for it.
      onEvent?.({ type: 'phase', data: { phase: 'planning', cause: 'replan' } });
      onEvent?.({
        type: 'plan',
        data: { total: 3, labels: ['Screenshot the page'], offset: 2, intents: [SHOT] },
      });
      await Promise.resolve();
    });
    // Live, while it is still running, so the running turn draws the row too.
    expect(result.current.livePlan?.replanAt).toEqual([2]);
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });
    expect(result.current.turns.at(-1)?.plan?.replanAt).toEqual([2]);
  });

  it('⛔ a second segment the agent simply CARRIED ON with is not a re-plan', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    const { onEvent } = held.opts();
    await act(async () => {
      onEvent?.({ type: 'plan', data: { total: 2, labels: ['Open the store', 'Search'] } });
      onEvent?.({ type: 'phase', data: { phase: 'planning', cause: 'continue' } });
      onEvent?.({ type: 'plan', data: { total: 3, labels: ['Screenshot'], offset: 2 } });
      await Promise.resolve();
    });
    expect(result.current.livePlan?.replanAt).toBeUndefined();
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });
    expect(result.current.turns.at(-1)?.plan?.replanAt).toBeUndefined();
  });
});

describe('the "not finished" notice arrives while the turn is still running', () => {
  it('is readable mid-turn and is put away when the settled turn renders its own', async () => {
    const NOTICE =
      'I did the steps above, but this task needs more steps than I take in one message. Send “continue” and I will carry on from this page.';
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    expect(result.current.liveNotice).toBeNull();
    await act(async () => {
      held
        .opts()
        .onEvent?.({ type: 'notice', data: { notice: NOTICE, notice_reason: 'step_limit' } });
      await Promise.resolve();
    });
    expect(result.current.liveNotice).toBe(NOTICE);

    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });
    // The settled turn carries the same sentence in its own body, so leaving
    // this one on screen would show it twice.
    expect(result.current.liveNotice).toBeNull();
  });

  it('ignores an empty or non-string notice rather than rendering a blank card', async () => {
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    await act(async () => {
      const { onEvent } = held.opts();
      onEvent?.({ type: 'notice', data: { notice: '   ' } });
      onEvent?.({ type: 'notice', data: { notice: 42 } });
      onEvent?.({ type: 'notice', data: {} });
      await Promise.resolve();
    });
    expect(result.current.liveNotice).toBeNull();
    await act(async () => {
      held.settle(planExecuted(RAN));
      await sent;
    });
  });
});

describe('a turn that was cut off keeps what it watched', () => {
  it('an interrupted turn carries the captions and the durations of the steps that really ran', async () => {
    let captured: MessageOpts = {};
    let reject!: (e: unknown) => void;
    message.mockImplementation((_sid: string, _msg: string, opts: MessageOpts) => {
      captured = opts;
      return new Promise<AgentMessageResponse>((_res, rej) => {
        reject = rej;
      });
    });
    const { result } = renderHook(() => useAgentChat());
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = result.current.send('search the store');
      await Promise.resolve();
    });
    await act(async () => {
      captured.onEvent?.({
        type: 'plan',
        data: {
          total: 3,
          labels: ['Open the store', 'Search', 'Shoot'],
          intents: [NAV, TYPE, SHOT],
        },
      });
      captured.onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3100);
      captured.onStep?.({ index: 0, result: RAN[0] });
      await Promise.resolve();
    });
    tick(900);
    await act(async () => {
      reject(new TransportError('the connection dropped'));
      await sent;
    });

    const turn = result.current.turns.at(-1);
    expect(turn?.interrupted?.steps).toHaveLength(1);
    expect(turn?.timing?.stepMs).toEqual([3100]);
    expect(turn?.timing?.elapsedMs).toBe(4000);
    // B6's whole point: the steps that ran are kept — and now so is what the
    // agent said it was doing when it ran them.
    expect(turn?.plan?.labels).toEqual(['Open the store', 'Search', 'Shoot']);
  });

  it('⛔ AND SO DOES A TURN THE CHAT STOPPED WAITING FOR — the third door out of a turn', async () => {
    // REVIEW REPAIR (stage 3). A turn reaches the transcript through THREE
    // exits, and §7 originally landed on two of them: post()'s success and
    // post()'s catch. The third is `detach({ reason })` — the customer pressed
    // Stop and the server never confirmed it — and a turn that left that way
    // arrived with no plan and no timing, so its failed and gated rows fell
    // back to "Tap something on the page" and its durations vanished. Nothing
    // about that turn is less watched than the other two; it just used a
    // different door.
    //
    // ⛔ It is also the exit where the ORDER matters most: `detach` calls
    // `clearLiveProgress()` before it appends the turn, so anything read from
    // the live refs inside the `setTurns` updater is already empty.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stop.mockRejectedValue(new Error('offline'));
    const held = heldSend();
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      void result.current.send('search the store');
      await flush();
    });
    const { onEvent, onStep } = held.opts();
    await act(async () => {
      onEvent?.({
        type: 'plan',
        data: {
          total: 3,
          labels: ['Open the store', 'Search', 'Shoot'],
          intents: [NAV, TYPE, SHOT],
        },
      });
      onEvent?.({ type: 'step_start', data: { index: 0 } });
      tick(3100);
      onStep?.({ index: 0, result: RAN[0] });
      await flush();
    });
    tick(2000);
    act(() => {
      result.current.cancel();
    });
    await act(async () => {
      await flush();
      vi.advanceTimersByTime(STOP_RETRY_DELAY_MS);
      await flush();
    });

    const stopped = result.current.turns.at(-1);
    // The B6 receipt itself is untouched — this is additive, as §7 is.
    expect(stopped?.interrupted?.reason).toBe(STOP_FAILED_REASON);
    expect(stopped?.interrupted?.steps).toHaveLength(1);
    // …and now it carries what the customer was reading while it ran.
    expect(stopped?.plan?.labels).toEqual(['Open the store', 'Search', 'Shoot']);
    expect(stopped?.plan?.kinds).toEqual(['navigate', 'type', 'capture']);
    expect(stopped?.timing?.stepMs).toEqual([3100]);
    // Send → the last frame → the moment the chat stopped waiting.
    expect(stopped?.timing?.elapsedMs).toBe(5100);
  });
});
