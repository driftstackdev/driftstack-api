import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@driftstack/sdk';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import { summariseTurn } from '../../src/lib/chat-history';

/**
 * `AgentMessageResponse` is a FOUR-member discriminated union and only
 * `plan-executed` carries `intents`. A summariser that reaches for `.intents`
 * unconditionally is `undefined` on three turn kinds out of four — the same
 * class of defect that took the Settings tab down (a shape assumed rather than
 * read). Each member gets its own case here so none can be silently dropped.
 */

function session(): AgentSession {
  return {
    id: 'as_1',
    account_id: 'acct_1',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    closed_at: null,
    token_budget_total: 100,
    token_budget_remaining: 100,
    transcript_length: 0,
    created_by_user_id: null,
    mode: 'ai',
    model: 'claude-opus-4-8',
    pair_mode_state: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('summariseTurn', () => {
  it('summarises a user turn as its own text', () => {
    const t: ChatTurn = { id: 1, role: 'user', text: 'open the cart and check out' };
    expect(summariseTurn(t)).toEqual({ role: 'user', headline: 'open the cart and check out' });
  });

  it('collapses whitespace so a pasted multi-line message stays one row', () => {
    const t: ChatTurn = { id: 1, role: 'user', text: '  go   to\n\n  example.com  ' };
    expect(summariseTurn(t).headline).toBe('go to example.com');
  });

  it('truncates a long message on a word boundary, with an ellipsis', () => {
    const t: ChatTurn = { id: 1, role: 'user', text: 'alpha '.repeat(40) };
    const { headline } = summariseTurn(t);
    expect(headline.length).toBeLessThanOrEqual(91);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline).not.toMatch(/alp…$/); // not cut mid-word
  });

  it('names the verbs and the count for an executed plan', () => {
    const t: ChatTurn = {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: session(),
        intents: [
          { kind: 'navigate', url: 'https://example.com' },
          { kind: 'interact', action: 'tap', selector: '#buy' },
        ],
        results: [],
        ok: true,
      },
    };
    const s = summariseTurn(t);
    expect(s.headline).toContain('2 actions');
    expect(s.headline).toContain('navigate');
    expect(s.headline).toContain('interact');
    expect(s.intentCount).toBe(2);
    expect(s.ok).toBe(true);
  });

  it('does not pluralise a single action', () => {
    const t: ChatTurn = {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: session(),
        intents: [{ kind: 'navigate', url: 'https://example.com' }],
        results: [],
        ok: true,
      },
    };
    expect(summariseTurn(t).headline).toContain('1 action ·');
    expect(summariseTurn(t).headline).not.toContain('1 actions');
  });

  it('de-duplicates repeated verbs rather than listing them once each', () => {
    const t: ChatTurn = {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: session(),
        intents: [
          { kind: 'interact', action: 'type', selector: '#a', value: 'x' },
          { kind: 'interact', action: 'tap', selector: '#b' },
          { kind: 'interact', action: 'tap', selector: '#c' },
        ],
        results: [],
        ok: true,
      },
    };
    const { headline } = summariseTurn(t);
    expect(headline).toContain('3 actions');
    expect(headline.match(/interact/g)).toHaveLength(1);
  });

  it('marks a failed plan as failed', () => {
    const t: ChatTurn = {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: session(),
        intents: [{ kind: 'navigate', url: 'https://example.com' }],
        results: [],
        ok: false,
      },
    };
    const s = summariseTurn(t);
    expect(s.headline).toContain('failed');
    expect(s.ok).toBe(false);
  });

  it('handles a plan that executed no intents at all', () => {
    const t: ChatTurn = {
      id: 2,
      role: 'agent',
      response: {
        kind: 'plan-executed',
        session: session(),
        intents: [],
        results: [],
        ok: true,
      },
    };
    const s = summariseTurn(t);
    expect(s.headline).toBe('no actions');
    expect(s.intentCount).toBe(0);
  });

  it('surfaces the question for a clarify turn', () => {
    const t: ChatTurn = {
      id: 3,
      role: 'agent',
      response: { kind: 'clarify', session: session(), clarifying_question: 'Which size?' },
    };
    const s = summariseTurn(t);
    expect(s.headline).toBe('asked: Which size?');
    expect(s.intentCount).toBeUndefined();
    expect(s.ok).toBeUndefined(); // "ok" is meaningless here — not false
  });

  it('surfaces the reason for a refusal', () => {
    const t: ChatTurn = {
      id: 4,
      role: 'agent',
      response: { kind: 'refuse', session: session(), refuse_reason: 'asks for a password' },
    };
    expect(summariseTurn(t).headline).toBe('declined: asks for a password');
  });

  it('says who was driving on a manual turn', () => {
    const t: ChatTurn = {
      id: 5,
      role: 'agent',
      response: { kind: 'logged-manual', session: session() },
    };
    const s = summariseTurn(t);
    expect(s.headline).toMatch(/manual mode/);
    expect(s.intentCount).toBeUndefined();
  });

  it('says so plainly when an agent turn never completed', () => {
    // A stop, a transport failure, or a crash mid-stream. Persisted turns
    // outlive the process that made them, so this shape reaches the rail.
    const t: ChatTurn = { id: 6, role: 'agent' };
    expect(summariseTurn(t).headline).toBe('no response recorded');
  });

  it('does not throw on a user turn with no text', () => {
    const t: ChatTurn = { id: 7, role: 'user' };
    expect(summariseTurn(t).headline).toBe('');
  });
});
