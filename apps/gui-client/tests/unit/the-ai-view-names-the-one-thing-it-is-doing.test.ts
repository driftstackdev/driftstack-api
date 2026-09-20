// `missionPhase` — the AI view's single answer to "what is happening right now".
//
// Stage 4 of the AI-view rebuild hangs the room light, the device rim, the
// status-pill tone and the stage caption off this one word. Six places deriving
// it independently is how the header came to show a green "Session open" beside
// a red "Stopped at step 3", so it is one pure function and these are its arms.
//
// Two things this file is deliberately strict about:
//   • ORDER. `paused` outranks everything, because a halted turn has SETTLED
//     (`sending` is false) and the gate is still up. `sending` outranks the
//     settled verdicts, because the last turn's outcome is history the moment a
//     new one starts.
//   • ABSENCE. About a dozen view tests mock the chat hook with a partial
//     object. A field this function reads may simply not be there, and the
//     absence must resolve to a phase rather than throw — so the arms below
//     include an EMPTY object.

import { describe, expect, it } from 'vitest';
import type { AgentIntentResult, AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import { missionPhase, type MissionPhaseChat } from '../../src/views/agent-chat/mission-phase';

const SESSION: AgentSession = {
  id: 'agt_phase',
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
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

const ok = (summary: string): AgentIntentResult => ({
  kind: 'success',
  intent: { kind: 'navigate', url: 'https://shop.example.com' },
  summary,
});
const failed = (reason: string): AgentIntentResult => ({
  kind: 'failure',
  intent: { kind: 'interact', action: 'tap' },
  reason,
});
const gated = (matchedText: string): AgentIntentResult => ({
  kind: 'confirmation_required',
  intent: { kind: 'interact', action: 'tap' },
  category: 'purchase',
  matchedText,
});

const planExecuted = (results: ReadonlyArray<AgentIntentResult>): AgentMessageResponse => ({
  kind: 'plan-executed',
  session: SESSION,
  intents: results.map((r) => r.intent),
  results,
  ok: results.every((r) => r.kind === 'success'),
});

const userTurn = (id: number, text: string): ChatTurn => ({ id, role: 'user', text });
const agentTurn = (id: number, response: AgentMessageResponse): ChatTurn => ({
  id,
  role: 'agent',
  response,
});

const chat = (over: MissionPhaseChat): MissionPhaseChat => ({
  turns: [],
  sending: false,
  pendingConfirmation: null,
  liveSteps: [],
  liveStepIndex: null,
  ...over,
});

describe('the AI view names the one thing it is doing', () => {
  it('says nothing is happening in a chat that has not run anything', () => {
    expect(missionPhase(chat({}))).toBe('idle');
    expect(missionPhase(chat({ turns: [userTurn(1, 'book me a table')] }))).toBe('idle');
  });

  it('a hook double that omits every field still yields a phase, never a throw', () => {
    expect(missionPhase({})).toBe('idle');
  });

  it('is thinking while it is working and has no step to point at yet', () => {
    expect(missionPhase(chat({ sending: true }))).toBe('thinking');
  });

  it('is acting the moment a step is named, whether it has landed or only started', () => {
    expect(missionPhase(chat({ sending: true, liveStepIndex: 0 }))).toBe('acting');
    expect(missionPhase(chat({ sending: true, liveSteps: [ok('Opened the store')] }))).toBe(
      'acting',
    );
  });

  it('⛔ is PAUSED while a purchase waits on the customer, even though the turn has settled', () => {
    // The halted turn is not sending. Keying the phase on `sending` alone would
    // light the room as if nothing were waiting — the one state where the whole
    // view has to say "nothing moves until you decide".
    const halted = chat({
      sending: false,
      turns: [agentTurn(2, planExecuted([ok('Opened the store'), gated('Place order · $104.00')]))],
      pendingConfirmation: { category: 'purchase', matchedText: 'Place order · $104.00' },
    });
    expect(missionPhase(halted)).toBe('paused');
    // …and it outranks a send that is somehow still in flight.
    expect(missionPhase({ ...halted, sending: true })).toBe('paused');
  });

  it('is done when the last turn ran a plan and every step succeeded', () => {
    expect(
      missionPhase(
        chat({ turns: [userTurn(1, 'go'), agentTurn(2, planExecuted([ok('a'), ok('b')]))] }),
      ),
    ).toBe('done');
  });

  it('⛔ a plan that ran NO steps is not done — that turn is the "I could not turn that into browser actions" reply', () => {
    // "every result succeeded" is vacuously true of an empty list. Blooming the
    // room green for a turn that ran nothing would be the view telling a small lie.
    expect(missionPhase(chat({ turns: [agentTurn(2, planExecuted([]))] }))).toBe('idle');
  });

  it('is trouble when a step failed', () => {
    expect(
      missionPhase(chat({ turns: [agentTurn(2, planExecuted([ok('a'), failed('covered')]))] })),
    ).toBe('trouble');
  });

  it('is trouble when the turn was interrupted, refused or stopped', () => {
    const interrupted: ChatTurn = {
      id: 2,
      role: 'agent',
      interrupted: { reason: 'The connection dropped.', steps: [ok('a')] },
    };
    expect(missionPhase(chat({ turns: [interrupted] }))).toBe('trouble');
    expect(
      missionPhase(
        chat({
          turns: [
            agentTurn(2, {
              kind: 'refuse',
              session: SESSION,
              refuse_reason: 'I can’t help with that.',
            }),
          ],
        }),
      ),
    ).toBe('trouble');
    expect(
      missionPhase(
        chat({
          turns: [
            agentTurn(2, {
              kind: 'stopped',
              session: SESSION,
              intents: [ok('a').intent],
              results: [ok('a')],
              ok: false,
              notice: 'Stopped after 1 step.',
              stopped_during: 'executing',
            }),
          ],
        }),
      ),
    ).toBe('trouble');
  });

  it('⛔ a denied step is trouble; the SAME turn without the denial is not', () => {
    // The result rows are identical in both chats — only `deniedTurnIds` differs.
    // A guard that ignored it would pass on the first arm and report the class fixed.
    const turns = [agentTurn(2, planExecuted([ok('a'), gated('Place order · $104.00')]))];
    expect(missionPhase(chat({ turns, deniedTurnIds: new Set([2]) }))).toBe('trouble');
    expect(missionPhase(chat({ turns }))).toBe('idle');
  });

  it('a clarify or a manual log is neither done nor trouble', () => {
    expect(
      missionPhase(
        chat({
          turns: [
            agentTurn(2, {
              kind: 'clarify',
              session: SESSION,
              clarifying_question: 'Which store?',
            }),
          ],
        }),
      ),
    ).toBe('idle');
    expect(
      missionPhase(chat({ turns: [agentTurn(2, { kind: 'logged-manual', session: SESSION })] })),
    ).toBe('idle');
  });

  it('reads the last AGENT turn, not the customer message that follows it', () => {
    // The customer typing again does not undo the failure above it.
    expect(
      missionPhase(
        chat({
          turns: [
            agentTurn(2, planExecuted([failed('covered')])),
            userTurn(3, 'try the other one'),
          ],
        }),
      ),
    ).toBe('trouble');
  });

  it('a send in flight outranks the settled verdict of the turn before it', () => {
    expect(
      missionPhase(
        chat({ turns: [agentTurn(2, planExecuted([ok('a')]))], sending: true, liveStepIndex: 1 }),
      ),
    ).toBe('acting');
  });
});
