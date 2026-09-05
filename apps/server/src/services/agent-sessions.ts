// AI-A — agent-sessions persistence contract shared by the production
// Drizzle/PostgreSQL repository and the in-memory test/dev implementation.
// Both chat-UI consumers (AI-C) and the executor (AI-B2) depend on this one
// interface; migration 0107 adds its internal monotonic authority epoch
// without widening the public AgentSession record.
//
// Design source of truth: `docs/internal/ai-chat-agent-layer-design.md`
// (in-repo) + Wave 1119+ founder verdict moving AI-CHAT from v1.1 → v1.0
// launch arc (per the V-361 framing comment in agent-decomposer.ts).
//
// The authority epoch is intentionally internal: callers capture it through a
// narrow non-decrypting snapshot and use revision-guarded transcript/close
// writes, while public API/SDK resource shapes remain unchanged.

import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_AGENT_MODEL, type AgentModel } from '@driftstack/api-types';
import { ProfileInUseError } from '../lib/errors.js';
import type { TranscriptEntry } from './agent-decomposer.js';
import { projectProfileActivity, type ProfileActivity } from './profile-activity.js';
import { z } from 'zod';

export type AgentSessionStatus = 'active' | 'paused' | 'closed';

/**
 * Arc 2 sub-slice 8.2 (v2-#8) — operational mode for the agent
 * session. 'ai' (the default) keeps the legacy decompose-driven
 * behaviour. 'manual' makes AgentRuntime.runTurn pass-through —
 * the human drives intents directly (sub-slice 8.6). 'pair' enables
 * the takeover state-machine (sub-slice 8.7) so a human can interrupt
 * an AI-driven run mid-flight.
 */
export type AgentSessionMode = 'manual' | 'ai' | 'pair';

export const AgentSessionErrorEventSchema = z.object({
  timestamp: z.string().min(1).max(64),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  severity: z.enum(['info', 'warn', 'error', 'fatal']),
  summary: z.string().max(4096),
  detail: z
    .string()
    .max(16 * 1024)
    .nullable(),
  customerActionable: z.boolean(),
  retryable: z.boolean(),
});
export type AgentSessionErrorEvent = z.infer<typeof AgentSessionErrorEventSchema>;

export interface AgentSessionRecord {
  /** `agt_<uuid>` id; minted by the repo on create. */
  id: string;
  accountId: string;
  /**
   * Optional /v1/sessions session id that this agent-session is
   * driving. NULL when the agent-session is still in pre-plan
   * phase (the customer hasn't reached for the harness yet — chat
   * is happening but no browser session is open). The intent
   * executor (AI-B2 follow-up) is what attaches a session id.
   */
  driftstackSessionId: string | null;
  status: AgentSessionStatus;
  transcript: ReadonlyArray<TranscriptEntry>;
  /**
   * Per-session token-budget cap, derived from the customer's tier
   * (B3 design slice) at create-time. Stored on the record so the
   * decomposer doesn't need to re-resolve tier on each turn.
   */
  tokenBudgetTotal: number;
  tokenBudgetRemaining: number;
  /** Reason set by `closeWithReason` (refused / budget-exhausted /
   *  customer-closed / fatal-error). NULL on active sessions. */
  closedReason: string | null;
  /**
   * v2-#9 + v2-#19 — Stripe-pattern idempotency key.
   * NULL when the caller didn't pass an `Idempotency-Key` header on
   * POST /v1/agent-sessions. Repo enforces (account_id, idempotency_key)
   * uniqueness via the partial unique index from migration 0047. Lookup
   * via `findByIdempotencyKey` is what the route layer uses to replay a
   * prior 201 response on retry instead of minting a duplicate row.
   */
  idempotencyKey: string | null;
  /**
   * v2-#9 + v2-#19 — team-RBAC attribution. NULL when the auth context
   * is account-scoped (no specific team member id resolvable). Populated
   * by the route layer once V-298 team-membership auth lands; today it
   * stays NULL for password / OAuth account-scoped sessions.
   */
  createdByUserId: string | null;
  /**
   * v2-#9 + v2-#19 — wall-clock timestamp the session transitioned out
   * of `active` status. Distinct from `updatedAt`, which moves on every
   * transcript append. NULL while the session is active.
   */
  closedAt: Date | null;
  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — operational mode. 'ai' on every
   * existing row (migration 0052 default). Customers / SDK pick
   * 'manual' or 'pair' at create-time.
   */
  mode: AgentSessionMode;
  /**
   * 6.c / #15 — the Claude 4.x model the AI agent runs for this session.
   * Set at create-time (defaults to DEFAULT_AGENT_MODEL); the runtime
   * threads it into each decompose() call so the per-model cost-to-serve
   * rate (CLAUDE_MODELS) applies. agent_sessions.model column (0066).
   */
  model: AgentModel;
  /**
   * 2026-06-19 (migration 0086) — which fleet node this session was dispatched
   * to (the FleetControlRegistry key == the authed JWT iss / config.env
   * NODE_ID). Set by `setNodeId` when the sessionAssign is dispatched; NULL
   * until then (and on every no-fleet-CP / prod row). The worker-disconnect
   * reaper closes a node's active sessions by this pointer.
   */
  nodeId: string | null;
  /**
   * 2026-06-25 (migration 0089) — the profile this session is running, or NULL
   * for an ephemeral (no-profile) session. Set at create-time from the create
   * body's profile_id. The out-of-session profile trim reads it to refuse a trim
   * against a profile bound to a still-active session (R2 lost-update guard).
   */
  profileId: string | null;
  /**
   * T-6 (migration 0116) — which proxy this session was dispatched through. Set
   * at dispatch from the create's proxy_id; NULL for an operator-default egress,
   * a session that named no proxy, and every pre-column row. The live
   * capabilityReport relay reads it to attribute a measured QUIC verdict back to
   * the owned proxy. NOT a FK (the proxy may have no account_proxies row).
   */
  proxyId: string | null;
  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — pair-mode state machine discriminator
   * payload (sub-slice 8.7 will define the exact shape). NULL when
   * the session is not in pair mode, OR is in pair mode but no
   * takeover has been requested yet.
   */
  pairModeState: unknown;
  /** Latest authenticated harness error for this session. Persists after the
   * terminal status because the producer deliberately emits errorEvent second. */
  lastErrorEvent: AgentSessionErrorEvent | null;
  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — when the auto-minted 24h-TTL
   * gui_control_key expires. NULL when no key has been minted (e.g.
   * historical rows pre-migration 0052). Sub-slice 8.4 mints +
   * populates.
   */
  guiControlKeyExpiresAt: Date | null;
  /**
   * Arc 2 sub-slice 8.4 (v2-#8) — AES-256-GCM ciphertext blob for
   * the gui_control_key plaintext. NULL when no key has been minted.
   * Decrypted at the route layer via `decryptGuiControlKey` with the
   * MFA_ENCRYPTION_KEY env value.
   */
  guiControlKeyCiphertext: Buffer | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Internal, non-decrypting control-authority view. `revision` is monotonic and
 * changes exactly when status, mode, or pair-mode state changes, so an AI turn
 * cannot mistake a value-equivalent A→B→A transition for uninterrupted
 * authority. It is deliberately absent from the public session projection.
 */
export interface AgentSessionAuthoritySnapshot {
  status: AgentSessionStatus;
  mode: AgentSessionMode;
  pairModeState: unknown;
  revision: number;
}

export interface CreateAgentSessionArgs {
  accountId: string;
  tokenBudgetTotal: number;
  /**
   * Prior conversation to carry into the new session, for a chat the customer
   * is CONTINUING (`continue_from_agent_session_id`). Omitted → a fresh empty
   * transcript, which is every other create.
   *
   * ⛔ Entries, not ciphertext. The stored envelope's AAD binds
   * `{accountId, sessionId}`, so a byte-copy from the source row cannot be
   * opened under the new id — the caller decrypts with the SOURCE context and
   * the repo re-encrypts under the TARGET. Anything that skips that produces a
   * row nothing can ever read.
   */
  seedTranscript?: ReadonlyArray<TranscriptEntry>;
  /** Optional pre-attached driftstack session id (when the customer
   *  starts the agent-chat from inside an already-running session). */
  driftstackSessionId?: string;
  /**
   * v2-#19 — Stripe-pattern idempotency key. When supplied, the partial
   * unique index on (account_id, idempotency_key) ensures retries
   * collapse onto a single row. The route layer is what reads the
   * `Idempotency-Key` HTTP header + threads it here.
   */
  idempotencyKey?: string;
  /** v2-#19 — team-RBAC attribution. Set by the route layer once
   *  V-298 team-membership auth resolves a specific member id. */
  createdByUserId?: string;
  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — operational mode at create-time.
   * Defaults to 'ai' for backward compat. SDK consumers pick
   * 'manual' or 'pair' to opt into the alternate flows.
   */
  mode?: AgentSessionMode;
  /**
   * 6.c / #15 — Claude 4.x model the AI agent runs for this session.
   * Defaults to DEFAULT_AGENT_MODEL (Opus 4.7) when omitted. SDK +
   * dashboard surface the picker at create-time.
   */
  model?: AgentModel;
  /**
   * 2026-06-25 (migration 0089) — the bare profile uuid this session runs, when
   * the create carried a profile_id. Omitted for ephemeral (no-profile) sessions.
   * Lets the out-of-session profile trim detect a profile bound to a live session.
   */
  profileId?: string;
}

/**
 * Keyset page of agent sessions, newest-first on (created_at, id) desc.
 * `nextCursor` is the last row's bare `id` when more rows follow, else null —
 * the route maps it to the standard `{ data, has_more, next_cursor }` envelope,
 * exactly as /v1/sessions does (see SessionListPage).
 */
export interface AgentSessionListPage {
  items: ReadonlyArray<AgentSessionRecord>;
  nextCursor: string | null;
}

/**
 * Result of an atomic terminal transition when the caller owns downstream
 * teardown side effects only if it performed the first close.
 */
export type CloseAgentSessionResult =
  | { kind: 'closed'; session: AgentSessionRecord }
  | { kind: 'already_closed'; session: AgentSessionRecord };

export interface AgentSessionsRepo {
  create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord>;

  /**
   * Audit #8 (atomicity) — atomic "create only if the account is under the
   * per-account active-session cap". Closes the TOCTOU between a bare
   * `countActive` + `create`: N concurrent creates each read a stale count and
   * all pass the gate, overshooting the cap. The Drizzle impl serialises the
   * count+insert for the SAME account under a per-account advisory xact lock
   * (auto-released on commit/rollback; different accounts hash to different
   * keys so there's no cross-account contention). Returns `null` when already
   * at/over `cap` — the caller surfaces the standard 429 ConcurrencyLimitError.
   * Mirrors SessionsRepo.insertSessionIfUnderLimit.
   *
   * A3 finding #7 (W2979/W2980) — single-active-session-per-profile guard. When
   * `args.profileId` is set, the same atomic transaction ALSO takes a per-profile
   * advisory lock + refuses a second bind against a NON-TERMINAL (status !=
   * 'closed') session for the same profile + account, throwing ProfileInUseError
   * (the route maps it to a 409 with `active_session_id`). Two concurrent
   * profile-bound creates serialise on the profile lock so exactly one binds —
   * preventing the cross-node sealed-blob clobber. A create with no profile_id is
   * never gated (fail-safe).
   */
  createIfUnderActiveCap(
    args: CreateAgentSessionArgs,
    cap: number,
  ): Promise<AgentSessionRecord | null>;
  get(id: string): Promise<AgentSessionRecord | null>;
  /** Read only the control-authority columns; never decrypt the transcript. */
  getAuthoritySnapshot(id: string): Promise<AgentSessionAuthoritySnapshot | null>;
  listByAccount(
    accountId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<AgentSessionRecord>>;
  /**
   * Cursor-paginated list for GET /v1/agent-sessions — keyset on
   * (created_at, id) desc, so a busy account can page its full AI-session
   * history (the old `listByAccount({ limit: 100 })` capped it at 100 with no
   * cursor). `cursor` is the bare `id` of the last row on the prior page.
   */
  listPageByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<AgentSessionListPage>;
  appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord>;
  /** Append only while the row is still active. Missing/terminal rows return
   * null so a close winner remains immutable and callers can suppress SSE. */
  appendTranscriptIfActive(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord | null>;
  /**
   * Append only when the row is active and still has the exact authority
   * revision admitted for this turn. A mismatch is a safe null result.
   */
  appendTranscriptIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    entry: TranscriptEntry,
  ): Promise<AgentSessionRecord | null>;
  debitTokens(id: string, tokens: number): Promise<AgentSessionRecord>;
  /** Debit only while the row is still active. Missing/terminal rows return
   * null instead of mutating accounting after close. */
  debitTokensIfActive(id: string, tokens: number): Promise<AgentSessionRecord | null>;
  closeWithReason(id: string, reason: string): Promise<AgentSessionRecord>;
  closeWithReasonOutcome(id: string, reason: string): Promise<CloseAgentSessionResult>;
  /** Close an active row only while the admitted authority revision still owns it. */
  closeWithReasonIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    reason: string,
  ): Promise<AgentSessionRecord | null>;

  /** Atomically persist a harness error only when the reporting node is still
   * the session owner. Closed sessions are allowed because errorEvent follows
   * terminal sessionStatus on the producer. */
  recordErrorEvent(
    id: string,
    reportingNodeId: string,
    event: AgentSessionErrorEvent,
  ): Promise<AgentSessionRecord | null>;

  /** Count of an account's currently-active sessions — bounds the per-account
   *  concurrent-session cap so one account can't create unbounded rows / monopolise
   *  fleet slots (audit #8). */
  countActive(accountId: string): Promise<number>;

  /**
   * 2026-06-25 (migration 0089) — count of still-active sessions running a given
   * profile (status='active' AND profile_id=profileId). The out-of-session profile
   * trim reads it to refuse a trim against a profile bound to a live session (the
   * session would otherwise save its full, un-trimmed state back over the trimmed
   * R2 blob — a lost update). NULL profile_id never matches. Owner scoping is the
   * caller's responsibility (the trim route already 404s a foreign profile id).
   */
  countActiveForProfile(profileId: string): Promise<number>;

  /**
   * P-23 — a profile's recent navigation projected from its sessions'
   * transcripts (see services/profile-activity.ts for the projection and why it
   * is named ACTIVITY). Account-scoped AND profile-scoped: the route 404s a
   * foreign profile before calling this, and the query re-checks the account so
   * the two guards cannot disagree. Bounded by both limits; `truncated` reports
   * when either was hit.
   */
  listProfileActivity(args: {
    accountId: string;
    profileId: string;
    sessionLimit: number;
    entryLimit: number;
  }): Promise<ProfileActivity>;

  /**
   * Orphaned-session backstop — bulk-close every session still
   * `status='active'` whose `created_at` is strictly before `cutoff`,
   * setting `closed_reason='orphaned-lifetime'` + `closed_at=now`.
   * Returns the number of rows closed. Sessions only otherwise flip to
   * `closed` on explicit DELETE or budget exhaustion, so a session
   * orphaned by a dead worker would linger `active` forever; the
   * AgentSessionOrphanSweeper calls this on a wall-clock cap.
   * INVARIANT: a session with `created_at >= cutoff` OR any non-active
   * status is NEVER touched. Idempotent (re-running closes nothing new).
   */
  reapOrphanedActiveBefore(cutoff: Date): Promise<number>;

  /**
   * V-785 — ids of every `status='active'` session parked in a pair-mode state
   * that is waiting on a client, i.e. `pair_mode_state` is present and its
   * `kind` is not `ai-driving`.
   *
   * Used ONCE, at boot, to seed the in-memory heartbeat tracker. `pair_mode_state`
   * is persisted; the liveness signal that clears it is a process-local Map, so a
   * restart leaves the row parked with nothing able to see it. A session in
   * `takeover-pending` cannot re-register itself either — the input-event route
   * 409s on that state before reaching `recordHeartbeat` — so without this the
   * documented "returns to ai-driving after 30s without a client heartbeat" never
   * happens and the session stays parked until the orphan reaper closes it.
   *
   * Bounded by the active-session caps and read once per process, so no limit
   * argument. Ordering is unspecified; the caller seeds all of them.
   */
  listActivePairModeSessionIds(): Promise<string[]>;

  /**
   * Worker-disconnect fix (2026-06-19, migration 0086) — record which fleet
   * node a session was dispatched to. Called by dispatchSessionAssignOnCreate
   * immediately before sessionAssign is sent. Best-effort at the call site (a
   * write failure must not break session-create), so this persists the pointer
   * the disconnect reaper later matches on. This is also the atomic active-only
   * ownership claim: returns null when the session is missing OR a close won
   * during dispatch preparation, so terminal rows can never be assigned.
   *
   * T-6 — `proxyId` rides the SAME atomic claim so the session records which
   * proxy it browses through (NULL for an operator-default egress). Passing it
   * here rather than as a second write keeps node + proxy attribution on one
   * active-only UPDATE; omit the argument to leave proxy_id untouched.
   */
  setNodeId(
    id: string,
    nodeId: string,
    proxyId?: string | null,
  ): Promise<AgentSessionRecord | null>;

  /**
   * Worker-disconnect fix (2026-06-19, migration 0086) — bulk-close every
   * session still `status='active'` AND `node_id = nodeId`, stamping
   * `closed_reason=reason` + `closed_at=now`. Returns the number of rows
   * closed. Called by the worker-disconnect reaper when a node drops and does
   * not reconnect within the grace window, so the worker's concurrent-session
   * slot frees in minutes instead of lingering until the 12h orphan_reap.
   * CRITICAL INVARIANT: anchored on BOTH status='active' AND node_id=nodeId, so
   * another node's sessions, already-closed sessions, and sessions never
   * dispatched (node_id NULL) are NEVER touched. Idempotent (re-running closes
   * nothing new — the rows are no longer 'active').
   */
  closeActiveByNode(nodeId: string, reason: string): Promise<number>;

  /**
   * Node-restart variant of {@link closeActiveByNode} (A2 W2813 bootId consumer):
   * close a node's still-active sessions EXCEPT those whose id is in `keepIds`.
   * Used when a daemon's `bootId` changes (it restarted, A3 W2827): its prior
   * in-memory sessions are gone, so the CP closes the ones it still holds active
   * for that node — but NOT any the restarted boot REAFFIRMS in its heartbeat
   * `activeSessionStates` (a session freshly assigned to the new boot, which the
   * node reports as active/provisioning), so a just-dispatched session is never
   * killed by the restart sweep. Same CRITICAL INVARIANT as closeActiveByNode
   * (status='active' AND node_id=nodeId; NULL node_id never matches). `keepIds`
   * empty ⇒ identical to closeActiveByNode. Idempotent.
   */
  closeActiveByNodeExcept(
    nodeId: string,
    keepIds: readonly string[],
    reason: string,
    opts?: { minIdleMs?: number },
  ): Promise<number>;

  /**
   * v2-#19 — Stripe-pattern idempotency lookup. Scoped per-account so
   * customer A's "key=foo" cannot collide with customer B's "key=foo"
   * (mirrors the partial unique index from migration 0047). Returns
   * the existing record when the (accountId, key) tuple matches; NULL
   * otherwise. The route layer uses the NULL/non-NULL outcome to decide
   * "replay prior 201" vs "mint new row".
   */
  findByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
  ): Promise<AgentSessionRecord | null>;

  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — overwrite `pair_mode_state` JSONB
   * on a session. Sub-slice 8.7 state machine drives these writes.
   * Throws when the session is not found.
   */
  setPairModeState(id: string, state: unknown): Promise<AgentSessionRecord>;

  /**
   * Atomically replace pair-mode state only when the row is still active, still
   * in pair mode, and its JSON state exactly matches `expectedState`. Returns
   * null when any predicate lost a race. This is the transition primitive for
   * takeover/handback/timeout paths; a plain read followed by
   * {@link setPairModeState} can overwrite a newer controller or a concurrent
   * mode change.
   */
  compareAndSetPairModeState(
    id: string,
    expectedState: unknown,
    nextState: unknown,
  ): Promise<AgentSessionRecord | null>;

  /**
   * Slice 3 (Wave 29-NNN ARC 3) — top-level operational-mode setter.
   * Atomic write of `mode` + `pair_mode_state` so the row never
   * surfaces with `mode='pair'` + `pair_mode_state=NULL` (or
   * `mode!='pair'` + non-null pair_mode_state). Caller passes the
   * pair-mode state that should accompany the target mode:
   *   - `pair`  → `initialPairModeState()` (`{kind:'ai-driving'}`).
   *   - `manual`/`ai` → `null` (cleared).
   * Throws when the session is not found.
   */
  setMode(id: string, mode: AgentSessionMode, pairModeState: unknown): Promise<AgentSessionRecord>;

  /** Atomically change mode only while the session remains active. Missing or
   * terminal rows return null so a close winner cannot receive a late mode or
   * pair-state overwrite. The unconditional setter remains for fixtures. */
  setModeIfActive(
    id: string,
    mode: AgentSessionMode,
    pairModeState: unknown,
  ): Promise<AgentSessionRecord | null>;

  /**
   * Arc 2 sub-slice 8.4 (v2-#8) — write the encrypted
   * gui_control_key blob + its 24h-TTL expiry timestamp. Called by
   * the route layer at first-fetch (auto-mint) or rotation. Pass
   * null for both args to clear.
   */
  setGuiControlKey(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord>;

  /** Persist a GUI control credential only while the session remains active.
   * Missing or terminal rows return null so callers never disclose plaintext
   * for a key that lost a concurrent close. */
  setGuiControlKeyIfActive(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord | null>;
}

/**
 * In-memory implementation for tests + dev mode. Production wires the
 * Drizzle-backed repo (AI-A.c follow-up). The two share this exact
 * interface so the executor + dashboard chat UI never have to know
 * which backend they're talking to.
 *
 * Thread-safety: the repo is intended for single-threaded use (Node's
 * single event loop suffices for the API server). Concurrent calls
 * to debitTokens on the same id are serialized by the JS event loop.
 */
export class InMemoryAgentSessionsRepo implements AgentSessionsRepo {
  private records = new Map<string, AgentSessionRecord>();
  private authorityRevisions = new Map<string, number>();
  private counter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord> {
    this.counter += 1;
    const id = `agt_inmem_${this.counter.toString().padStart(8, '0')}`;
    const now = this.clock();
    const rec: AgentSessionRecord = {
      id,
      accountId: args.accountId,
      driftstackSessionId: args.driftstackSessionId ?? null,
      status: 'active',
      // #13 — a continued chat starts with the source's entries. The Drizzle repo
      // re-encrypts them under the new id; here there is no envelope, so a copy of
      // the array is the whole job — but it MUST be a copy, since the caller's
      // array is the source session's own transcript.
      transcript: args.seedTranscript !== undefined ? [...args.seedTranscript] : [],
      tokenBudgetTotal: args.tokenBudgetTotal,
      tokenBudgetRemaining: args.tokenBudgetTotal,
      closedReason: null,
      idempotencyKey: args.idempotencyKey ?? null,
      createdByUserId: args.createdByUserId ?? null,
      closedAt: null,
      // Arc 2 sub-slice 8.2 — default 'ai' mirrors migration 0052 default.
      mode: args.mode ?? 'ai',
      // 6.c / #15 — default model mirrors migration 0066's column default.
      model: args.model ?? DEFAULT_AGENT_MODEL,
      // 0086 — set later by setNodeId when the sessionAssign is dispatched.
      nodeId: null,
      // 0089 — the profile this session runs (NULL for ephemeral sessions).
      profileId: args.profileId ?? null,
      // 0116 — set later by setNodeId at dispatch (NULL until then).
      proxyId: null,
      pairModeState: null,
      lastErrorEvent: null,
      guiControlKeyExpiresAt: null,
      guiControlKeyCiphertext: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, rec);
    this.authorityRevisions.set(id, 0);
    return Promise.resolve(rec);
  }

  createIfUnderActiveCap(
    args: CreateAgentSessionArgs,
    cap: number,
  ): Promise<AgentSessionRecord | null> {
    // Single-threaded JS: the count + create below run without interleaving, so
    // this is naturally atomic (the Drizzle impl does the real serialisation).
    //
    // A3 finding #7 (W2979/W2980) — single-active-session-per-profile guard,
    // mirroring the Drizzle impl: when args.profileId is set, refuse a second
    // bind against a NON-TERMINAL (status != 'closed') session for the same
    // profile + account by throwing ProfileInUseError(activeSessionId). A create
    // with no profile_id is never gated (fail-safe).
    if (args.profileId !== undefined) {
      for (const rec of this.records.values()) {
        if (
          rec.accountId === args.accountId &&
          rec.profileId === args.profileId &&
          rec.status !== 'closed'
        ) {
          return Promise.reject(new ProfileInUseError(rec.id));
        }
      }
    }
    let active = 0;
    for (const rec of this.records.values()) {
      if (rec.accountId === args.accountId && rec.status === 'active') active += 1;
    }
    if (active >= cap) return Promise.resolve(null);
    return this.create(args);
  }

  findByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
  ): Promise<AgentSessionRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.accountId === accountId && rec.idempotencyKey === idempotencyKey) {
        return Promise.resolve(rec);
      }
    }
    return Promise.resolve(null);
  }

  get(id: string): Promise<AgentSessionRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  getAuthoritySnapshot(id: string): Promise<AgentSessionAuthoritySnapshot | null> {
    const rec = this.records.get(id);
    const revision = this.authorityRevisions.get(id);
    if (rec === undefined || revision === undefined) return Promise.resolve(null);
    return Promise.resolve({
      status: rec.status,
      mode: rec.mode,
      pairModeState: rec.pairModeState,
      revision,
    });
  }

  countActive(accountId: string): Promise<number> {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.accountId === accountId && rec.status === 'active') n += 1;
    }
    return Promise.resolve(n);
  }

  countActiveForProfile(profileId: string): Promise<number> {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.profileId === profileId && rec.status === 'active') n += 1;
    }
    return Promise.resolve(n);
  }

  listProfileActivity(args: {
    accountId: string;
    profileId: string;
    sessionLimit: number;
    entryLimit: number;
  }): Promise<ProfileActivity> {
    // Same shape as the Drizzle repo: newest first, one over the session limit so
    // the projection can report "more exist" without a second pass.
    const mine = [...this.records.values()]
      .filter((rec) => rec.accountId === args.accountId && rec.profileId === args.profileId)
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t !== 0 ? t : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
      })
      .slice(0, args.sessionLimit + 1);
    return Promise.resolve(
      projectProfileActivity(mine, {
        sessionLimit: args.sessionLimit,
        entryLimit: args.entryLimit,
      }),
    );
  }

  listByAccount(
    accountId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<AgentSessionRecord>> {
    const out: AgentSessionRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.accountId === accountId) out.push(rec);
    }
    // Match the Drizzle query: most-recent first ((created_at, id) desc), then
    // the optional limit — so the in-memory double and the DB agree on the page.
    out.sort((a, b) => {
      const at = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
      const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
      if (bt !== at) return bt - at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return Promise.resolve(opts?.limit !== undefined ? out.slice(0, opts.limit) : out);
  }

  listPageByAccount(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<AgentSessionListPage> {
    // Mirror the Drizzle keyset: most-recent first on (created_at, id) desc,
    // cursor = the last row's id, select strictly-after rows so same-createdAt
    // rows aren't dropped at a page boundary. Over-fetch one to detect has_more.
    const all: AgentSessionRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.accountId === accountId) all.push(rec);
    }
    all.sort((a, b) => {
      const at = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
      const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
      if (bt !== at) return bt - at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    let start = 0;
    if (opts.cursor !== undefined) {
      const idx = all.findIndex((r) => r.id === opts.cursor);
      // Unknown cursor → first page (matches the DB repo's "cursor row not
      // found → first page" semantics).
      start = idx === -1 ? 0 : idx + 1;
    }
    const slice = all.slice(start, start + opts.limit + 1);
    const hasMore = slice.length > opts.limit;
    const items = hasMore ? slice.slice(0, opts.limit) : slice;
    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }

  appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      transcript: [...rec.transcript, entry],
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  appendTranscriptIfActive(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (rec === undefined || rec.status !== 'active') return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      transcript: [...rec.transcript, entry],
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  appendTranscriptIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    entry: TranscriptEntry,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (
      rec === undefined ||
      rec.status !== 'active' ||
      this.authorityRevisions.get(id) !== expectedRevision
    ) {
      return Promise.resolve(null);
    }
    const updated: AgentSessionRecord = {
      ...rec,
      transcript: [...rec.transcript, entry],
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  debitTokens(id: string, tokens: number): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      tokenBudgetRemaining: Math.max(0, rec.tokenBudgetRemaining - tokens),
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  debitTokensIfActive(id: string, tokens: number): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (rec === undefined || rec.status !== 'active') return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      tokenBudgetRemaining: Math.max(0, rec.tokenBudgetRemaining - tokens),
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  recordErrorEvent(
    id: string,
    reportingNodeId: string,
    event: AgentSessionErrorEvent,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (rec === undefined || rec.nodeId !== reportingNodeId) return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      lastErrorEvent: event,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  setGuiControlKey(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord> {
    const rec = this.records.get(args.id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${args.id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      guiControlKeyCiphertext: args.ciphertext,
      guiControlKeyExpiresAt: args.expiresAt,
      updatedAt: this.clock(),
    };
    this.records.set(args.id, updated);
    return Promise.resolve(updated);
  }

  setGuiControlKeyIfActive(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(args.id);
    if (rec === undefined || rec.status !== 'active') return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      guiControlKeyCiphertext: args.ciphertext,
      guiControlKeyExpiresAt: args.expiresAt,
      updatedAt: this.clock(),
    };
    this.records.set(args.id, updated);
    return Promise.resolve(updated);
  }

  setPairModeState(id: string, state: unknown): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      pairModeState: state,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    if (!isDeepStrictEqual(rec.pairModeState, state)) {
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
    }
    return Promise.resolve(updated);
  }

  compareAndSetPairModeState(
    id: string,
    expectedState: unknown,
    nextState: unknown,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (
      rec === undefined ||
      rec.status !== 'active' ||
      rec.mode !== 'pair' ||
      !isDeepStrictEqual(rec.pairModeState, expectedState)
    ) {
      return Promise.resolve(null);
    }
    const updated: AgentSessionRecord = {
      ...rec,
      pairModeState: nextState,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    if (!isDeepStrictEqual(rec.pairModeState, nextState)) {
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
    }
    return Promise.resolve(updated);
  }

  setMode(id: string, mode: AgentSessionMode, pairModeState: unknown): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      mode,
      pairModeState,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    if (rec.mode !== mode || !isDeepStrictEqual(rec.pairModeState, pairModeState)) {
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
    }
    return Promise.resolve(updated);
  }

  setModeIfActive(
    id: string,
    mode: AgentSessionMode,
    pairModeState: unknown,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (rec === undefined || rec.status !== 'active') return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      mode,
      pairModeState,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    if (rec.mode !== mode || !isDeepStrictEqual(rec.pairModeState, pairModeState)) {
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
    }
    return Promise.resolve(updated);
  }

  async closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    return (await this.closeWithReasonOutcome(id, reason)).session;
  }

  closeWithReasonOutcome(id: string, reason: string): Promise<CloseAgentSessionResult> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    // Mirror the production repo's atomic WHERE status!='closed' close: the
    // first terminal transition owns both closedAt and closedReason. A later
    // customer/worker/runtime closer is an idempotent read, never a reason
    // overwrite. A paused session remains explicitly closeable. This in-memory
    // method is synchronous, so checking the current immutable record also
    // serializes Promise.all callers deterministically.
    if (rec.status === 'closed') {
      return Promise.resolve({ kind: 'already_closed', session: rec });
    }
    const now = this.clock();
    const updated: AgentSessionRecord = {
      ...rec,
      status: 'closed',
      closedReason: reason,
      // v2-#19 — wall-clock close timestamp; distinct from updatedAt
      // which moves on every transcript append. This branch is active-only,
      // so both terminal fields are set exactly once.
      closedAt: now,
      updatedAt: now,
    };
    this.records.set(id, updated);
    this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
    return Promise.resolve({ kind: 'closed', session: updated });
  }

  closeWithReasonIfAuthorityRevision(
    id: string,
    expectedRevision: number,
    reason: string,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    if (
      rec === undefined ||
      rec.status !== 'active' ||
      this.authorityRevisions.get(id) !== expectedRevision
    ) {
      return Promise.resolve(null);
    }
    const now = this.clock();
    const updated: AgentSessionRecord = {
      ...rec,
      status: 'closed',
      closedReason: reason,
      closedAt: now,
      updatedAt: now,
    };
    this.records.set(id, updated);
    this.authorityRevisions.set(id, expectedRevision + 1);
    return Promise.resolve(updated);
  }

  listActivePairModeSessionIds(): Promise<string[]> {
    const out: string[] = [];
    for (const [id, rec] of this.records) {
      if (rec.status !== 'active') continue;
      const state = rec.pairModeState;
      if (state === null || state === undefined || typeof state !== 'object') continue;
      const kind = (state as { kind?: unknown }).kind;
      // `ai-driving` is the resting state and needs no heartbeat; anything else
      // is parked waiting on a client. An unrecognised kind is INCLUDED on
      // purpose — a state this build does not know about is exactly the one
      // that should still be able to time out.
      if (kind === 'ai-driving') continue;
      out.push(id);
    }
    return Promise.resolve(out);
  }

  reapOrphanedActiveBefore(cutoff: Date): Promise<number> {
    const now = this.clock();
    let closed = 0;
    for (const [id, rec] of this.records) {
      // INVARIANT: only status='active' rows older than the cutoff. A
      // still-live (createdAt >= cutoff) or already-closed row is skipped.
      if (rec.status !== 'active' || rec.createdAt.getTime() >= cutoff.getTime()) continue;
      this.records.set(id, {
        ...rec,
        status: 'closed',
        closedReason: 'orphaned-lifetime',
        closedAt: rec.closedAt ?? now,
        updatedAt: now,
      });
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
      closed += 1;
    }
    return Promise.resolve(closed);
  }

  setNodeId(
    id: string,
    nodeId: string,
    proxyId?: string | null,
  ): Promise<AgentSessionRecord | null> {
    const rec = this.records.get(id);
    // A dispatch can race any terminal closer. Missing or already-closed rows
    // fail the ownership claim as a no-op, so the caller never sends an assign
    // for a terminal API session.
    if (!rec || rec.status !== 'active') return Promise.resolve(null);
    const updated: AgentSessionRecord = {
      ...rec,
      nodeId,
      // T-6 — record the proxy alongside the node when the caller supplies one;
      // an omitted argument leaves the prior value untouched.
      ...(proxyId !== undefined ? { proxyId } : {}),
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  closeActiveByNode(nodeId: string, reason: string): Promise<number> {
    const now = this.clock();
    let closed = 0;
    for (const [id, rec] of this.records) {
      // INVARIANT: only status='active' AND node_id=nodeId. Another node's
      // rows, already-closed rows, and never-dispatched (nodeId=null) rows are
      // skipped — exactly the closeActiveByNode contract.
      if (rec.status !== 'active' || rec.nodeId !== nodeId) continue;
      this.records.set(id, {
        ...rec,
        status: 'closed',
        closedReason: reason,
        closedAt: rec.closedAt ?? now,
        updatedAt: now,
      });
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
      closed += 1;
    }
    return Promise.resolve(closed);
  }

  closeActiveByNodeExcept(
    nodeId: string,
    keepIds: readonly string[],
    reason: string,
    opts: { minIdleMs?: number } = {},
  ): Promise<number> {
    const now = this.clock();
    const minIdleMs = opts.minIdleMs ?? 0;
    const cutoff = now.getTime() - minIdleMs;
    const keep = new Set(keepIds);
    let closed = 0;
    for (const [id, rec] of this.records) {
      // Same INVARIANT as closeActiveByNode, plus: skip ids the restarted boot
      // reaffirmed (keepIds) AND skip rows touched within minIdleMs (the W2820
      // recency guard — a just-assigned new-boot session has updatedAt≈now and is
      // not yet in keepIds, so without this it would be wrongly closed).
      if (rec.status !== 'active' || rec.nodeId !== nodeId || keep.has(id)) continue;
      if (minIdleMs > 0 && rec.updatedAt.getTime() >= cutoff) continue;
      this.records.set(id, {
        ...rec,
        status: 'closed',
        closedReason: reason,
        closedAt: rec.closedAt ?? now,
        updatedAt: now,
      });
      this.authorityRevisions.set(id, (this.authorityRevisions.get(id) ?? 0) + 1);
      closed += 1;
    }
    return Promise.resolve(closed);
  }
}
