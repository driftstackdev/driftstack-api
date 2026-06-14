// AI-chat S6 — useAgentChat hook (Console build).
//
// Drives a customer's AI agent session from the desktop chat: lazily creates an
// agent session on the first send, posts each turn to the run-loop
// (decompose → execute), accumulates the transcript, and surfaces the
// W443/W445 consequential-action confirmation so the view can render an
// Approve/Deny gate. Approve re-sends the same turn with the echoed
// {category, matchedText} so the executor re-plans and dispatches the now-
// approved action instead of halting again.
//
// Uses the SDK `agentSessions` resource (S5 added the confirmation / usage /
// approvals surface) via the memoised SettingsContext client.
//
// Deployment note: the server executor is the stub (driver:mock) until
// Agent-1's real webkit driver lands — so the Claude PLAN is real but the
// browser ACTIONS are simulated. The hook is agnostic; the view labels it.

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AgentMessageResponse,
  AgentSession,
  ConsequentialActionCategory,
} from '@driftstack/sdk';
import { useSettings } from './SettingsContext';

export type ChatModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5';

export interface ChatTurn {
  /** Stable, monotonic id for React keys (turns are append-only). */
  id: number;
  role: 'user' | 'agent';
  /** Set when role === 'user'. */
  text?: string;
  /** Set when role === 'agent'. */
  response?: AgentMessageResponse;
}

export interface PendingConfirmation {
  /** The agent turn that halted — approve()/deny() target it. */
  turnId: number;
  category: ConsequentialActionCategory;
  matchedText: string;
}

/**
 * Pure: extract the first consequential action a plan-executed turn halted on,
 * or null. Exported so the load-bearing safety-gate detection is unit-tested
 * independently of the React/async hook plumbing.
 */
export function extractPendingConfirmation(
  response: AgentMessageResponse,
): { category: ConsequentialActionCategory; matchedText: string } | null {
  if (response.kind !== 'plan-executed') return null;
  for (const r of response.results) {
    if (r.kind === 'confirmation_required') {
      return { category: r.category, matchedText: r.matchedText };
    }
  }
  return null;
}

export interface UseAgentChatOpts {
  model?: ChatModel;
  tokenBudget?: number;
}

export interface UseAgentChatResult {
  turns: ReadonlyArray<ChatTurn>;
  session: AgentSession | null;
  sending: boolean;
  error: string | null;
  /** The consequential action the last turn halted on (Approve/Deny), or null. */
  pendingConfirmation: PendingConfirmation | null;
  send: (userMessage: string) => Promise<void>;
  approve: () => Promise<void>;
  deny: () => void;
  reset: () => void;
}

export function useAgentChat(opts: UseAgentChatOpts = {}): UseAgentChatResult {
  const { client } = useSettings();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The turn id whose confirmation the customer already approved/denied — hides
  // the gate so it doesn't re-prompt for an action they've already resolved.
  const [resolvedTurnId, setResolvedTurnId] = useState<number | null>(null);
  // The user message that produced the current turn — re-sent verbatim on
  // approve() so the executor re-plans + dispatches the now-approved action.
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  const idRef = useRef(0);
  const nextId = useCallback((): number => {
    idRef.current += 1;
    return idRef.current;
  }, []);

  const post = useCallback(
    async (
      userMessage: string,
      approvals?: ReadonlyArray<{ category: ConsequentialActionCategory; matchedText: string }>,
    ): Promise<void> => {
      if (!client) {
        setError('Not connected — set your API key in Settings.');
        return;
      }
      setSending(true);
      setError(null);
      // Append the user turn immediately for responsiveness.
      setTurns((t) => [...t, { id: nextId(), role: 'user', text: userMessage }]);
      setLastUserMessage(userMessage);
      try {
        let sid = session?.id ?? null;
        if (sid === null) {
          const created = await client.agentSessions.create({
            mode: 'ai',
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.tokenBudget !== undefined ? { token_budget: opts.tokenBudget } : {}),
          });
          setSession(created);
          sid = created.id;
        }
        const response = await client.agentSessions.message(sid, userMessage, {
          ...(approvals !== undefined && approvals.length > 0
            ? { approveConsequentialActions: approvals }
            : {}),
        });
        setSession(response.session);
        setTurns((t) => [...t, { id: nextId(), role: 'agent', response }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Agent request failed.');
      } finally {
        setSending(false);
      }
    },
    [client, session, opts.model, opts.tokenBudget, nextId],
  );

  const send = useCallback((userMessage: string): Promise<void> => post(userMessage), [post]);

  // Derive the pending confirmation from the most recent agent turn (unless the
  // customer already resolved it via approve/deny).
  const pendingConfirmation = useMemo<PendingConfirmation | null>(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn === undefined || turn.role !== 'agent' || turn.response === undefined) continue;
      if (turn.id === resolvedTurnId) return null;
      const pc = extractPendingConfirmation(turn.response);
      return pc === null
        ? null
        : { turnId: turn.id, category: pc.category, matchedText: pc.matchedText };
    }
    return null;
  }, [turns, resolvedTurnId]);

  const approve = useCallback(async (): Promise<void> => {
    if (pendingConfirmation === null || lastUserMessage === null) return;
    setResolvedTurnId(pendingConfirmation.turnId);
    await post(lastUserMessage, [
      { category: pendingConfirmation.category, matchedText: pendingConfirmation.matchedText },
    ]);
  }, [pendingConfirmation, lastUserMessage, post]);

  const deny = useCallback((): void => {
    if (pendingConfirmation === null) return;
    // Leave the plan halted; just dismiss the gate. The customer can type a new
    // instruction. (No dispatch — the consequential action never runs.)
    setResolvedTurnId(pendingConfirmation.turnId);
  }, [pendingConfirmation]);

  const reset = useCallback((): void => {
    setTurns([]);
    setSession(null);
    setError(null);
    setResolvedTurnId(null);
    setLastUserMessage(null);
  }, []);

  return { turns, session, sending, error, pendingConfirmation, send, approve, deny, reset };
}
