// Guards two coupled AI-chat fixes in useAgentChat / AgentChatView:
//
//  • MED #1 — an APPROVED consequential step must re-render past-tense
//    ("approved, ran") instead of staying stuck on the live "confirmation
//    required" framing forever. approve() records the halted turn id in
//    `approvedTurnIds` ON SUCCESS, and describeResult() renders that turn's
//    paused step past-tense.
//
//  • MED #8 — the idempotency receipt key must SURVIVE a success-after-Stop (the
//    server may have finished the work while we stopped waiting, so an identical
//    re-send has to replay under the SAME key, not re-execute + re-bill), and
//    still ROTATE on a clean, non-cancelled success. The clear was moved below
//    the cancel-generation check to make that true.
//
// Harness mirrors use-agent-chat-approve.test.tsx (real hook over a mocked SDK
// client). AgentChatView is imported only to exercise the exported describeResult
// unit; its transitive imports are stubbed the same way agent-chat-save-recipe
// does, so no Tauri/LiveKit runtime is needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentMessageResponse, AgentSession } from '@driftstack/sdk';

const create = vi.fn();
const message = vi.fn();
const close = vi.fn();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: { agentSessions: { create, message, close } } }),
}));

const markLaunched = vi.fn((_profileId: string, _sessionId: string) => Promise.resolve());
const clearProfileSession = vi.fn((_profileId: string) => Promise.resolve());
vi.mock('../../src/lib/profile-bindings', () => ({
  markLaunched: (profileId: string, sessionId: string) => markLaunched(profileId, sessionId),
  clearSession: (profileId: string) => clearProfileSession(profileId),
}));

// AgentChatView (imported below for describeResult) pulls in the toast hook and the
// LiveKit-backed live pane; stub both so the module loads without a Tauri/WebRTC
// runtime (mirrors agent-chat-save-recipe.test.tsx).
vi.mock('../../src/lib/toasts', () => ({ useToasts: () => ({ push: vi.fn() }) }));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));

const { useAgentChat } = await import('../../src/lib/use-agent-chat');
const { describeResult } = await import('../../src/views/AgentChatView');

const SESSION: AgentSession = {
  id: 'agt_1',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  stop_on_exit_ip_change: false,
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

const ORDER_INTENT = { kind: 'interact', action: 'tap', value: 'Place order' } as const;

const HALT: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [ORDER_INTENT],
  results: [
    {
      kind: 'confirmation_required',
      intent: ORDER_INTENT,
      category: 'purchase',
      matchedText: 'place order',
    },
  ],
  ok: false,
};

const DONE: AgentMessageResponse = {
  kind: 'plan-executed',
  session: SESSION,
  intents: [ORDER_INTENT],
  results: [{ kind: 'success', intent: ORDER_INTENT, summary: 'ordered' }],
  ok: true,
};

// ─── MED #1: describeResult renders an approved step past-tense ───────────────
describe('describeResult — an approved consequential step reads past-tense', () => {
  const CONF = HALT.results[0]!; // the confirmation_required result

  it('renders "approved, ran" (not "confirmation required") once approved', () => {
    const out = describeResult(CONF, false, true);
    expect(out.text).toContain('approved, ran');
    expect(out.text).toContain('place order');
    expect(out.text).not.toContain('confirmation required');
    expect(out.glyph).toBe('✓');
  });

  it('still says "confirmation required" while the step is unresolved', () => {
    const out = describeResult(CONF, false, false);
    expect(out.text).toContain('confirmation required');
    expect(out.text).not.toContain('approved, ran');
    expect(out.glyph).toBe('⏸');
  });

  it('a denial still takes precedence over approval', () => {
    const out = describeResult(CONF, true, false);
    expect(out.text).toContain('denied, skipped');
  });
});

// ─── MED #1 (hook side): approve() populates approvedTurnIds ON SUCCESS ───────
describe('useAgentChat approve() marks the halted turn approved', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('adds the halted turn id to approvedTurnIds after the re-send succeeds', async () => {
    message.mockResolvedValueOnce(HALT).mockResolvedValueOnce(DONE);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('place my order');
    });
    const haltedTurnId = result.current.pendingConfirmation?.turnId;
    expect(haltedTurnId).toBeDefined();
    // Not yet approved — the Approve/Deny gate is still up.
    expect(result.current.approvedTurnIds.has(haltedTurnId!)).toBe(false);

    await act(async () => {
      await result.current.approve();
    });

    // Approved on success → the transcript can now render that step past-tense,
    // and it is NOT (also) marked denied — the two resolutions are exclusive.
    expect(result.current.approvedTurnIds.has(haltedTurnId!)).toBe(true);
    expect(result.current.deniedTurnIds.has(haltedTurnId!)).toBe(false);
  });

  it('does NOT mark it approved when the re-send fails (gate stays up for retry)', async () => {
    message.mockResolvedValueOnce(HALT).mockRejectedValueOnce(new Error('503 service unavailable'));
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.send('place my order');
    });
    const haltedTurnId = result.current.pendingConfirmation?.turnId;

    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.approvedTurnIds.has(haltedTurnId!)).toBe(false);
    expect(result.current.pendingConfirmation).not.toBeNull();
  });
});

// ─── MED #8: the receipt survives Stop-then-success, rotates on clean success ─
describe('useAgentChat idempotency receipt across a soft Stop', () => {
  beforeEach(() => {
    create.mockReset();
    message.mockReset();
    create.mockResolvedValue(SESSION);
  });

  it('preserves the key when a turn succeeds AFTER Stop, then rotates on a clean success', async () => {
    let resolveFirst: ((r: AgentMessageResponse) => void) | undefined;
    message
      .mockImplementationOnce(
        () =>
          new Promise<AgentMessageResponse>((res) => {
            resolveFirst = res;
          }),
      )
      .mockResolvedValueOnce(DONE) // the identical re-send after Stop
      .mockResolvedValueOnce(DONE); // a later clean re-send

    const { result } = renderHook(() => useAgentChat());

    // 1) Send — create() resolves, message() is dispatched, then hangs.
    let firstSend!: Promise<boolean>;
    await act(async () => {
      firstSend = result.current.send('submit once');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(message).toHaveBeenCalledTimes(1);
    const firstKey = (message.mock.calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey;

    // 2) The customer hits Stop, THEN the in-flight turn finishes successfully.
    await act(async () => {
      result.current.cancel();
      resolveFirst?.(DONE);
      await firstSend;
    });

    // 3) An identical re-send must REPLAY under the SAME key — the receipt must not
    //    have been dropped by the success-after-cancel. ⛔ Reverting the fix (clearing
    //    the receipt above the cancel-generation check) mints a fresh key here, which
    //    re-executes + re-bills the turn the server may already have finished.
    await act(async () => {
      await result.current.send('submit once');
    });
    const retryKey = (message.mock.calls[1]?.[2] as { idempotencyKey: string }).idempotencyKey;
    expect(retryKey).toBe(firstKey);

    // 4) That re-send completed cleanly (not cancelled) → the key now rotates, so a
    //    genuinely new attempt of the same text isn't deduped against a done turn.
    await act(async () => {
      await result.current.send('submit once');
    });
    const laterKey = (message.mock.calls[2]?.[2] as { idempotencyKey: string }).idempotencyKey;
    expect(laterKey).not.toBe(firstKey);
  });
});
