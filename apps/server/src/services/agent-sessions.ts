// AI-A — agent-sessions persistence interface (no SQL migration; that
// follow-up Tier-2 slice lands once the founder reviews the storage
// shape). The interface + in-memory impl unblock the chat-UI consumers
// (AI-C dashboard slice) and the executor (AI-B2) so they can wire
// against a stable contract before the persistent layer lands.
//
// Design source of truth: `docs/internal/ai-chat-agent-layer-design.md`
// (in-repo) + Wave 1119+ founder verdict moving AI-CHAT from v1.1 → v1.0
// launch arc (per the V-361 framing comment in agent-decomposer.ts).
//
// Scope of this slice:
//   - AgentSession record shape (id + accountId + driftstackSessionId? +
//     status + transcript + tokenBudgetTotal + tokenBudgetRemaining +
//     createdAt + updatedAt).
//   - AgentSessionsRepo interface (create / get / appendTranscript /
//     debitTokens / closeWithReason).
//   - InMemoryAgentSessionsRepo for tests + dev mode.
//
// Out of scope (follow-up slices):
//   - SQL migration + Drizzle schema (AI-A.b — Tier 2 review needed).
//   - DrizzleAgentSessionsRepo backed by Postgres (AI-A.c).
//   - Cross-account ACL on shared-team agent-sessions (V-326e* style).

import type { TranscriptEntry } from './agent-decomposer.js';

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
   * Arc 2 sub-slice 8.2 (v2-#8) — pair-mode state machine discriminator
   * payload (sub-slice 8.7 will define the exact shape). NULL when
   * the session is not in pair mode, OR is in pair mode but no
   * takeover has been requested yet.
   */
  pairModeState: unknown;
  /**
   * Arc 2 sub-slice 8.2 (v2-#8) — when the auto-minted 24h-TTL
   * gui_control_key expires. NULL when no key has been minted (e.g.
   * historical rows pre-migration 0052). Sub-slice 8.4 mints +
   * populates.
   */
  guiControlKeyExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentSessionArgs {
  accountId: string;
  tokenBudgetTotal: number;
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
}

export interface AgentSessionsRepo {
  create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord>;
  get(id: string): Promise<AgentSessionRecord | null>;
  listByAccount(accountId: string): Promise<ReadonlyArray<AgentSessionRecord>>;
  appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord>;
  debitTokens(id: string, tokens: number): Promise<AgentSessionRecord>;
  closeWithReason(id: string, reason: string): Promise<AgentSessionRecord>;
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
      transcript: [],
      tokenBudgetTotal: args.tokenBudgetTotal,
      tokenBudgetRemaining: args.tokenBudgetTotal,
      closedReason: null,
      idempotencyKey: args.idempotencyKey ?? null,
      createdByUserId: args.createdByUserId ?? null,
      closedAt: null,
      // Arc 2 sub-slice 8.2 — default 'ai' mirrors migration 0052 default.
      mode: args.mode ?? 'ai',
      pairModeState: null,
      guiControlKeyExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, rec);
    return Promise.resolve(rec);
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

  listByAccount(accountId: string): Promise<ReadonlyArray<AgentSessionRecord>> {
    const out: AgentSessionRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.accountId === accountId) out.push(rec);
    }
    return Promise.resolve(out);
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

  setPairModeState(id: string, state: unknown): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      pairModeState: state,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }

  closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const now = this.clock();
    const updated: AgentSessionRecord = {
      ...rec,
      status: 'closed',
      closedReason: reason,
      // v2-#19 — wall-clock close timestamp; distinct from updatedAt
      // which moves on every transcript append. Set once at the
      // transition; not advanced if the row is later re-closed (the
      // first close wins, by Stripe-style timestamp semantics).
      closedAt: rec.closedAt ?? now,
      updatedAt: now,
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }
}
