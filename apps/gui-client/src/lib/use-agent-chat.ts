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
  AuthError,
  BundledLlmBudgetExhaustedError,
  BundledLlmConsentRequiredError,
  ByokAnthropicRequiredError,
  DriftstackError,
  ExpiredKeyError,
  InvalidKeyError,
  RevokedKeyError,
  type AgentIntentResult,
  type AgentMessageResponse,
  type AgentSession,
  type ConsequentialActionCategory,
} from '@driftstack/sdk';
import { useSettings } from './SettingsContext';
import type { DriftstackClient } from './client';
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

/**
 * The banner a failed turn raises, or null for one that raises none.
 *
 * ⛔ Only the two bundled-LLM problems still get a banner, and not because their
 * wording is better: that banner is the only in-app way to enable AI features or
 * raise the monthly limit, so it is a CONTROL, not a sentence. Every other
 * failure now explains itself on the interrupted turn, in the transcript, beside
 * the steps that ran. Raising a second surface for those produced two different
 * instructions for one failure on one screen — a session-closed 409 said
 * "Continue in a new session" in the turn and "The item changed or is busy.
 * Refresh and try again." in the banner.
 */
function bannerForFailedTurn(err: unknown): ChatError | null {
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
  return null;
}

export type ChatModel =
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5';

/** The coarse stage a running turn is in, from the server's `phase` frames. */
export type AgentTurnPhase =
  | 'planning'
  | 'starting_browser'
  | 'executing'
  | 'reading_page'
  | 'answering';

/** Captions for each phase. Plain product language: what the customer gets. */
const PHASE_CAPTIONS: Record<AgentTurnPhase, string> = {
  planning: 'Planning…',
  starting_browser: 'Starting the browser…',
  executing: 'Working on your request…',
  reading_page: 'Reading the page…',
  answering: 'Writing your answer…',
};

/** The caption for a phase, or null for a name this build has never seen —
 *  which is expected, because the server may add phases at any time. */
export function phaseCaption(phase: string): string | null {
  return Object.prototype.hasOwnProperty.call(PHASE_CAPTIONS, phase)
    ? PHASE_CAPTIONS[phase as AgentTurnPhase]
    : null;
}

/** The plan a running turn is about to execute, as the customer sees it. */
export interface LivePlan {
  /** One customer-safe caption per planned step, server-authored. */
  labels: ReadonlyArray<string>;
  total: number;
}

/**
 * A turn that STOPPED partway. It keeps whatever actually ran so the customer
 * can see what the agent did before it stopped — losing that on an error both
 * hid real work and made a repeat look safe when it was not.
 */
export interface InterruptedTurn {
  /** One sentence naming the real reason, mapped from the typed problem. */
  reason: string;
  /** Steps that completed before the turn stopped. May be empty. */
  steps: ReadonlyArray<AgentIntentResult>;
}

export interface ChatTurn {
  /** Stable, monotonic id for React keys (turns are append-only). */
  id: number;
  role: 'user' | 'agent';
  /** Set when role === 'user'. */
  text?: string;
  /** Set when role === 'agent'. */
  response?: AgentMessageResponse;
  /** Set when role === 'agent' and the turn stopped partway. Mutually exclusive
   *  with `response` — an interrupted turn never produced one. */
  interrupted?: InterruptedTurn;
}

/**
 * Whether a failure PROVES the server reached a terminal outcome for this turn,
 * so the durable idempotency receipt is spent and a retry must use a new key.
 *
 * ⛔ Decided on the problem's TYPE, never on its prose. The bug this closes: the
 * receipt was cleared only on success, so after a 402 consent / a 409 / a 500
 * the next Send replayed the SAME stored failure under the SAME key — forever,
 * including the Send immediately after the customer clicked "Enable AI
 * features" and fixed the actual cause.
 *
 * ⛔ "Terminal" is NOT the same as "typed". The route stores a terminal for every
 * typed failure on purpose — its own words: "If browser work finished and a
 * later database/debit step failed, retrying must replay the same terminal
 * problem rather than guessing that the action is safe to repeat." Minting a
 * fresh key for one of those turns is how the same plan gets dispatched, and
 * billed, twice. So the receipt is spent ONLY for problems that prove nothing
 * ran; everything that leaves the outcome open keeps it, and the server replays
 * the stored answer — which for a turn that really ran is the correct one.
 *
 * Kept (the turn may have run, or may still be running):
 *   • a transport failure (dropped stream, offline blip) says nothing about
 *     whether the server ran the turn, and replaying under the same key is
 *     exactly what makes the retry safe;
 *   • a 409 carrying `idempotency_status: 'in_progress'` is the server saying
 *     the original request under THIS key has not settled yet;
 *   • any 5xx — the canonical unknown-outcome case, and the one the route's
 *     comment above is about;
 *   • any problem carrying settled work (`partial_results`, `tokens_consumed`,
 *     `usage`) or `ai_control_unavailable`. Those 409s arrive on a session that
 *     was RUNNING the plan, and their own copy says "Check the partial results
 *     before starting a new turn". Re-sending under a new key would re-dispatch
 *     the consequential step the customer is being asked to check.
 *
 * Spent (the turn provably never started): the 402 consent / budget prompts, the
 * missing-provider-key refusal (a 502 by status, but raised while the route is
 * still resolving the credential), a 409 idempotency MISMATCH (this key can
 * never serve this request), and the ordinary 4xx validation/auth refusals.
 */
export function turnReceiptIsSpent(err: unknown): boolean {
  if (!(err instanceof DriftstackError)) return false;
  if (err.kind === 'transport') return false;
  if (err.extensions['idempotency_status'] === 'in_progress') return false;
  // ⛔ TYPE before status. This one is a 502 only because it reports an upstream
  // MISCONFIGURATION — no key is set — and it is raised while the route is still
  // resolving the credential, before the planner or the browser is touched. It
  // is also the single most important case B4 exists for: the Send the customer
  // makes immediately after adding the key. Reading it as "an unknown 5xx
  // outcome" would replay the same "no key configured" at them forever.
  if (err instanceof ByokAnthropicRequiredError) return true;
  if (err.status >= 500) return false;
  if (err.extensions['ai_control_unavailable'] === true) return false;
  if (errorCarriesSettledWork(err)) return false;
  return true;
}

/** True when the problem itself is evidence that part of the turn already ran.
 *  Read off the declared extensions the route sets — never off the sentence. */
function errorCarriesSettledWork(err: DriftstackError): boolean {
  const { partial_results: partial, tokens_consumed: tokens, usage } = err.extensions;
  return (
    (Array.isArray(partial) && partial.length > 0) || tokens !== undefined || usage !== undefined
  );
}

/** The partial results a typed conflict carried, or an empty list. */
export function partialResultsFromError(err: unknown): ReadonlyArray<AgentIntentResult> {
  if (!(err instanceof DriftstackError)) return [];
  const partial = err.extensions['partial_results'];
  return Array.isArray(partial) ? (partial as ReadonlyArray<AgentIntentResult>) : [];
}

/**
 * The session lifecycle the typed problem reports, or null when it reports none.
 *
 * ⛔ `paused` and `closed` are NOT the same answer and must not be merged. The
 * server says "Resume this agent session before sending another message" for a
 * paused one and "Start a new agent session" for a closed one. Telling a paused
 * session's owner to start a new one abandons a live, still-billable session and
 * loses its state — and is simply untrue. The whole reason the route publishes
 * this extension is so the two can be told apart without reading the prose.
 */
export function errorSessionStatus(err: unknown): 'closed' | 'paused' | null {
  if (!(err instanceof DriftstackError)) return null;
  const status = err.extensions['session_status'];
  return status === 'closed' || status === 'paused' ? status : null;
}

/**
 * The one sentence an interrupted turn shows.
 *
 * ⛔ Branches on the typed problem — the error class, the HTTP status and the
 * declared extensions — never on the server's wording. Everything used to
 * collapse into "The item changed or is busy", which named neither what
 * happened nor what to do about it.
 */
export function interruptedTurnReason(err: unknown): string {
  if (err instanceof BundledLlmBudgetExhaustedError) {
    return 'This turn stopped because the monthly AI spending limit was reached. Raise the limit in Settings → AI & billing, or use your own Anthropic key.';
  }
  if (err instanceof BundledLlmConsentRequiredError) {
    return 'This turn stopped because AI features need a one-time setup. Enable them, then send the message again.';
  }
  if (err instanceof ByokAnthropicRequiredError) {
    return 'This turn stopped because your Anthropic API key was missing or rejected. Add or replace it in Settings → AI & billing, then send the message again.';
  }
  if (err instanceof DriftstackError && err.kind === 'transport') {
    return 'The connection dropped while this turn was running. The steps above are what finished before it stopped.';
  }
  // An exception that is not a typed problem at all. ⛔ Never quote it: an
  // unknown throw carries internal hostnames, paths and tokens, and this string
  // is customer-visible. Say the honest little that is known.
  if (!(err instanceof DriftstackError)) {
    return 'This turn stopped before it finished. The steps above are what ran.';
  }
  const lifecycle = errorSessionStatus(err);
  if (lifecycle === 'closed') {
    return 'This chat’s session ended while the turn was running. Continue in a new session — the conversation so far carries over.';
  }
  if (lifecycle === 'paused') {
    // Paused is recoverable, and the recovery is the opposite of "start again".
    return 'This chat is paused, so the turn stopped partway. Resume it, then send the message again.';
  }
  if (err.extensions['turn_in_progress'] === true) {
    return 'Another request is still running in this chat. Wait for it to finish, then send this one again.';
  }
  if (err.extensions['ai_control_unavailable'] === true) {
    return 'Someone took over this session while the turn was running, so it stopped partway.';
  }
  if (err.extensions['idempotency_status'] === 'in_progress') {
    return 'The previous send has not finished yet. Wait for it, then try again.';
  }
  // ⛔ Only the TYPED key problems say "your key was rejected". A bare 403 on
  // this route is also how a session you do not own, and a feature the plan does
  // not include, come back — and sending that customer to replace a key that is
  // working is a wrong instruction, not just a vague one.
  if (
    err instanceof InvalidKeyError ||
    err instanceof RevokedKeyError ||
    err instanceof ExpiredKeyError ||
    err instanceof AuthError
  ) {
    return 'Your Driftstack API key was rejected. Check it in Settings, then send the message again.';
  }
  if (err.status === 429) {
    return 'The agent is being rate limited. Wait a moment, then send the message again.';
  }
  return 'This turn stopped before it finished. The steps above are what ran.';
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
  /** Per-step results for the CURRENT in-flight turn, appended live as the
   *  server streams them; empty when no turn is running. The view renders these
   *  as progress while `sending`, then the settled turn's response replaces them. */
  liveSteps: ReadonlyArray<AgentIntentResult>;
  /** Caption for the stage the in-flight turn is in, or null before the first
   *  `phase` frame (and against a server that does not send them). This is what
   *  fills the 10-30s — up to ~150s — that used to be three silent dots. */
  livePhase: string | null;
  /** The plan the in-flight turn is running, published BEFORE the first step so
   *  the customer can see the whole list greyed out while it works. Null until
   *  the plan arrives, and on a turn that never produces one. */
  livePlan: LivePlan | null;
  /** 0-based index of the step currently running, or null when none has started. */
  liveStepIndex: number | null;
  /** The read-back answer, streamed the moment the server publishes it rather
   *  than waiting for the terminal body. Null until it arrives, and on a turn
   *  that never produces one. The settled turn renders the same text, so this
   *  clears with the rest of the live progress. */
  liveAnswer: string | null;
  error: ChatError | null;
  /** The consequential action the last turn halted on (Approve/Deny), or null. */
  pendingConfirmation: PendingConfirmation | null;
  /** Turn ids the customer DENIED — the transcript marks their paused step as skipped. */
  deniedTurnIds: ReadonlySet<number>;
  /** Turn ids the customer APPROVED (on a successful re-send) — the transcript renders
   *  their paused ⏸ consequential step as past-tense "approved, ran" instead of leaving
   *  it stuck on the live "confirmation required" framing after the action already ran. */
  approvedTurnIds: ReadonlySet<number>;
  /** Resolves true when the turn succeeded, false on error — lets the caller
   *  restore the draft for a retry instead of losing the typed message. */
  send: (userMessage: string) => Promise<boolean>;
  /**
   * Whether the most recent FAILED send left the customer's message in the
   * transcript (B6 keeps it, with an interrupted agent turn beside it). A caller
   * that restores the draft on a falsey `send` must skip that restore when this
   * is true, or the same message shows twice. Stable identity and ref-backed, so
   * it is correct when called from a `send().then(...)` continuation.
   */
  lastSendKeptMessage: () => boolean;
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
  /**
   * Reopen a stored chat. `continueFromSessionId` is the server session that
   * chat last ran on: the next send carries it as
   * `continue_from_agent_session_id`, so the fresh session INHERITS that
   * transcript instead of starting blank. Omit/null when there is no prior
   * server session to inherit from.
   */
  restore: (turns: ReadonlyArray<ChatTurn>, continueFromSessionId?: string | null) => void;
  /** Try to reattach a reopened chat to the server session that produced it.
   *  No-ops unless that session is still `active`. Safe to call unconditionally
   *  — it drops its own answer if the customer moves on while it is in flight. */
  adopt: (sessionId: string) => void;
  /** True while an `adopt` is in flight. The view holds the "continuing starts
   *  a fresh session" divider back until this settles, because until the GET
   *  answers we do not yet know whether that sentence is true.
   *
   *  (l) #12 — and it STAYS true when the GET failed for a reason other than
   *  404 (`adoptError` is set): the session may still be live, and a send in
   *  that state would create a session `continue_from` a live one — the 409
   *  the adopting gate exists to prevent. Only a 404 (closed, reaped,
   *  cross-account) settles it false without a session. */
  adopting: boolean;
  /** (l) #12 — the notice when the reattach could not be answered (offline
   *  blip, 5xx, timeout): null while it is in flight or settled. `adopt()` the
   *  same session again to retry; a new chat (`reset`/`restore`) clears it. */
  adoptError: string | null;
  /** Count of leading turns that were RESTORED from saved history and are NOT
   *  backed by the (now-absent) live server session. While > 0 and there is no
   *  live session, continuing the chat starts a FRESH server session that won't
   *  remember these turns — the view shows an honest divider after them. Cleared
   *  once a new live session is created (or on reset/new-chat). */
  restoredHistoryCount: number;
  /** The persisted server session id a reopened chat is continuing (the id it last
   *  ran on), exposed so the view can fetch that chat's captures from it while there
   *  is no live session — the server serves captures for a closed session until
   *  TTL/LRU eviction. Null for a new chat, or once the chat is adopted live. */
  restoredSessionId: string | null;
}

/**
 * Whether a reopened chat may reattach to the session that produced it.
 *
 * Pure and exported so all three outcomes are testable without a hook harness —
 * the same shape as `extractPendingConfirmation` below it.
 *
 * ⛔ `'stale'` is not a defensive extra. `restore()` bumps the cancel
 * generation, so a GET issued for chat A can land after the customer has opened
 * chat C. Adopting then would bind C's view to A's server session — the same
 * class as the wrong-chat attach that made the earlier P0 reachable.
 *
 * ⛔ `'not-active'` covers `paused` AND `closed`, and **`resume` cannot rescue
 * either**: the server rejects any non-active session with a 409
 * (`agent-sessions.ts`, `if (rec.status !== 'active')`), and a harness
 * challenge-pause does not move `status` off `'active'` in the first place. So
 * there is no second chance to try here — the honest divider is the answer.
 */
export function adoptionOutcome(
  status: AgentSession['status'],
  generationMoved: boolean,
): 'adopt' | 'stale' | 'not-active' {
  // Order matters: a stale answer must be discarded even when it says 'active',
  // because the question it answers is no longer the one on screen.
  if (generationMoved) return 'stale';
  return status === 'active' ? 'adopt' : 'not-active';
}

/** (l) #12 — the reattach notice the view shows beside a held Send. */
export const ADOPT_FAILED_NOTICE =
  'Couldn’t reattach to the previous session — check your connection and try again.';

/** (l) #12 — a 404 from the reattach GET: the SDK's NotFoundError (and any
 *  problem+json error) carries its HTTP status; nothing else is a 404. A bare
 *  network failure has no status and is NOT one — the session may be live. */
export function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

export function useAgentChat(opts: UseAgentChatOpts = {}): UseAgentChatResult {
  const { client } = useSettings();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sending, setSending] = useState(false);
  // Live per-step progress for the CURRENT in-flight turn — appended as the
  // server streams `event: step` frames, cleared when the turn settles (the
  // final turn's `response.results` then render in its place). #streaming.
  const [liveSteps, setLiveSteps] = useState<AgentIntentResult[]>([]);
  // B2 — the additive progress stream. Each of these is fed by an SSE frame the
  // server may or may not send, so every one defaults to "unknown" and the view
  // degrades to the old spinner rather than to a wrong claim.
  const [livePhase, setLivePhase] = useState<string | null>(null);
  const [livePlan, setLivePlan] = useState<LivePlan | null>(null);
  const [liveStepIndex, setLiveStepIndex] = useState<number | null>(null);
  const [liveAnswer, setLiveAnswer] = useState<string | null>(null);
  // The live steps mirrored into a ref. The catch below needs the steps THIS
  // turn streamed, and the `liveSteps` it can see through the closure is the
  // value from the render that started the send — i.e. empty.
  const liveStepsRef = useRef<ReadonlyArray<AgentIntentResult>>([]);
  const clearLiveProgress = useCallback((): void => {
    liveStepsRef.current = [];
    setLiveSteps([]);
    setLivePhase(null);
    setLivePlan(null);
    setLiveStepIndex(null);
    setLiveAnswer(null);
  }, []);
  // B6 — set when a failed send LEFT the customer's message on screen (as its
  // own turn plus an interrupted agent turn). A ref, because the caller reads it
  // from a `send().then(...)` continuation where any render value is stale.
  const keptMessageOnErrorRef = useRef(false);
  const [error, setError] = useState<ChatError | null>(null);
  // Latest live session id, mirrored into a ref so the close-on-unmount cleanup
  // (which can't depend on `session` without re-subscribing every turn) and the
  // reset/restore handlers can best-effort close the PRIOR server session before
  // dropping it locally. Without this, every "New chat" / chat-switch / view-
  // leave abandons the old agent session (and any dispatched Mac) to the idle
  // reaper — a cost + fleet-slot leak that can hit the per-account active cap.
  const sessionIdRef = useRef<string | null>(null);
  /** The CLOSED session a reopened chat is continuing, consumed by the next
   *  create and then cleared — continuing is a one-shot per reopen, not a
   *  property of the chat. Null for a new chat or one already adopted live. */
  const continueFromRef = useRef<string | null>(null);
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
  const closeServerSession = useCallback(
    (
      sid: string | null,
      /** The client to close THROUGH. Defaults to the current one; the
       *  sign-out teardown passes the OUTGOING client, because by the time it
       *  runs `clientRef` already holds the new one (null when signed out) and
       *  the DELETE would simply be skipped. */
      via?: DriftstackClient | null,
    ): void => {
      if (sid === null) return;
      const c = via === undefined ? clientRef.current : via;
      if (c === null || typeof c.agentSessions?.close !== 'function') return;
      try {
        void Promise.resolve(c.agentSessions.close(sid)).catch(() => undefined);
      } catch {
        // A synchronous throw from close() is also non-fatal here.
      }
    },
    [],
  );
  // The turn id whose confirmation the customer already approved/denied — hides
  // the gate so it doesn't re-prompt for an action they've already resolved.
  const [resolvedTurnId, setResolvedTurnId] = useState<number | null>(null);
  // Turn ids the customer explicitly DENIED (a subset of resolved) — the transcript
  // marks their paused ⏸ consequential step as denied/skipped rather than stuck-waiting.
  const [deniedTurnIds, setDeniedTurnIds] = useState<ReadonlySet<number>>(() => new Set());
  // Turn ids the customer explicitly APPROVED (a subset of resolved) — the transcript
  // renders their paused ⏸ consequential step as past-tense "approved, ran" once the
  // re-send succeeds, rather than leaving it stuck on the live "confirmation required"
  // framing forever. Mirrors deniedTurnIds. Cleared on reset()/restore().
  const [approvedTurnIds, setApprovedTurnIds] = useState<ReadonlySet<number>>(() => new Set());
  // The persisted (continue-from) server session a reopened chat is continuing, mirrored
  // from continueFromRef into render state so the view can address that chat's captures by
  // the persisted id while session===null. Set on restore(), cleared on reset().
  const [restoredSessionId, setRestoredSessionId] = useState<string | null>(null);
  // Leading turns that came from a restore and aren't backed by a live server
  // session (see restore()). Drives the view's honest "continuing starts a new
  // session" divider. Cleared once a fresh session is created on the next send.
  const [restoredHistoryCount, setRestoredHistoryCount] = useState(0);
  // (l) #17 — how many leading turns the Approve/Deny gate must NOT read a halt
  // from. Set with `restoredHistoryCount` on restore(); cleared when a fresh
  // session is created (its transcript grows from there) and when an adopt()
  // attaches a live session AND could seed `lastUserMessage` from the restored
  // turns — then Approve re-sends that message against the adopted session,
  // which is the live state the bar claims. Kept when nothing could be seeded:
  // a bar whose Approve is a silent no-op is worse than no bar.
  const [restoredGateFloor, setRestoredGateFloor] = useState(0);
  // The user message that produced the current turn — re-sent verbatim on
  // approve() so the executor re-plans + dispatches the now-approved action.
  const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);
  /** (l) #17 — the last restored USER turn's text, for an adopt() to seed
   *  `lastUserMessage` from (restore() nulls it, and adopt() runs in a
   *  `[]`-deps callback that cannot read `turns`). */
  const restoredUserSeedRef = useRef<string | null>(null);
  /** (l) #12 — set when the reattach GET failed for a non-404 reason. */
  const [adoptError, setAdoptError] = useState<string | null>(null);
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
  // One durable server receipt key per exact logical turn. The SSE connection can
  // disappear while the server deliberately finishes browser work, so a retry of
  // the same session/message/approval body MUST reuse this key. A changed body or
  // session gets a fresh key; a confirmed terminal success clears it. Stop keeps
  // it because Stop is only a local soft-cancel and the server may still finish.
  const pendingTurnReceiptRef = useRef<{ signature: string; key: string } | null>(null);
  // React's `sending` state is visual feedback, not a synchronous admission
  // boundary. Keep one authoritative post owner so rapid Send/Approve events
  // cannot duplicate session creation, device work, optimistic turns or billing.
  // Identical callers join the same outcome; a different logical turn is
  // refused until the owner settles or an explicit Stop/reset/restore releases it.
  const activePostRef = useRef<{
    token: symbol;
    signature: string;
    promise: Promise<boolean>;
  } | null>(null);
  // Consequential-action approvals ACCUMULATED across successive halts of the SAME
  // logical task. The server re-decomposes on every message and builds its approved
  // set purely from THAT message's approve_consequential_actions (stateless — it does
  // not persist prior approvals). A plan with 2+ consequential actions halts on each
  // in turn; if approve() sent only the LATEST approval, the server would re-halt on an
  // already-approved earlier action → an infinite approve loop that never completes (and
  // re-bills each turn). So approve() appends to this list and re-sends ALL of them.
  // Reset on a genuinely-new user message (a fresh task) + on reset()/restore().
  const approvedActionsRef = useRef<
    Array<{ category: ConsequentialActionCategory; matchedText: string }>
  >([]);
  // Soft cancel — Stop bumps this; an in-flight post that captured an older
  // generation discards its result on resolve. (UI stop; the server turn may
  // still complete — a true network/turn abort is a follow-up.)
  const cancelGenRef = useRef(0);
  const [adopting, setAdopting] = useState(false);
  const cancel = useCallback(() => {
    cancelGenRef.current += 1;
    activePostRef.current = null;
    setSending(false);
    // Drop live progress now: cancel short-circuits the in-flight post()'s finally
    // (it nulls activePostRef), so the settle-clear there won't run for this turn.
    clearLiveProgress();
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

  /**
   * Reattach a reopened chat to its own still-running server session.
   *
   * ⛔ Adoption is allowed ONLY on `status === 'active'`. `resume` is not a
   * revival path: `agent-sessions.ts` rejects any non-active session with a
   * 409, and a harness challenge-pause does not change `status` anyway. A
   * `paused` or `closed` session therefore keeps the honest divider.
   *
   * The generation check is not defensive padding — `restore()` bumps
   * `cancelGenRef`, so an answer arriving after the customer has opened a third
   * chat is detected and dropped rather than attaching this session to whatever
   * is on screen. Same guard the in-flight post uses.
   */
  const adopt = useCallback((sid: string): void => {
    const gen = cancelGenRef.current;
    const c = clientRef.current;
    if (c === null || typeof c.agentSessions?.get !== 'function') return;
    setAdopting(true);
    setAdoptError(null);
    // (l) #12 — the GET is tried twice before the reattach is given up: a
    // single offline blip or 5xx must not strand a live session behind a
    // "try again" the customer has to notice. A 404 is never retried.
    const attempt = (retriesLeft: number): Promise<void> =>
      Promise.resolve(c.agentSessions.get(sid)).then(
        (s) => {
          if (adoptionOutcome(s.status, cancelGenRef.current !== gen) !== 'adopt') return;
          // The chat is still LIVE, so there is nothing to continue from — clear the
          // pending source or the next send would fork a session we already hold.
          continueFromRef.current = null;
          setSession(s);
          // The adopted session's own transcript holds these turns, so they are
          // no longer history the agent cannot see.
          setRestoredHistoryCount(0);
          // (l) #17 — a restored halt is now the LAST turn of a live session.
          // Approve re-sends the message that produced it (with the approval),
          // so seed that message from the restored turns; only then may the
          // gate read the halt — otherwise Approve would be a silent no-op.
          const seed = restoredUserSeedRef.current;
          setLastUserMessage(seed);
          if (seed !== null) setRestoredGateFloor(0);
        },
        (err: unknown) => {
          if (cancelGenRef.current !== gen) return;
          // A 404 (closed, reaped, or cross-account) is the ordinary case for an
          // old chat, not an error worth showing. The divider already says the truth.
          if (isNotFoundError(err)) return;
          if (retriesLeft > 0) return attempt(retriesLeft - 1);
          // (l) #12 — anything else says NOTHING about whether the session is
          // live. Falling through used to clear `adopting` with continueFromRef
          // still naming the session, and the next send created a session
          // `continue_from` a live one — the 409 ("The item changed or is
          // busy") the adopting gate was added to stop. Stay adopting (Send
          // held) and say so; the view offers a retry.
          setAdoptError(ADOPT_FAILED_NOTICE);
          throw err;
        },
      );
    void attempt(1)
      .then(() => {
        if (cancelGenRef.current === gen) setAdopting(false);
      })
      .catch(() => undefined);
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
    ): Promise<boolean> => {
      if (!client) {
        setError({ message: 'Not connected — set your API key in Settings.' });
        return false;
      }
      const approvals = options?.approvals;
      const callSignature = JSON.stringify({
        userMessage,
        approvals: approvals ?? null,
        appendUserTurn: options?.appendUserTurn !== false,
      });
      const activePost = activePostRef.current;
      if (activePost !== null) {
        return activePost.signature === callSignature ? activePost.promise : false;
      }
      const ownerToken = Symbol('agent-chat-post');
      let settleJoined!: (ok: boolean) => void;
      const joinedPromise = new Promise<boolean>((resolve) => {
        settleJoined = resolve;
      });
      activePostRef.current = {
        token: ownerToken,
        signature: callSignature,
        promise: joinedPromise,
      };
      let outcome = false;
      keptMessageOnErrorRef.current = false;
      // The receipt key this send actually issued, readable from the catch. Null
      // when the failure happened before one was minted (e.g. session create).
      let issuedReceiptKey: string | null = null;
      setSending(true);
      setError(null);
      // Capture this send's cancel-generation; if Stop bumps it before we
      // resolve, the result is discarded (the user moved on).
      const gen = cancelGenRef.current;
      let appendedUserTurnId: number | null = null;
      if (options?.appendUserTurn !== false) {
        // A genuinely-new user message starts a FRESH task — drop any consequential
        // approvals accumulated for the previous one (approve() re-sends with
        // appendUserTurn:false, so it never clears these).
        approvedActionsRef.current = [];
        // Append the user turn immediately for responsiveness.
        appendedUserTurnId = nextId();
        const uid = appendedUserTurnId;
        setTurns((t) => [...t, { id: uid, role: 'user', text: userMessage }]);
        // P2 #9 — record it so Stop can remove this exact dangling bubble even if
        // the request hangs forever (the rollback below only fires on resolve).
        inFlightUserTurnIdRef.current = uid;
      }
      setLastUserMessage(userMessage);
      // Fresh turn → clear any progress left visible from a prior one.
      clearLiveProgress();
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
            // V-2161 — carry the reopened chat's transcript into this new session so
            // the agent still has the conversation. Server-side the source must be
            // owned and closed; an unknown/foreign id is a 404 and a still-live one a
            // 409, both handled by the catch below like any other create failure.
            ...(continueFromRef.current !== null
              ? { continue_from_agent_session_id: continueFromRef.current }
              : {}),
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
          // Defensive, and honestly labelled as such: both paths that can null `session`
          // — reset() and restore() — set this ref themselves, so today no second create
          // can reach a stale source and a mutation of this line survives every test. It
          // stays because a THIRD path that clears the session without touching the ref
          // would otherwise seed the same transcript twice; what stops that today is
          // session reuse (one create per chat), which IS pinned.
          const continuedFrom = continueFromRef.current;
          continueFromRef.current = null;
          setSession(created);
          // The carried turns are the new session's own transcript now, so the honest
          // "the agent can't see these" divider no longer applies to them.
          if (continuedFrom !== null) setRestoredHistoryCount(0);
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
          setRestoredGateFloor(0);
          sid = created.id;
        }
        const turnSignature = JSON.stringify({
          session_id: sid,
          user_message: userMessage,
          approve_consequential_actions:
            approvals !== undefined && approvals.length > 0 ? approvals : null,
        });
        const priorReceipt = pendingTurnReceiptRef.current;
        const turnReceipt =
          priorReceipt !== null && priorReceipt.signature === turnSignature
            ? priorReceipt
            : { signature: turnSignature, key: crypto.randomUUID() };
        pendingTurnReceiptRef.current = turnReceipt;
        issuedReceiptKey = turnReceipt.key;
        const response = await client.agentSessions.message(sid, userMessage, {
          idempotencyKey: turnReceipt.key,
          ...(approvals !== undefined && approvals.length > 0
            ? { approveConsequentialActions: approvals }
            : {}),
          // Live progress: reflect each step as it lands, but only for THIS send
          // (a soft-Stop bumps the gen, and its late frames must not leak into a
          // newer turn's view).
          onStep: (step) => {
            if (cancelGenRef.current !== gen) return;
            liveStepsRef.current = [...liveStepsRef.current, step.result];
            setLiveSteps((prev) => [...prev, step.result]);
          },
          // B2 — everything the server can say BEFORE a step result exists.
          // ⛔ Unknown event names fall through silently on purpose: the set is
          // open, and a build that treats a new name as an error breaks itself
          // against a server that is working correctly.
          onEvent: (event) => {
            if (cancelGenRef.current !== gen) return;
            if (event.type === 'phase') {
              const phase = (event.data as { phase?: unknown } | null)?.phase;
              // An unrecognised phase leaves the caption as it was rather than
              // blanking a truthful one or showing a raw token.
              if (typeof phase === 'string') {
                const caption = phaseCaption(phase);
                if (caption !== null) setLivePhase(caption);
              }
              return;
            }
            if (event.type === 'plan') {
              const data = event.data as { total?: unknown; labels?: unknown } | null;
              const labels = Array.isArray(data?.labels)
                ? data.labels.filter((l): l is string => typeof l === 'string')
                : [];
              const total = typeof data?.total === 'number' ? data.total : labels.length;
              if (labels.length > 0) setLivePlan({ labels, total });
              return;
            }
            if (event.type === 'step_start') {
              const index = (event.data as { index?: unknown } | null)?.index;
              if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
                setLiveStepIndex(index);
              }
              return;
            }
            if (event.type === 'answer') {
              // The whole reason the server streams the answer at all: the one
              // thing the customer asked for lands as soon as it is published,
              // instead of waiting on the terminal body behind it. The settled
              // turn renders the same text, so this is a preview, not a second
              // copy — `clearLiveProgress` drops it on the hand-off.
              const answer = (event.data as { answer?: unknown } | null)?.answer;
              if (typeof answer === 'string' && answer.length > 0) setLiveAnswer(answer);
            }
          },
        });
        if (cancelGenRef.current !== gen) {
          rollbackUserTurn(); // user hit Stop — discard the reply + the orphan bubble
          return false;
        }
        // A terminal success (fresh or replayed) removes the ambiguity. Only clear
        // this exact receipt: a different send may have started after a soft Stop.
        // ⛔ This MUST stay BELOW the cancel-generation check: a turn that resolves
        // successfully AFTER Stop is discarded (the gen moved), and the server may have
        // deliberately finished the browser work — so clearing the key here would let an
        // identical re-send re-execute + re-bill instead of replaying under the same key.
        // Only a confirmed, non-cancelled success clears it, matching the catch path that
        // already preserves the receipt on Stop.
        if (pendingTurnReceiptRef.current?.key === turnReceipt.key) {
          pendingTurnReceiptRef.current = null;
        }
        setSession(response.session);
        // P2 #9 — the turn completed (an agent reply now backs the user bubble), so
        // the bubble is no longer "dangling" — clear the in-flight marker.
        inFlightUserTurnIdRef.current = null;
        setTurns((t) => [...t, { id: nextId(), role: 'agent', response }]);
        outcome = true;
        return true;
      } catch (err) {
        if (cancelGenRef.current !== gen) {
          // Cancelled. The customer moved on, so the orphan bubble goes and the
          // error is not theirs to see.
          rollbackUserTurn();
          return false;
        }
        // B4 — a typed terminal proves the server settled this turn, so the
        // durable receipt is SPENT. Leaving it set made the next Send replay the
        // same stored failure under the same key, forever — including the Send
        // right after the customer fixed the cause. A transport failure is the
        // opposite case and deliberately keeps the key, so a real retry is still
        // idempotent. Decided on the problem TYPE, never on its wording.
        if (
          turnReceiptIsSpent(err) &&
          // Only ever clear THIS send's receipt: a different logical turn may
          // have replaced it after a soft Stop.
          issuedReceiptKey !== null &&
          pendingTurnReceiptRef.current?.key === issuedReceiptKey
        ) {
          pendingTurnReceiptRef.current = null;
        }
        // B6 — keep the customer's message and everything that actually ran.
        // Rolling the message back and wiping the steps erased real, billed
        // browser work and left a bare banner in its place. The user bubble
        // stays put (so the composer's draft restore is suppressed below), and
        // the partial run is appended as an interrupted agent turn.
        const partialFromServer = partialResultsFromError(err);
        const ranSteps = partialFromServer.length > 0 ? partialFromServer : liveStepsRef.current;
        if (appendedUserTurnId !== null) inFlightUserTurnIdRef.current = null;
        setTurns((t) => [
          ...t,
          {
            id: nextId(),
            role: 'agent',
            interrupted: { reason: interruptedTurnReason(err), steps: ranSteps },
          },
        ]);
        // The interrupted turn above already says what happened and what to do;
        // see bannerForFailedTurn for why almost nothing raises a second surface.
        setError(bannerForFailedTurn(err));
        // The message is on screen as its own turn now, so report a KEPT send:
        // restoring the draft would duplicate the bubble the customer can see.
        keptMessageOnErrorRef.current = true;
        return false;
      } finally {
        settleJoined(outcome);
        if (activePostRef.current?.token === ownerToken) {
          activePostRef.current = null;
          if (cancelGenRef.current === gen) {
            setSending(false);
            // Hand off from the transient live progress to the settled turn
            // (whose response.results now render). On an error the steps have
            // ALREADY been moved into an interrupted turn above, so clearing
            // here no longer loses them.
            clearLiveProgress();
          }
        }
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

  const lastSendKeptMessage = useCallback((): boolean => keptMessageOnErrorRef.current, []);

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
      // (l) #17 — the floor is its own state, not `session === null &&
      // restoredHistoryCount`: an adopt() attaches a live session and zeroes
      // the count, which used to remove BOTH halves of the guard while the
      // restored halt (and the nulled lastUserMessage) stayed — the same dead
      // Approve, now on a live session. The floor clears only where Approve
      // can act: a fresh session, or an adopt that seeded the message.
      if (i < restoredGateFloor) return null;
      if (turn.id === resolvedTurnId) return null;
      const pc = extractPendingConfirmation(turn.response);
      return pc === null
        ? null
        : { turnId: turn.id, category: pc.category, matchedText: pc.matchedText };
    }
    return null;
  }, [turns, resolvedTurnId, restoredGateFloor]);

  const approve = useCallback(async (): Promise<void> => {
    if (pendingConfirmation === null || lastUserMessage === null) return;
    const turnId = pendingConfirmation.turnId;
    // Accumulate this approval on top of any earlier ones for the same task (dedup by
    // category+matchedText) and re-send ALL of them — otherwise a plan with 2+
    // consequential actions loops: the server, re-decomposing from only the latest
    // approval, re-halts on an already-approved earlier action forever.
    const { category, matchedText } = pendingConfirmation;
    const already = approvedActionsRef.current.some(
      (a) => a.category === category && a.matchedText === matchedText,
    );
    if (!already)
      approvedActionsRef.current = [...approvedActionsRef.current, { category, matchedText }];
    // Robustness fix: resolve the gate only AFTER the re-send actually succeeds.
    // Setting resolvedTurnId up front dismissed the Approve/Deny bar permanently
    // (pendingConfirmation memoises to null once turn.id === resolvedTurnId), so a
    // failed re-send (e.g. 503) stranded the customer — the gate vanished, the just-
    // added approvedActionsRef entry was orphaned, and re-approving was impossible;
    // they'd have to retype the message (re-decompose + re-bill). On failure we
    // instead leave the gate up and pop the entry we just appended so a retry is clean.
    const ok = await post(lastUserMessage, {
      approvals: approvedActionsRef.current,
      appendUserTurn: false,
    });
    if (ok) {
      setResolvedTurnId(turnId);
      // Record the turn as APPROVED so its paused ⏸ step re-renders past-tense
      // ("approved, ran") instead of staying stuck on "confirmation required".
      // Mirrors deny()'s deniedTurnIds; only set ON SUCCESS (a failed re-send leaves
      // the gate up for a clean retry, above).
      setApprovedTurnIds((prev) => {
        const next = new Set(prev);
        next.add(turnId);
        return next;
      });
    } else if (!already) {
      // The re-send failed and we had appended this approval — remove it so the next
      // Approve re-appends cleanly (idempotent whether or not it's still the tail).
      approvedActionsRef.current = approvedActionsRef.current.filter(
        (a) => !(a.category === category && a.matchedText === matchedText),
      );
    }
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

  /**
   * Everything reset() drops LOCALLY, with no server call.
   *
   * Split out so the sign-out teardown can reuse it verbatim: that path has to
   * close through the OUTGOING client, so it cannot simply call reset() (whose
   * close goes through the current one, which by then is the new account's — or
   * null). Two copies of this list would drift, and the half that drifted would
   * be the one that leaves another account's transcript on screen.
   */
  const clearLocalChatState = useCallback((): void => {
    // A new chat inherits nothing: drop any pending continue-source so New chat
    // cannot resurrect the transcript of the chat being left.
    continueFromRef.current = null;
    // Bump the cancel-generation so any in-flight post() for the PREVIOUS chat
    // discards its result on resolve instead of writing the response onto this
    // fresh chat's transcript + session (audit wja3dfl5t P0). Same for restore().
    cancelGenRef.current += 1;
    activePostRef.current = null;
    // Bumping the cancel generation invalidates any in-flight adopt(), so its
    // `adopting` flag no longer describes anything — clear it here (a following
    // synchronous adopt() re-sets it true). Otherwise a stale-generation adopt
    // leaves it stuck true and suppresses the honest restored-history divider.
    setAdopting(false);
    setAdoptError(null);
    setSending(false);
    clearLiveProgress();
    setTurns([]);
    setSession(null);
    setError(null);
    setResolvedTurnId(null);
    setDeniedTurnIds(new Set());
    setApprovedTurnIds(new Set());
    approvedActionsRef.current = [];
    pendingTurnReceiptRef.current = null;
    setLastUserMessage(null);
    restoredUserSeedRef.current = null;
    setRestoredHistoryCount(0);
    setRestoredGateFloor(0);
    setRestoredSessionId(null);
  }, [clearLiveProgress]);

  const reset = useCallback((): void => {
    // Best-effort close the chat we're leaving so its server session + any
    // dispatched Mac don't leak until the reaper (sweep2). Read via the ref so we
    // close the CURRENT session, not a stale closure capture.
    if (sessionIdRef.current !== null) clearProfileBinding(profileIdRef.current);
    closeServerSession(sessionIdRef.current);
    clearLocalChatState();
  }, [closeServerSession, clearProfileBinding, clearLocalChatState]);

  /**
   * ⛔ THE AUTH BOUNDARY tears the chat down — unmount no longer does.
   *
   * The chat was lifted above the view switch so leaving the AI view stops
   * killing a running task. But it thereby also sits above SIGN-OUT:
   * `handleSignOut` only nulls the API key, which makes the shell early-return
   * the first-run wizard WITHOUT unmounting anything above it. So the unmount
   * teardown — the only thing that closed the live session — stopped running on
   * the one gesture the product treats as "end everything". Left alone that is a
   * session + Mac leak against the account cap, a profile stuck "running", and
   * one account's transcript still on screen for whoever signs in next.
   *
   * The boundary is the CLIENT IDENTITY, not a key string: `buildClient` returns
   * null with no key and a fresh object per key / deployment / workspace, so
   * this covers sign-out, a re-sign-in with a different key, and a workspace
   * switch alike. The close goes through the OUTGOING client, which still holds
   * the credential the DELETE needs.
   */
  const authClientRef = useRef(client);
  useEffect(() => {
    const outgoing = authClientRef.current;
    if (outgoing === client) return;
    authClientRef.current = client;
    // Nothing to tear down — the first key arriving after settings load takes
    // this path, and churning state there would be noise, not safety.
    if (sessionIdRef.current === null && turns.length === 0) return;
    const staleSession = sessionIdRef.current;
    if (staleSession !== null) clearProfileBinding(profileIdRef.current);
    closeServerSession(staleSession, outgoing);
    clearLocalChatState();
  }, [client, turns.length, clearLocalChatState, closeServerSession, clearProfileBinding]);

  const restore = useCallback(
    (restoredTurns: ReadonlyArray<ChatTurn>, continueFromSessionId?: string | null): void => {
      // Invalidate any in-flight post() from the chat we're switching AWAY from, so
      // its late response can't attach to (and persist onto) the restored chat.
      cancelGenRef.current += 1;
      activePostRef.current = null;
      // The generation bump invalidates any in-flight adopt() (for the chat we're
      // leaving), so its `adopting` flag is stale — clear it. handleSelectChat calls
      // restore() then a synchronous adopt(), which re-sets it true, preserving order.
      setAdopting(false);
      setAdoptError(null);
      // Best-effort close the chat we're switching AWAY from (same leak as reset).
      if (sessionIdRef.current !== null) clearProfileBinding(profileIdRef.current);
      closeServerSession(sessionIdRef.current);
      setSending(false);
      clearLiveProgress();
      setTurns([...restoredTurns]);
      // Drop the live session: continuing a reopened chat starts a FRESH server
      // session (the prior one is gone / now closed) and the run-loop rebuilds
      // history from the SERVER transcript.
      //
      // ⭐ V-2161 — that fresh session no longer starts blank. Remember the session
      // this chat last ran on; the next send passes it as
      // `continue_from_agent_session_id` and the server carries its transcript
      // across. That is what makes a reopened chat still have its memory, instead
      // of the agent answering "I don't have a previous task on record in this
      // session" (owner 2026-08-30). A chat with no prior session id is unchanged.
      const continueFrom =
        typeof continueFromSessionId === 'string' && continueFromSessionId !== ''
          ? continueFromSessionId
          : null;
      continueFromRef.current = continueFrom;
      // Mirror the persisted session id into render state so the view can fetch this
      // reopened chat's captures from it while there is no live session (LOW #9 — the
      // thumbnail was handed the null live id and showed "Screenshot unavailable").
      setRestoredSessionId(continueFrom);
      setSession(null);
      setError(null);
      setResolvedTurnId(null);
      pendingTurnReceiptRef.current = null;
      // Clear denied ids too (mirroring reset()) — restore() rebases idRef into the
      // low id space, so a stale denied id from the chat we're leaving (e.g. 3) would
      // otherwise false-mark the restored chat's own turn id 3 as "denied — skipped".
      setDeniedTurnIds(new Set());
      setApprovedTurnIds(new Set());
      approvedActionsRef.current = [];
      setLastUserMessage(null);
      // (l) #17 — remembered for an adopt() that attaches this chat's live
      // session: Approve on a restored halt re-sends THIS message.
      restoredUserSeedRef.current =
        [...restoredTurns].reverse().find((t) => t.role === 'user')?.text ?? null;
      // Mark every restored turn as history the (absent) live session won't
      // remember, so the view can draw the honest "continuing starts a new
      // session" divider after them.
      setRestoredHistoryCount(restoredTurns.length);
      setRestoredGateFloor(restoredTurns.length);
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
    liveSteps,
    livePhase,
    livePlan,
    liveStepIndex,
    liveAnswer,
    error,
    pendingConfirmation,
    deniedTurnIds,
    approvedTurnIds,
    send,
    lastSendKeptMessage,
    approve,
    deny,
    reset,
    restore,
    adopt,
    adopting,
    adoptError,
    cancel,
    restoredHistoryCount,
    restoredSessionId,
  };
}
