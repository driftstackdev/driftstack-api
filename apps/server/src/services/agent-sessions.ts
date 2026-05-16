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
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentSessionArgs {
  accountId: string;
  tokenBudgetTotal: number;
  /** Optional pre-attached driftstack session id (when the customer
   *  starts the agent-chat from inside an already-running session). */
  driftstackSessionId?: string;
}

export interface AgentSessionsRepo {
  create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord>;
  get(id: string): Promise<AgentSessionRecord | null>;
  listByAccount(accountId: string): Promise<ReadonlyArray<AgentSessionRecord>>;
  appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord>;
  debitTokens(id: string, tokens: number): Promise<AgentSessionRecord>;
  closeWithReason(id: string, reason: string): Promise<AgentSessionRecord>;
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
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, rec);
    return Promise.resolve(rec);
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

  closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    const rec = this.records.get(id);
    if (!rec) return Promise.reject(new Error(`AgentSession ${id} not found`));
    const updated: AgentSessionRecord = {
      ...rec,
      status: 'closed',
      closedReason: reason,
      updatedAt: this.clock(),
    };
    this.records.set(id, updated);
    return Promise.resolve(updated);
  }
}
