// AI-A.c — Drizzle implementation of AgentSessionsRepo (migration 0042).
// Production wires this; tests/dev use InMemoryAgentSessionsRepo from
// services/agent-sessions.ts.
//
// Key shape rules (matching the in-memory variant + migration 0042):
//   - text PK `agt_<uuid>` minted at create.
//   - jsonb transcript starts empty, grows append-only via
//     appendTranscript (full-row UPDATE rewrites the jsonb; OK at the
//     expected per-session volume — a transcript with 100 messages is
//     ~few KB jsonb).
//   - debitTokens floors remaining at 0 (matches the in-memory
//     `Math.max(0, ...)`); the CHECK constraint `remaining <= total`
//     prevents the opposite drift.
//   - closeWithReason flips status to 'closed' + writes closed_reason
//     atomically.
//
// Concurrency note: debitTokens AND appendTranscript perform their
// read-modify-write inside a `db.transaction()` that SELECTs the row
// `FOR UPDATE` before mutating (mirrors stripe-webhooks-repo.setAccountTier).
// The row lock SERIALISES concurrent same-session debits/appends — a second
// transaction blocks on the SELECT until the first commits, then reads the
// post-update value. So no debit is lost (no under-billing → no uncapped
// bundled-LLM spend) and no transcript entry is dropped (no data loss).
// Earlier these were bare read-modify-writes (a get() SELECT then a SEPARATE
// UPDATE writing the JS-computed value) whose later UPDATE clobbered the
// earlier; that lost-update window is closed by the FOR-UPDATE transaction.
// debitTokens still floors remaining at 0 (the CHECK `remaining <= total`
// guards the opposite drift). Validated against real Postgres by
// db-agent-sessions-concurrency-drizzle.test.ts (CI; skips locally w/o DB).

import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import { DEFAULT_AGENT_MODEL, type AgentModel } from '@driftstack/api-types';
import type { Database } from './client.js';
import { agentSessions } from './schema.js';
import type { TranscriptEntry } from '../services/agent-decomposer.js';
import type {
  AgentSessionRecord,
  AgentSessionStatus,
  AgentSessionsRepo,
  CreateAgentSessionArgs,
} from '../services/agent-sessions.js';

function rowToRecord(row: typeof agentSessions.$inferSelect): AgentSessionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    driftstackSessionId: row.driftstackSessionId,
    status: row.status as AgentSessionStatus,
    transcript: (row.transcript as ReadonlyArray<TranscriptEntry>) ?? [],
    tokenBudgetTotal: row.tokenBudgetTotal,
    tokenBudgetRemaining: row.tokenBudgetRemaining,
    closedReason: row.closedReason,
    // v2-#9 + v2-#19 hardening columns — present on every row even
    // when migration 0047 left them NULL on legacy rows.
    idempotencyKey: row.idempotencyKey,
    createdByUserId: row.createdByUserId,
    closedAt: row.closedAt,
    // Arc 2 sub-slice 8.2 (v2-#8) — pair-mode + GUI-key columns from
    // migration 0052. Existing rows pick up mode='ai' from the CHECK
    // default; null for pair_mode_state + gui_control_key_expires_at.
    mode: (row.mode as 'manual' | 'ai' | 'pair') ?? 'ai',
    // 6.c / #15 — picked Claude 4.x model (migration 0066 column; backfill
    // default 'claude-opus-4-7', bumped to 'claude-opus-4-8' for new rows in 0087).
    model: (row.model as AgentModel) ?? DEFAULT_AGENT_MODEL,
    // 0086 — fleet node the session was dispatched to (NULL until dispatch /
    // on every no-fleet-CP row).
    nodeId: row.nodeId,
    pairModeState: row.pairModeState,
    guiControlKeyExpiresAt: row.guiControlKeyExpiresAt,
    guiControlKeyCiphertext: row.guiControlKeyCiphertext,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAgentSessionsRepo implements AgentSessionsRepo {
  constructor(
    private readonly database: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(args: CreateAgentSessionArgs): Promise<AgentSessionRecord> {
    const id = `agt_${randomUUID()}`;
    const now = this.clock();
    const inserted = await this.database.db
      .insert(agentSessions)
      .values({
        id,
        accountId: args.accountId,
        driftstackSessionId: args.driftstackSessionId ?? null,
        status: 'active',
        transcript: [],
        tokenBudgetTotal: args.tokenBudgetTotal,
        tokenBudgetRemaining: args.tokenBudgetTotal,
        // v2-#19 hardening columns — partial unique index on
        // (account_id, idempotency_key) enforces "first-write wins" if
        // the route layer races two POSTs with the same key. Postgres
        // raises a UniqueViolation; the route layer's findByIdempotencyKey
        // pre-check is the primary dedupe surface.
        idempotencyKey: args.idempotencyKey ?? null,
        createdByUserId: args.createdByUserId ?? null,
        // Arc 2 sub-slice 8.2 — mode forwarded from caller (or default
        // via DB CHECK constraint when args.mode is omitted).
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        // 6.c / #15 — model forwarded from caller (or default via DB
        // CHECK constraint when args.model is omitted).
        ...(args.model !== undefined ? { model: args.model } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('AgentSession insert returned no rows');
    }
    return rowToRecord(row);
  }

  async get(id: string): Promise<AgentSessionRecord | null> {
    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  async listByAccount(
    accountId: string,
    opts?: { limit?: number },
  ): Promise<ReadonlyArray<AgentSessionRecord>> {
    // Push the sort + cap to the DB so a busy account's full session history
    // isn't fetched into memory on every list call (the only caller renders just
    // the most-recent page). Most-recent first; (created_at, id) desc is a stable
    // total order for the tiebreak.
    const base = this.database.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.accountId, accountId))
      .orderBy(desc(agentSessions.createdAt), desc(agentSessions.id));
    const rows = opts?.limit !== undefined ? await base.limit(opts.limit) : await base;
    return rows.map(rowToRecord);
  }

  async countActive(accountId: string): Promise<number> {
    const rows = await this.database.db
      .select({ n: count() })
      .from(agentSessions)
      .where(and(eq(agentSessions.accountId, accountId), eq(agentSessions.status, 'active')));
    return rows[0]?.n ?? 0;
  }

  async appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord> {
    // Atomic append under a row lock (see the file header concurrency note):
    // SELECT … FOR UPDATE inside a transaction serialises concurrent
    // same-session appends, so two racing turns never lose an entry — the
    // second blocks until the first commits, then appends to the up-to-date
    // transcript. (Was a bare read-modify-write whose later UPDATE clobbered
    // the earlier → a dropped transcript entry.)
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        throw new Error(`AgentSession ${id} not found`);
      }
      const currentTranscript = (existing.transcript as ReadonlyArray<TranscriptEntry>) ?? [];
      const nextTranscript = [...currentTranscript, entry];
      const updated = await tx
        .update(agentSessions)
        .set({ transcript: nextTranscript, updatedAt: now })
        .where(eq(agentSessions.id, id))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new Error(`AgentSession ${id} disappeared mid-transaction`);
      }
      return rowToRecord(row);
    });
  }

  async debitTokens(id: string, tokens: number): Promise<AgentSessionRecord> {
    // Atomic debit under a row lock (see the file header concurrency note):
    // SELECT … FOR UPDATE inside a transaction serialises concurrent
    // same-session debits, so two racing turns never lose one — the second
    // blocks until the first commits, then debits the up-to-date remaining.
    // Floored at 0 (CHECK `remaining <= total` guards the opposite drift).
    // (Was a bare read-modify-write whose later UPDATE clobbered the earlier
    // → under-debit / budget over-served.)
    const now = this.clock();
    return this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        throw new Error(`AgentSession ${id} not found`);
      }
      const nextRemaining = Math.max(0, existing.tokenBudgetRemaining - tokens);
      const updated = await tx
        .update(agentSessions)
        .set({ tokenBudgetRemaining: nextRemaining, updatedAt: now })
        .where(eq(agentSessions.id, id))
        .returning();
      const row = updated[0];
      if (!row) {
        throw new Error(`AgentSession ${id} disappeared mid-transaction`);
      }
      return rowToRecord(row);
    });
  }

  async closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    const now = this.clock();
    // v2-#19 — closedAt is set ONLY on the first close transition. We
    // do a read-before-write so re-closing an already-closed row leaves
    // the original closedAt intact (Stripe-style timestamp; the first
    // close wins). The row-level UPDATE is still atomic per id.
    const existing = await this.get(id);
    const closedAt = existing?.closedAt ?? now;
    const updated = await this.database.db
      .update(agentSessions)
      .set({ status: 'closed', closedReason: reason, closedAt, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row);
  }

  async reapOrphanedActiveBefore(cutoff: Date): Promise<number> {
    // Orphaned-session backstop (2026-06-19) — agent sessions only flip to
    // 'closed' on an explicit DELETE or budget exhaustion. When a worker dies
    // mid-session the row lingers status='active' forever. This wall-clock
    // backstop bulk-closes any session that has been 'active' longer than the
    // (generous) lifetime cap. CRITICAL INVARIANT: the WHERE is anchored on
    // BOTH status='active' AND created_at < cutoff, so a still-live session
    // (created_at >= cutoff) or an already-closed row is NEVER touched. The
    // closed_at/closed_reason are set in the same statement; idempotent
    // (re-running closes nothing new because the rows are no longer 'active').
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        status: 'closed',
        closedReason: 'orphaned-lifetime',
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentSessions.status, 'active'), lt(agentSessions.createdAt, cutoff)))
      .returning({ id: agentSessions.id });
    return updated.length;
  }

  async setNodeId(id: string, nodeId: string): Promise<AgentSessionRecord | null> {
    // Worker-disconnect fix (2026-06-19) — persist which node a session was
    // dispatched to. A dispatch can race a DELETE, so an unknown id returns
    // null (the best-effort dispatch caller ignores the result), never throws.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ nodeId, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    return row ? rowToRecord(row) : null;
  }

  async closeActiveByNode(nodeId: string, reason: string): Promise<number> {
    // Worker-disconnect fix (2026-06-19) — bulk-close a node's still-active
    // sessions when the node drops and doesn't reconnect within the grace
    // window. CRITICAL INVARIANT: the WHERE is anchored on BOTH status='active'
    // AND node_id=nodeId, so another node's sessions, already-closed sessions,
    // and never-dispatched rows (node_id NULL — `eq` never matches NULL) are
    // NEVER touched. closed_at/closed_reason set in the same statement;
    // idempotent (re-running closes nothing new — the rows are no longer
    // 'active'). Backed by the agent_sessions_node_id_active_idx partial index.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        status: 'closed',
        closedReason: reason,
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentSessions.status, 'active'), eq(agentSessions.nodeId, nodeId)))
      .returning({ id: agentSessions.id });
    return updated.length;
  }

  async setGuiControlKey(args: {
    id: string;
    ciphertext: Buffer | null;
    expiresAt: Date | null;
  }): Promise<AgentSessionRecord> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({
        guiControlKeyCiphertext: args.ciphertext,
        guiControlKeyExpiresAt: args.expiresAt,
        updatedAt: now,
      })
      .where(eq(agentSessions.id, args.id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${args.id} not found`);
    }
    return rowToRecord(row);
  }

  async setPairModeState(id: string, state: unknown): Promise<AgentSessionRecord> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ pairModeState: state, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row);
  }

  async setMode(
    id: string,
    mode: 'manual' | 'ai' | 'pair',
    pairModeState: unknown,
  ): Promise<AgentSessionRecord> {
    // Slice 3 — atomic dual-column write. Single UPDATE statement
    // means concurrent /mode calls serialize at the row level; the
    // last writer wins. The route layer guards against the lossy
    // "interleave with mid-flight takeover" case by inspecting
    // pair_mode_state before issuing the transition.
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ mode, pairModeState, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row);
  }

  async findByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
  ): Promise<AgentSessionRecord | null> {
    // v2-#19 — partial unique index `agent_sessions_idempotency_key_unique`
    // on (account_id, idempotency_key) means at most one row matches.
    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.accountId, accountId),
          eq(agentSessions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }
}
