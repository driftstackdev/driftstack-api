// The two pure answers the history rail is drawn from: how a saved chat ENDED
// (`chatOutcome`, the dot) and what the chat being worked on is DOING RIGHT NOW
// (`liveChatStatus`, the meta line).
//
// ⛔ WHY `chatOutcome` DOES NOT CALL THE PROSE SUMMARISER, and why that is worth
// a test rather than a comment. `summariseChatTurn` reaches `summariseTurn` in
// `lib/chat-history`, and about a dozen view tests `vi.mock` that module with
// three or four exports — four of them mock it WITH saved chats and WITHOUT
// `summariseTurn`, including both tests that pin the own-key model picker. A
// rail that asked the summariser for a colour would call `undefined(...)` once
// per row in every one of them. So the dot is derived from the turn's own
// shape.
//
// That leaves two functions that must agree, which is the failure mode a
// duplicate always has. The last describe holds them together: wherever
// `summariseChatTurn(...)` publishes an `ok`, `chatOutcome` must say the same
// thing, and it runs against the REAL chat-history module.

import { describe, expect, it } from 'vitest';
import type {
  AgentIntent,
  AgentIntentResult,
  AgentMessageResponse,
  AgentSession,
} from '@driftstack/sdk';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import { chatOutcome, summariseChatTurn } from '../../src/views/agent-chat/chat-turn-summary';
import {
  liveChatStatus,
  NEEDS_APPROVAL_LABEL,
  type MissionStatusChat,
} from '../../src/views/agent-chat/mission-status';

/** Every response below carries one: the union requires it, and a complete
 *  fixture is what keeps this file out of the type backlog. */
const SESSION: AgentSession = {
  id: 'agt_outcome',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  closed_at: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  stop_on_exit_ip_change: false,
  created_at: '2026-06-15T06:00:00.000Z',
  updated_at: '2026-06-15T06:40:00.000Z',
};

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#buy' };

function ok(summary: string): AgentIntentResult {
  return { kind: 'success', intent: TAP, summary };
}
function bad(reason: string): AgentIntentResult {
  return { kind: 'failure', intent: TAP, reason };
}

function user(id: number, text: string): ChatTurn {
  return { id, role: 'user', text };
}
function agent(id: number, response: AgentMessageResponse): ChatTurn {
  return { id, role: 'agent', response };
}

const PLAN_OK: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  ok: true,
  intents: [TAP],
  results: [ok('Opened the store')],
  answer: 'Done.',
};
const PLAN_FAILED: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  ok: false,
  intents: [TAP],
  results: [bad('The button was covered')],
};
const STOPPED: AgentMessageResponse = {
  kind: 'stopped',
  session: SESSION,
  intents: [TAP],
  results: [ok('Opened the store')],
  ok: false,
  notice: 'Stopped after step 1 of 3, as you asked.',
  stopped_during: 'executing',
};
const REFUSED: AgentMessageResponse = {
  kind: 'refuse',
  session: SESSION,
  refuse_reason: 'That would need a payment method I cannot see.',
};
const CLARIFY: AgentMessageResponse = {
  kind: 'clarify',
  session: SESSION,
  clarifying_question: 'Which of the two carts did you mean?',
};
const MANUAL: AgentMessageResponse = { kind: 'logged-manual', session: SESSION };

describe('a saved chat wears the outcome of its last turn', () => {
  it('is green only when the last thing the AI did worked', () => {
    expect(chatOutcome([user(1, 'go'), agent(2, PLAN_OK)])).toBe('ok');
  });

  it('is red for every way a turn ends badly', () => {
    expect(chatOutcome([user(1, 'go'), agent(2, PLAN_FAILED)])).toBe('bad');
    expect(chatOutcome([user(1, 'go'), agent(2, STOPPED)])).toBe('bad');
    expect(chatOutcome([user(1, 'go'), agent(2, REFUSED)])).toBe('bad');
    expect(
      chatOutcome([
        user(1, 'go'),
        {
          id: 2,
          role: 'agent',
          interrupted: { reason: 'The connection dropped.', steps: [ok('Opened the store')] },
        },
      ]),
    ).toBe('bad');
  });

  it('claims nothing when nothing conclusive happened', () => {
    expect(chatOutcome([])).toBe('idle');
    // a chat whose last message got no reply yet
    expect(chatOutcome([user(1, 'go')])).toBe('idle');
    // a question back, and a turn the customer drove by hand
    expect(chatOutcome([user(1, 'go'), agent(2, CLARIFY)])).toBe('idle');
    expect(chatOutcome([user(1, 'go'), agent(2, MANUAL)])).toBe('idle');
    // an agent turn with no response at all — a crash mid-stream
    expect(chatOutcome([user(1, 'go'), { id: 2, role: 'agent' }])).toBe('idle');
  });

  it('reads the LAST agent turn, never the customer’s last word', () => {
    // A failed turn followed by a fresh question is still a failed chat: the
    // customer's own message says nothing about what the AI did.
    expect(chatOutcome([agent(1, PLAN_OK), agent(2, PLAN_FAILED), user(3, 'try again')])).toBe(
      'bad',
    );
    // CONTROL — reverse the two agent turns and the verdict flips, so the arm
    // measures "last" and not "any".
    expect(chatOutcome([agent(1, PLAN_FAILED), agent(2, PLAN_OK), user(3, 'thanks')])).toBe('ok');
  });
});

describe('the rail says what the chat it is working on is doing', () => {
  it('says Starting… while the plan is still being made', () => {
    expect(liveChatStatus({ sending: true })).toEqual({ meta: 'Starting…', dot: 'running' });
  });

  it('counts the step the same way the live turn does', () => {
    const running: MissionStatusChat = {
      sending: true,
      livePlan: { total: 6 },
      liveSteps: [1, 2, 3],
      liveStepIndex: 3,
    };
    expect(liveChatStatus(running)).toEqual({ meta: 'Running · step 4 of 6', dot: 'running' });
    // "of M" is dropped when the total is not known — the same rule as Turn.tsx's
    // `ofTotal`, so the rail and the column can never disagree by a number.
    expect(liveChatStatus({ sending: true, liveStepIndex: 1 })).toEqual({
      meta: 'Running · step 2',
      dot: 'running',
    });
  });

  it('a pending decision is said in WORDS, not only in amber', () => {
    const gated: MissionStatusChat = {
      sending: false,
      pendingConfirmation: { category: 'purchase', matchedText: 'Place order · $104.00' },
    };
    expect(liveChatStatus(gated)).toEqual({ meta: NEEDS_APPROVAL_LABEL, dot: 'approval' });
  });

  it('⛔ Stopping… outranks the step it was on, so the rail cannot contradict the pill', () => {
    // The bar says `Stopping`. A rail row reading "Running · step 3 of 6" beside
    // it is the same class of lie as the green "Session open" beside a red
    // "Stopped at step 3" that this stage removed from the pill.
    const stopping: MissionStatusChat = {
      sending: true,
      stopping: true,
      livePlan: { total: 6 },
      liveStepIndex: 2,
    };
    expect(liveChatStatus(stopping)).toEqual({ meta: 'Stopping…', dot: 'running' });
    // …and it outranks a gate that is still up, because Stop is the newer
    // instruction (the same order stage 5 gave the composer's captions).
    expect(
      liveChatStatus({
        stopping: true,
        pendingConfirmation: { category: 'purchase', matchedText: 'Place order' },
      })?.meta,
    ).toBe('Stopping…');
    // CONTROL: take the stop away and the same chat is back on its step.
    expect(liveChatStatus({ ...stopping, stopping: false })).toEqual({
      meta: 'Running · step 3 of 6',
      dot: 'running',
    });
  });

  it('says nothing at all about a chat that is not doing anything', () => {
    expect(liveChatStatus({})).toBeNull();
    expect(liveChatStatus({ sending: false, pendingConfirmation: null })).toBeNull();
    // A partial hook double must produce an absence, never a throw.
    expect(() => liveChatStatus({})).not.toThrow();
  });
});

describe('the dot and the sentence cannot drift apart', () => {
  it('⛔ agrees with summariseChatTurn wherever the summariser publishes an ok', () => {
    // Two functions answering one question is how a duplicate goes stale. This
    // runs both over the same turns, against the REAL chat-history module.
    const cases: ReadonlyArray<ChatTurn> = [
      agent(1, PLAN_OK),
      agent(2, PLAN_FAILED),
      agent(3, STOPPED),
      {
        id: 4,
        role: 'agent',
        interrupted: { reason: 'The connection dropped.', steps: [] },
      },
    ];
    let compared = 0;
    for (const turn of cases) {
      const summary = summariseChatTurn(turn);
      if (summary.ok === undefined) continue;
      compared += 1;
      expect(chatOutcome([turn]), summary.headline).toBe(summary.ok ? 'ok' : 'bad');
    }
    // A loop that compared nothing would pass. Say how many it had to compare.
    expect(compared, 'no turn in the sweep published an `ok` to compare').toBeGreaterThanOrEqual(3);
  });

  it('CONTROL — the summariser really does publish both verdicts here', () => {
    expect(summariseChatTurn(agent(1, PLAN_OK)).ok).toBe(true);
    expect(summariseChatTurn(agent(2, PLAN_FAILED)).ok).toBe(false);
    expect(summariseChatTurn(agent(3, STOPPED)).ok).toBe(false);
  });
});
