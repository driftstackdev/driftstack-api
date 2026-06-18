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

/** Map a raw agent-request error to customer-friendly copy (the chat error
 *  banner showed raw err.message — auth/network jargon a user can't act on). */
function friendlyChatError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : '';
  if (status === 401 || status === 403 || /unauthorized|forbidden|api key|scope/i.test(msg)) {
    return 'Your API key was rejected — check it in Settings.';
  }
  if (status === 429 || /rate.?limit|too many/i.test(msg)) {
    return 'Rate limited — wait a moment, then try again.';
  }
  if (/load failed|network|fetch|ECONN|getaddrinfo|timeout|unreachable/i.test(msg)) {
    return "Couldn't reach the server — check your connection and try again.";
  }
  return msg.length > 0 ? msg : 'The agent request failed — try again.';
}

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
  /** S16 — attach the agent session to a saved profile (the identity the AI
   *  works on). Omit for a stateless session. */
  profileId?: string;
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
  /** Load a saved transcript into the view (reopening a past chat). The live
   *  server session is dropped — continuing the chat starts a fresh session,
   *  while the restored transcript stays visible as the chat's memory. */
  restore: (turns: ReadonlyArray<ChatTurn>) => void;
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
      options?: {
        approvals?: ReadonlyArray<{ category: ConsequentialActionCategory; matchedText: string }>;
        /** Append a user bubble for this send. Default true; pass false for an
         *  approval re-send — clicking Approve CONTINUES the same logical turn
         *  (the user didn't retype the message), so echoing it as a fresh user
         *  bubble would misleadingly look like a second request. */
        appendUserTurn?: boolean;
      },
    ): Promise<void> => {
      if (!client) {
        setError('Not connected — set your API key in Settings.');
        return;
      }
      const approvals = options?.approvals;
      setSending(true);
      setError(null);
      if (options?.appendUserTurn !== false) {
        // Append the user turn immediately for responsiveness.
        setTurns((t) => [...t, { id: nextId(), role: 'user', text: userMessage }]);
      }
      setLastUserMessage(userMessage);
      try {
        let sid = session?.id ?? null;
        if (sid === null) {
          const created = await client.agentSessions.create({
            mode: 'ai',
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.tokenBudget !== undefined ? { token_budget: opts.tokenBudget } : {}),
            ...(opts.profileId !== undefined ? { profile_id: opts.profileId } : {}),
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
        setError(friendlyChatError(err));
      } finally {
        setSending(false);
      }
    },
    [client, session, opts.model, opts.tokenBudget, opts.profileId, nextId],
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
    await post(lastUserMessage, {
      approvals: [
        { category: pendingConfirmation.category, matchedText: pendingConfirmation.matchedText },
      ],
      appendUserTurn: false,
    });
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

  const restore = useCallback((restoredTurns: ReadonlyArray<ChatTurn>): void => {
    setTurns([...restoredTurns]);
    setSession(null);
    setError(null);
    setResolvedTurnId(null);
    setLastUserMessage(null);
    // Keep new turn ids monotonic above the restored max so React keys + the
    // confirmation lookup stay correct when the customer continues the chat.
    idRef.current = restoredTurns.reduce((m, t) => Math.max(m, t.id), 0);
  }, []);

  return {
    turns,
    session,
    sending,
    error,
    pendingConfirmation,
    send,
    approve,
    deny,
    reset,
    restore,
  };
}
