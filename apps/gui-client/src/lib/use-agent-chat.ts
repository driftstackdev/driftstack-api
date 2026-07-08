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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  type AgentMessageResponse,
  type AgentSession,
  type ConsequentialActionCategory,
} from '@driftstack/sdk';
import { useSettings } from './SettingsContext';
import { clearSession as clearProfileSession, markLaunched } from './profile-bindings';

/** Founder report (2026-07-01): the bundled-LLM error landed in the chat
 *  banner as the raw server detail string — a curl-command-shaped API
 *  message ("PATCH /v1/account/me/bundled-llm-settings with {...}"), not
 *  something a customer could act on from inside the app. `ChatError` carries
 *  a `kind` (+ the budget numbers, for the exhausted case) so the view can
 *  render a friendly headline AND a button that actually does the fix
 *  in-app (Settings → AI & billing) instead of dumping API docs into a chat
 *  bubble. `kind` is undefined for every other error — those still render as
 *  a plain message, unchanged from before.
 */
export interface ChatError {
  message: string;
  kind?: 'bundled_llm_consent' | 'bundled_llm_budget';
  /** Only set when kind === 'bundled_llm_budget'. */
  spentCents?: number;
  capCents?: number;
}

/** Map a raw agent-request error to customer-friendly copy (the chat error
 *  banner showed raw err.message — auth/network jargon a user can't act on). */
function friendlyChatError(err: unknown): ChatError {
  if (err instanceof BundledLlmConsentRequiredError) {
    return {
      message:
        "This deployment's AI features need a quick one-time setup before your first message.",
      kind: 'bundled_llm_consent',
    };
  }
  if (err instanceof BundledLlmBudgetExhaustedError) {
    return {
      message: "You've reached this month's AI spending limit.",
      kind: 'bundled_llm_budget',
      spentCents: err.spentCents,
      capCents: err.capCents,
    };
  }
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : '';
  if (status === 401 || status === 403 || /unauthorized|forbidden|api key|scope/i.test(msg)) {
    return { message: 'Your API key was rejected — check it in Settings.' };
  }
  if (status === 429 || /rate.?limit|too many/i.test(msg)) {
    return { message: 'Rate limited — wait a moment, then try again.' };
  }
  if (/load failed|network|fetch|ECONN|getaddrinfo|timeout|unreachable/i.test(msg)) {
    return { message: "Couldn't reach the server — check your connection and try again." };
  }
  return { message: msg.length > 0 ? msg : 'The agent request failed — try again.' };
}

export type ChatModel =
  | 'claude-opus-4-8'
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

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
  /** Egress-leak fix — the server-side account-proxy id the session must exit
   *  through (resolved by the view from the profile's bound proxy, the SAME way
   *  ProfilesView's manual launch does). Threaded into agentSessions.create as
   *  `proxy_id`. Omit (undefined) → operator-default egress, as before. Without
   *  this an AI session on a proxied profile silently leaked the operator IP. */
  proxyId?: string;
}

export interface UseAgentChatResult {
  turns: ReadonlyArray<ChatTurn>;
  session: AgentSession | null;
  sending: boolean;
  error: ChatError | null;
  /** The consequential action the last turn halted on (Approve/Deny), or null. */
  pendingConfirmation: PendingConfirmation | null;
  /** Turn ids the customer DENIED — the transcript marks their paused step as skipped. */
  deniedTurnIds: ReadonlySet<number>;
  /** Resolves true when the turn succeeded, false on error — lets the caller
   *  restore the draft for a retry instead of losing the typed message. */
  send: (userMessage: string) => Promise<boolean>;
  approve: () => Promise<void>;
  deny: () => void;
  reset: () => void;
  /** Soft-cancel an in-flight turn — un-blocks the composer immediately and
   *  discards the turn's result when it eventually resolves (the server may
   *  still finish it; this is a UI stop, not a network/turn abort). */
  cancel: () => void;
  /** Load a saved transcript into the view (reopening a past chat). The live
   *  server session is dropped — continuing the chat starts a fresh session,
   *  while the restored transcript stays visible as the chat's memory. */
  restore: (turns: ReadonlyArray<ChatTurn>) => void;
  /** Count of leading turns that were RESTORED from saved history and are NOT
   *  backed by the (now-absent) live server session. While > 0 and there is no
   *  live session, continuing the chat starts a FRESH server session that won't
   *  remember these turns — the view shows an honest divider after them. Cleared
   *  once a new live session is created (or on reset/new-chat). */
  restoredHistoryCount: number;
}

export function useAgentChat(opts: UseAgentChatOpts = {}): UseAgentChatResult {
  const { client } = useSettings();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  // Latest live session id, mirrored into a ref so the close-on-unmount cleanup
  // (which can't depend on `session` without re-subscribing every turn) and the
  // reset/restore handlers can best-effort close the PRIOR server session before
  // dropping it locally. Without this, every "New chat" / chat-switch / view-
  // leave abandons the old agent session (and any dispatched Mac) to the idle
  // reaper — a cost + fleet-slot leak that can hit the per-account active cap.
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = session?.id ?? null;
  // The SDK client, mirrored into a ref so the unmount cleanup closes via the
  // client that was current at unmount without re-running the effect on every
  // client identity change.
  const clientRef = useRef(client);
  clientRef.current = client;
  // The attached profile id, mirrored into a ref so the teardown paths (unmount
  // cleanup / reset / restore) can clear THIS profile's local "running" binding
  // when they close the live session — keeping the Profiles hub in sync (the row
  // returns to idle/Launch) instead of leaving it stuck "running" on an AI
  // session that's gone. Best-effort + idempotent; never throws.
  const profileIdRef = useRef<string | undefined>(opts.profileId);
  profileIdRef.current = opts.profileId;
  // Clear the local profile→session binding so the Profiles hub stops showing
  // this profile as running once its AI session is closed/abandoned. Best-effort
  // (a Tauri-store write); a failure is a reaper fallback, not a user error.
  const clearProfileBinding = useCallback((profileId: string | undefined): void => {
    if (profileId === undefined) return;
    void clearProfileSession(profileId).catch(() => undefined);
  }, []);
  // Best-effort close a server-side agent session (idempotent server-side). Never
  // throws: a failed close is a reaper fallback, not a user-visible error.
  const closeServerSession = useCallback((sid: string | null): void => {
    if (sid === null) return;
    const c = clientRef.current;
    if (c === null || typeof c.agentSessions?.close !== 'function') return;
    try {
      void Promise.resolve(c.agentSessions.close(sid)).catch(() => undefined);
    } catch {
      // A synchronous throw from close() is also non-fatal here.
    }
  }, []);
  // The turn id whose confirmation the customer already approved/denied — hides
  // the gate so it doesn't re-prompt for an action they've already resolved.
  const [resolvedTurnId, setResolvedTurnId] = useState<number | null>(null);
  // Turn ids the customer explicitly DENIED (a subset of resolved) — the transcript
  // marks their paused ⏸ consequential step as denied/skipped rather than stuck-waiting.
  const [deniedTurnIds, setDeniedTurnIds] = useState<ReadonlySet<number>>(() => new Set());
  // Leading turns that came from a restore and aren't backed by a live server
  // session (see restore()). Drives the view's honest "continuing starts a new
  // session" divider. Cleared once a fresh session is created on the next send.
  const [restoredHistoryCount, setRestoredHistoryCount] = useState(0);
  // The user message that produced the current turn — re-sent verbatim on
  // approve() so the executor re-plans + dispatches the now-approved action.
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  const idRef = useRef(0);
  const nextId = useCallback((): number => {
    idRef.current += 1;
    return idRef.current;
  }, []);
  // P2 #9 — the id of the optimistic user bubble for the IN-FLIGHT send. The
  // post() rollback only fires when the request RESOLVES; for a truly HUNG AI turn
  // (the message call never resolves) that never happens, so Stop must remove the
  // dangling user bubble itself — otherwise the orphan stays on screen AND gets
  // persisted to chat history by the view's turns-change effect. Set when a user
  // bubble is appended, cleared when the turn completes/rolls back.
  const inFlightUserTurnIdRef = useRef<number | null>(null);
  // Soft cancel — Stop bumps this; an in-flight post that captured an older
  // generation discards its result on resolve. (UI stop; the server turn may
  // still complete — a true network/turn abort is a follow-up.)
  const cancelGenRef = useRef(0);
  const cancel = useCallback(() => {
    cancelGenRef.current += 1;
    setSending(false);
    // P2 #9 — finalize the dangling user bubble NOW (don't wait for a possibly-
    // never-resolving post): remove the orphan so it isn't left on screen and isn't
    // persisted as an unanswered "complete" turn. A post that DOES later resolve
    // sees the bumped generation and no-ops its own rollback.
    const orphan = inFlightUserTurnIdRef.current;
    if (orphan !== null) {
      inFlightUserTurnIdRef.current = null;
      setTurns((t) => t.filter((x) => x.id !== orphan));
    }
  }, []);
  // Invalidate the in-flight generation on unmount so a reply that resolves after
  // the view is gone (App.tsx remounts CurrentView per view.kind, unmounting this
  // hook on a sidebar switch) discards instead of setState-ing a dead component —
  // and so a partial send isn't left looking in-flight (adversarial review
  // w6sdz15an #2). (A true request abort via AbortSignal is a follow-up.)
  // ALSO: best-effort close the live server session so leaving the AI view (or
  // closing the window) doesn't strand a running agent session + its dispatched
  // Mac until the idle reaper — a cost + fleet-slot leak that can otherwise hit
  // the per-account active-session cap on a fresh send (sweep2).
  useEffect(
    () => () => {
      cancelGenRef.current += 1;
      // Only clear the profile binding if a live session actually backed it (a
      // session id is present) — leaving the AI view before the first send must
      // not wipe a binding the manual-launch path may own.
      if (sessionIdRef.current !== null) clearProfileBinding(profileIdRef.current);
      closeServerSession(sessionIdRef.current);
    },
    [closeServerSession, clearProfileBinding],
  );

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
    ): Promise<boolean> => {
      if (!client) {
        setError({ message: 'Not connected — set your API key in Settings.' });
        return false;
      }
      const approvals = options?.approvals;
      setSending(true);
      setError(null);
      // Capture this send's cancel-generation; if Stop bumps it before we
      // resolve, the result is discarded (the user moved on).
      const gen = cancelGenRef.current;
      let appendedUserTurnId: number | null = null;
      if (options?.appendUserTurn !== false) {
        // Append the user turn immediately for responsiveness.
        appendedUserTurnId = nextId();
        const uid = appendedUserTurnId;
        setTurns((t) => [...t, { id: uid, role: 'user', text: userMessage }]);
        // P2 #9 — record it so Stop can remove this exact dangling bubble even if
        // the request hangs forever (the rollback below only fires on resolve).
        inFlightUserTurnIdRef.current = uid;
      }
      setLastUserMessage(userMessage);
      // Drop the optimistic user bubble on any NON-success outcome (Stop / error)
      // so the transcript never persists an unanswered "complete" turn (#3) and the
      // composer draft that submit() restores on a falsey result isn't a duplicate
      // of a kept bubble (#4). The bubble survives only when the agent actually
      // replies (the success path). No-op for approval re-sends (appendUserTurn:
      // false) and after a chat switch (those turns were already cleared by reset).
      const rollbackUserTurn = (): void => {
        if (appendedUserTurnId === null) return;
        const uid = appendedUserTurnId;
        // P2 #9 — clear the in-flight marker (Stop already handled it if it fired
        // first; this no-ops then).
        if (inFlightUserTurnIdRef.current === uid) inFlightUserTurnIdRef.current = null;
        setTurns((t) => t.filter((x) => x.id !== uid));
      };
      try {
        let sid = session?.id ?? null;
        if (sid === null) {
          const created = await client.agentSessions.create({
            mode: 'ai',
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.tokenBudget !== undefined ? { token_budget: opts.tokenBudget } : {}),
            ...(opts.profileId !== undefined ? { profile_id: opts.profileId } : {}),
            // Egress-leak fix — route the AI session through the profile's bound
            // proxy (the view resolved it to a server proxy_id, exactly like
            // ProfilesView's manual launch). Absent → operator-default egress, as
            // before. Without this an AI session on a proxied profile silently
            // exited via the operator/datacenter IP instead of the configured exit.
            ...(opts.proxyId !== undefined ? { proxy_id: opts.proxyId } : {}),
          });
          // Stop/reset/restore (a chat switch or New chat) may have happened while
          // create() was in flight. Without this guard, setSession(created) would
          // attach THIS abandoned chat's server session to whatever chat is now
          // active → the next message posts to the WRONG session (cross-chat
          // transcript + token-budget bleed). Mirror the post-message gen guards
          // (adversarial review w6sdz15an #1).
          if (cancelGenRef.current !== gen) {
            rollbackUserTurn();
            // The chat was abandoned (Stop / New chat / chat switch) WHILE create()
            // was in flight. `created` is never stored (setSession is skipped), so
            // without this it leaks: never closed, billable, and pressuring the
            // per-account active-session cap until the idle reaper. Best-effort
            // close it now (audit: stranded just-created server session).
            closeServerSession(created.id);
            return false;
          }
          setSession(created);
          // Profiles-hub parity — when this AI session attaches to a saved
          // profile, write the SAME local binding the manual launch does
          // (ProfilesView.handleLaunch). Without it the Profiles hub reads the
          // profile as idle/Launch while a billed AI session is live on it, with
          // no Stop affordance — so the user could double-launch it. Best-effort
          // (a local Tauri-store write): a failure must not break the chat, which
          // is already created + running. Fire-and-forget on the success path.
          if (opts.profileId !== undefined) {
            void markLaunched(opts.profileId, created.id).catch(() => undefined);
          }
          // A fresh live session now backs the chat — the restored-history
          // boundary no longer applies (the new session's transcript grows from
          // here), so clear the divider marker.
          setRestoredHistoryCount(0);
          sid = created.id;
        }
        const response = await client.agentSessions.message(sid, userMessage, {
          ...(approvals !== undefined && approvals.length > 0
            ? { approveConsequentialActions: approvals }
            : {}),
        });
        if (cancelGenRef.current !== gen) {
          rollbackUserTurn(); // user hit Stop — discard the reply + the orphan bubble
          return false;
        }
        setSession(response.session);
        // P2 #9 — the turn completed (an agent reply now backs the user bubble), so
        // the bubble is no longer "dangling" — clear the in-flight marker.
        inFlightUserTurnIdRef.current = null;
        setTurns((t) => [...t, { id: nextId(), role: 'agent', response }]);
        return true;
      } catch (err) {
        // Roll back the optimistic user bubble whether this was a Stop or a real
        // failure — submit() restores the draft on a falsey result, so keeping the
        // bubble would duplicate it; the error banner (real failure) explains it.
        rollbackUserTurn();
        if (cancelGenRef.current !== gen) return false; // cancelled — swallow the error
        setError(friendlyChatError(err));
        return false;
      } finally {
        if (cancelGenRef.current === gen) setSending(false);
      }
    },
    [
      client,
      session,
      opts.model,
      opts.tokenBudget,
      opts.profileId,
      opts.proxyId,
      nextId,
      closeServerSession,
    ],
  );

  const send = useCallback((userMessage: string): Promise<boolean> => post(userMessage), [post]);

  // Derive the pending confirmation from the most recent agent turn (unless the
  // customer already resolved it via approve/deny).
  const pendingConfirmation = useMemo<PendingConfirmation | null>(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn === undefined || turn.role !== 'agent' || turn.response === undefined) continue;
      // Suppress the gate for RESTORED history turns when there's no live session.
      // A reopened chat whose last agent turn was a consequential-action halt
      // would otherwise re-render a live-looking Approve/Deny bar where Approve is
      // permanently dead (restore() cleared lastUserMessage, so approve() no-ops).
      // The restored turns are the first `restoredHistoryCount`; once the customer
      // continues (a fresh session is created, session!==null), new turns gate
      // normally again. (audit: dead safety prompt on a read-only restored chat)
      if (session === null && i < restoredHistoryCount) return null;
      if (turn.id === resolvedTurnId) return null;
      const pc = extractPendingConfirmation(turn.response);
      return pc === null
        ? null
        : { turnId: turn.id, category: pc.category, matchedText: pc.matchedText };
    }
    return null;
  }, [turns, resolvedTurnId, session, restoredHistoryCount]);

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
    // instruction. (No dispatch — the consequential action never runs.) Record the
    // turn as DENIED (distinct from resolvedTurnId, which approve() also sets) so the
    // transcript renders its paused ⏸ step as "denied — skipped" instead of leaving it
    // looking like it is still awaiting a decision that will never come.
    const turnId = pendingConfirmation.turnId;
    setResolvedTurnId(turnId);
    setDeniedTurnIds((prev) => {
      const next = new Set(prev);
      next.add(turnId);
      return next;
    });
  }, [pendingConfirmation]);

  const reset = useCallback((): void => {
    // Bump the cancel-generation so any in-flight post() for the PREVIOUS chat
    // discards its result on resolve instead of writing the response onto this
    // fresh chat's transcript + session (audit wja3dfl5t P0). Same for restore().
    cancelGenRef.current += 1;
    // Best-effort close the chat we're leaving so its server session + any
    // dispatched Mac don't leak until the reaper (sweep2). Read via the ref so we
    // close the CURRENT session, not a stale closure capture.
    if (sessionIdRef.current !== null) clearProfileBinding(profileIdRef.current);
    closeServerSession(sessionIdRef.current);
    setSending(false);
    setTurns([]);
    setSession(null);
    setError(null);
    setResolvedTurnId(null);
    setDeniedTurnIds(new Set());
    setLastUserMessage(null);
    setRestoredHistoryCount(0);
  }, [closeServerSession, clearProfileBinding]);

  const restore = useCallback(
    (restoredTurns: ReadonlyArray<ChatTurn>): void => {
      // Invalidate any in-flight post() from the chat we're switching AWAY from, so
      // its late response can't attach to (and persist onto) the restored chat.
      cancelGenRef.current += 1;
      // Best-effort close the chat we're switching AWAY from (same leak as reset).
      if (sessionIdRef.current !== null) clearProfileBinding(profileIdRef.current);
      closeServerSession(sessionIdRef.current);
      setSending(false);
      setTurns([...restoredTurns]);
      // Drop the live session: continuing a reopened chat starts a FRESH server
      // session (the prior one is gone / now closed), and the run-loop rebuilds
      // history from the server transcript — so the restored turns are local
      // memory only and the agent won't see them. The view surfaces an honest
      // "continuing starts a new session" divider so this isn't invisible.
      setSession(null);
      setError(null);
      setResolvedTurnId(null);
      setLastUserMessage(null);
      // Mark every restored turn as history the (absent) live session won't
      // remember, so the view can draw the honest "continuing starts a new
      // session" divider after them.
      setRestoredHistoryCount(restoredTurns.length);
      // Keep new turn ids monotonic above the restored max so React keys + the
      // confirmation lookup stay correct when the customer continues the chat.
      idRef.current = restoredTurns.reduce((m, t) => Math.max(m, t.id), 0);
    },
    [closeServerSession, clearProfileBinding],
  );

  return {
    turns,
    session,
    sending,
    error,
    pendingConfirmation,
    deniedTurnIds,
    send,
    approve,
    deny,
    reset,
    restore,
    cancel,
    restoredHistoryCount,
  };
}
