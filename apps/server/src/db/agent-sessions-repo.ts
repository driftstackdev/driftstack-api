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
// Concurrency note: each UPDATE is a single statement, so concurrent
// debits from two requests on the same session serialize at the row
// level. The token-budget invariant is preserved by the DB; the worst
// case is one debit "wins" and bills the customer for the work both
// requests would have done — acceptable for v1.0.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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

  async listByAccount(accountId: string): Promise<ReadonlyArray<AgentSessionRecord>> {
    const rows = await this.database.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.accountId, accountId));
    return rows.map(rowToRecord);
  }

  async appendTranscript(id: string, entry: TranscriptEntry): Promise<AgentSessionRecord> {
    // Read-modify-write — single UPDATE statement reads the current
    // transcript, appends, writes back. Concurrent appends on the
    // same session are serialized at the row lock.
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`AgentSession ${id} not found`);
    }
    const now = this.clock();
    const nextTranscript = [...existing.transcript, entry];
    const updated = await this.database.db
      .update(agentSessions)
      .set({ transcript: nextTranscript, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} disappeared between read and UPDATE`);
    }
    return rowToRecord(row);
  }

  async debitTokens(id: string, tokens: number): Promise<AgentSessionRecord> {
    // Read-modify-write — single UPDATE reads remaining, floors at 0,
    // writes back. The CHECK constraint `remaining <= total` is the
    // DB-side guard against drift.
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`AgentSession ${id} not found`);
    }
    const now = this.clock();
    const nextRemaining = Math.max(0, existing.tokenBudgetRemaining - tokens);
    const updated = await this.database.db
      .update(agentSessions)
      .set({ tokenBudgetRemaining: nextRemaining, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} disappeared between read and UPDATE`);
    }
    return rowToRecord(row);
  }

  async closeWithReason(id: string, reason: string): Promise<AgentSessionRecord> {
    const now = this.clock();
    const updated = await this.database.db
      .update(agentSessions)
      .set({ status: 'closed', closedReason: reason, updatedAt: now })
      .where(eq(agentSessions.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new Error(`AgentSession ${id} not found`);
    }
    return rowToRecord(row);
  }
}
