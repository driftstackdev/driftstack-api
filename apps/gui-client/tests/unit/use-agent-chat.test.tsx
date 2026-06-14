// AI-chat S6 — guards the load-bearing consequential-action detection that
// drives the Approve/Deny safety gate. extractPendingConfirmation must fire ONLY
// on a plan-executed turn that actually halted on a confirmation_required intent
// result (a false negative would let a purchase/payment/account-deletion dispatch
// without a prompt; a false positive would nag on benign turns).
import { describe, it, expect } from 'vitest';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import { extractPendingConfirmation } from '../../src/lib/use-agent-chat';

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  token_budget_total: 100_000,
  token_budget_remaining: 99_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-opus-4-7',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

describe('extractPendingConfirmation', () => {
  it('returns the consequential action when a plan-executed turn halted on it', () => {
    const response: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'interact', action: 'tap', selector: '#pay', value: 'Place Order' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://shop/checkout' },
          summary: 'ok',
        },
        {
          kind: 'confirmation_required',
          intent: { kind: 'interact', action: 'tap', selector: '#pay', value: 'Place Order' },
          category: 'purchase',
          matchedText: 'place order',
        },
      ],
      ok: false,
    };
    expect(extractPendingConfirmation(response)).toEqual({
      category: 'purchase',
      matchedText: 'place order',
    });
  });

  it('returns null for a plan-executed turn with only success/failure results', () => {
    const response: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [{ kind: 'navigate', url: 'https://example.com' }],
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://example.com' },
          summary: 'ok',
        },
        { kind: 'failure', intent: { kind: 'capture', capture: 'screenshot' }, reason: 'nope' },
      ],
      ok: false,
    };
    expect(extractPendingConfirmation(response)).toBeNull();
  });

  it('returns null for clarify / refuse / logged-manual responses', () => {
    const clarify: AgentMessageResponse = {
      kind: 'clarify',
      session: SESSION,
      clarifying_question: 'which site?',
    };
    const refuse: AgentMessageResponse = {
      kind: 'refuse',
      session: SESSION,
      refuse_reason: 'against policy',
    };
    const manual: AgentMessageResponse = { kind: 'logged-manual', session: SESSION };
    expect(extractPendingConfirmation(clarify)).toBeNull();
    expect(extractPendingConfirmation(refuse)).toBeNull();
    expect(extractPendingConfirmation(manual)).toBeNull();
  });

  it('returns the FIRST consequential action when several are present', () => {
    const response: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [],
      results: [
        {
          kind: 'confirmation_required',
          intent: { kind: 'interact', action: 'tap', value: 'Pay now' },
          category: 'payment',
          matchedText: 'pay now',
        },
        {
          kind: 'confirmation_required',
          intent: { kind: 'interact', action: 'tap', value: 'Delete account' },
          category: 'account_deletion',
          matchedText: 'delete account',
        },
      ],
      ok: false,
    };
    expect(extractPendingConfirmation(response)?.category).toBe('payment');
  });
});
