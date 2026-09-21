// Round-2 stage B — the simulator drawer's mission line (one `.ai-chip`-tone
// word + one sentence, mockup `.mission-line`). Pure function, no DOM: every
// phase the AI view's own `missionPhase` can produce, the mode override that
// only applies while a turn is genuinely running, and the "iPhone is still on
// this page" clause that only appears with a live session.

import { describe, expect, it } from 'vitest';
import type { AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import {
  simulatorMissionLine,
  type SimMissionChat,
} from '../../src/views/simulator-chat/mission-line';

const OK: AgentIntentResult = {
  kind: 'success',
  intent: { kind: 'wait', condition: 'idle' },
  summary: 'Opened the store',
};

/** A complete, minimal `AgentSession` — only `agentMessageResponse.session`
 *  needs one (the shape the SDK requires); nothing this file tests reads its
 *  fields. */
function fixtureSession(id: string): AgentSession {
  return {
    id,
    account_id: 'acc_fixture',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    token_budget_total: 0,
    token_budget_remaining: 0,
    transcript_length: 0,
    closed_at: null,
    created_by_user_id: null,
    mode: 'ai',
    model: 'claude-sonnet-5',
    stop_on_exit_ip_change: false,
    pair_mode_state: null,
    created_at: '2026-06-15T00:00:00.000Z',
    updated_at: '2026-06-15T00:00:00.000Z',
  };
}

function userTurn(id: number, text: string): ChatTurn {
  return { id, role: 'user', text };
}

function doneTurn(id: number, results: ReadonlyArray<AgentIntentResult>): ChatTurn {
  return {
    id,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: fixtureSession('agt_response_fixture'),
      intents: results.map((r) => r.intent),
      results,
      ok: true,
    },
  };
}

const SESSION = { id: 'agt_fixture' };

describe('simulatorMissionLine', () => {
  it('idle — no turns, nothing sending: "Ready" / quiet / no beat', () => {
    const line = simulatorMissionLine({ turns: [], sending: false }, 'ai');
    expect(line).toEqual({
      word: 'Ready',
      tone: 'quiet',
      beat: false,
      sentence: 'Describe a task below to get started.',
    });
  });

  it('acting in Agent mode — "Running", live tone, beating, sentence is the plan label at the current step', () => {
    const chat: SimMissionChat = {
      turns: [userTurn(1, 'go shopping')],
      sending: true,
      liveStepIndex: 3,
      liveSteps: [OK, OK, OK],
      livePlan: {
        labels: ['a', 'b', 'c', 'Open the best-rated pair under $120', 'e', 'f'],
        total: 6,
      },
      livePhase: 'Looking at the page…',
    };
    const line = simulatorMissionLine(chat, 'ai');
    expect(line.word).toBe('Running');
    expect(line.tone).toBe('live');
    expect(line.beat).toBe(true);
    expect(line.sentence).toBe('Open the best-rated pair under $120');
  });

  it('acting in Pair mode — the SAME phase reads "Pair", not "Running"', () => {
    const chat: SimMissionChat = { turns: [userTurn(1, 'x')], sending: true, liveSteps: [OK] };
    expect(simulatorMissionLine(chat, 'pair').word).toBe('Pair');
    expect(simulatorMissionLine(chat, 'ai').word).toBe('Running');
  });

  it('thinking (sending, nothing landed yet) — falls back to livePhase, then to "Working…"', () => {
    const withPhase: SimMissionChat = { turns: [], sending: true, livePhase: 'Planning…' };
    expect(simulatorMissionLine(withPhase, 'ai').sentence).toBe('Planning…');
    const withNeither: SimMissionChat = { turns: [], sending: true };
    expect(simulatorMissionLine(withNeither, 'ai').sentence).toBe('Working…');
  });

  it('paused (a consequential action is gated) — "Paused" / hold, mode never changes the word', () => {
    const chat: SimMissionChat = {
      turns: [userTurn(1, 'buy it')],
      sending: false,
      pendingConfirmation: { category: 'purchase', matchedText: 'Place order · $104.00' },
    };
    for (const mode of ['ai', 'pair', null] as const) {
      const line = simulatorMissionLine(chat, mode);
      expect(line.word).toBe('Paused');
      expect(line.tone).toBe('hold');
      expect(line.beat).toBe(false);
      expect(line.sentence).toBe('Nothing moves until you decide');
    }
  });

  it('done — "Done" / ready, "the iPhone is still on this page" only with a live session', () => {
    const turns = [userTurn(1, 'go shopping'), doneTurn(2, [OK, OK])];
    const live = simulatorMissionLine({ turns, sending: false, session: SESSION }, 'ai');
    expect(live.word).toBe('Done');
    expect(live.tone).toBe('ready');
    expect(live.sentence).toBe('Finished — the iPhone is still on this page');

    const ended = simulatorMissionLine({ turns, sending: false, session: null }, 'ai');
    expect(ended.sentence).toBe('Finished');

    // Mode never changes a settled word — only a genuinely running turn does.
    expect(simulatorMissionLine({ turns, sending: false, session: null }, 'pair').word).toBe(
      'Done',
    );
  });

  it('trouble (an interrupted turn) — "Stopped at step N", falling back to plain "Stopped" with nothing ran', () => {
    const interrupted: ChatTurn = {
      id: 2,
      role: 'agent',
      interrupted: { reason: 'the connection dropped', steps: [OK, OK, OK] },
    };
    const withSteps = simulatorMissionLine(
      { turns: [userTurn(1, 'x'), interrupted], sending: false, session: SESSION },
      'ai',
    );
    expect(withSteps.word).toBe('Stopped');
    expect(withSteps.tone).toBe('quiet');
    expect(withSteps.sentence).toBe('Stopped at step 3 — the iPhone is still on this page');

    const noSteps = simulatorMissionLine(
      {
        turns: [
          userTurn(1, 'x'),
          { id: 2, role: 'agent', interrupted: { reason: 'x', steps: [] } },
        ],
        sending: false,
        session: null,
      },
      'ai',
    );
    // Zero steps ran: no fabricated "step 0", and no session ⇒ no "still on this page".
    expect(noSteps.sentence).toBe('Stopped');
  });

  it('VACUITY CONTROL — the tone/word table is not accidentally uniform (every phase gets its own word and tone)', () => {
    const idle = simulatorMissionLine({ turns: [], sending: false }, 'ai');
    const paused = simulatorMissionLine(
      {
        turns: [userTurn(1, 'x')],
        sending: false,
        pendingConfirmation: { category: 'purchase', matchedText: 'y' },
      },
      'ai',
    );
    const done = simulatorMissionLine(
      { turns: [userTurn(1, 'x'), doneTurn(2, [OK])], sending: false, session: null },
      'ai',
    );
    const words = [idle.word, paused.word, done.word];
    expect(new Set(words).size).toBe(words.length);
    const tones = [idle.tone, paused.tone, done.tone];
    expect(tones).toEqual(['quiet', 'hold', 'ready']);
  });
});
