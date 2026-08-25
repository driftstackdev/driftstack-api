import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@driftstack/sdk';
import { describeAgentSessionState } from '../../src/lib/session-liveness';

/**
 * The pill claims, to the customer, that their session is alive. The trap this
 * file pins is that the OBVIOUS signal for that claim is the wrong one:
 * `status` stays `'active'` until a session is explicitly closed, even when the
 * worker crashed or never started. Every case below is a case where reading
 * `status` alone would have produced a confident lie.
 */

/** Typed against the real SDK interface, so a field drift fails the build here
 *  rather than being quietly absorbed by a hand-rolled shape. */
function session(over: Partial<AgentSession> = {}): AgentSession {
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
    ...over,
  };
}

describe('describeAgentSessionState', () => {
  it('does NOT say Running for a status-active session whose worker beat says otherwise', () => {
    // The defect this whole module exists for. `status` is 'active' in all four.
    for (const state of ['provisioning', 'idle', 'terminating'] as const) {
      const d = describeAgentSessionState(session({ liveness: { state, fresh: true } }), true);
      expect(d.label, `state=${state}`).not.toBe('Running');
      expect(d.tone, `state=${state}`).not.toBe('running');
    }
  });

  it('says Running only on a fresh beat that actually reports active', () => {
    const d = describeAgentSessionState(
      session({ liveness: { state: 'active', fresh: true } }),
      true,
    );
    expect(d.label).toBe('Running');
    expect(d.tone).toBe('running');
  });

  it('treats an ABSENT beat as unknown and never as dead', () => {
    // The SDK contract is explicit: absent means no fleet control plane, which
    // is a whole class of deployment. Reporting those as stopped would be wrong
    // on every one of them.
    const d = describeAgentSessionState(session(), true);
    expect(d.tone).not.toBe('error');
    expect(d.label).toBe('Session open');
    expect(d.title).toMatch(/waiting on the device/i);
  });

  it('refuses to trust a STALE beat, even one that says active', () => {
    const d = describeAgentSessionState(
      session({ liveness: { state: 'active', fresh: false } }),
      true,
    );
    expect(d.label).not.toBe('Running');
  });

  it('refuses to trust a fresh beat carrying no state', () => {
    // "seen but no live state" — present and fresh, but says nothing.
    const d = describeAgentSessionState(session({ liveness: { state: null, fresh: true } }), true);
    expect(d.label).not.toBe('Running');
    expect(d.label).toBe('Session open');
  });

  it('lets closed win over any beat, however fresh and however active', () => {
    const d = describeAgentSessionState(
      session({
        status: 'closed',
        closed_reason: 'budget_exhausted',
        liveness: { state: 'active', fresh: true },
      }),
      true,
    );
    expect(d.label).toBe('Ended');
    expect(d.title).toContain('budget_exhausted');
  });

  it('reports paused from the binding when no beat contradicts it', () => {
    expect(describeAgentSessionState(session({ status: 'paused' }), true).label).toBe('Paused');
  });

  it('falls back to CONFIGURATION only when there is no session at all', () => {
    expect(describeAgentSessionState(null, true).label).toBe('AI ready');
    expect(describeAgentSessionState(null, false).label).toBe('Not connected');
    expect(describeAgentSessionState(null, false).tone).toBe('error');
  });

  it('never lets a missing API key mask a running session', () => {
    // aiReady is about the key; a session running on a key that has since been
    // removed is still running, and saying "Not connected" would be false.
    const d = describeAgentSessionState(
      session({ liveness: { state: 'active', fresh: true } }),
      false,
    );
    expect(d.label).toBe('Running');
  });

  it('gives every branch a title that explains itself', () => {
    const all = [
      describeAgentSessionState(null, true),
      describeAgentSessionState(null, false),
      describeAgentSessionState(session(), true),
      describeAgentSessionState(session({ status: 'paused' }), true),
      describeAgentSessionState(session({ status: 'closed' }), true),
      describeAgentSessionState(session({ liveness: { state: 'active', fresh: true } }), true),
      describeAgentSessionState(
        session({ liveness: { state: 'provisioning', fresh: true } }),
        true,
      ),
      describeAgentSessionState(session({ liveness: { state: 'idle', fresh: true } }), true),
      describeAgentSessionState(session({ liveness: { state: 'terminating', fresh: true } }), true),
    ];
    for (const d of all) {
      expect(d.title.length, d.label).toBeGreaterThan(12);
      expect(d.label.length, d.label).toBeGreaterThan(0);
    }
  });
});
