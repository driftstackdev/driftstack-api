import { and, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { agentTurnReceipts } from './schema.js';
import { decryptPlatformSecret, encryptPlatformSecret } from '../lib/platform-secret-encryption.js';
import {
  canonicalAgentTurnTerminal,
  type AgentTurnReceiptReservation,
  type AgentTurnReceiptsRepo,
  type AgentTurnTerminalResponse,
  type CompleteAgentTurnReceiptArgs,
  type ReserveAgentTurnReceiptArgs,
} from '../services/agent-turn-receipts.js';

const AGENT_TURN_RECEIPT_AAD_PURPOSE = 'driftstack.agent-turn-receipt';

function agentTurnReceiptAuthenticatedContext(args: {
  accountId: string;
  idempotencyKey: string;
  agentSessionId: string;
  requestHash: string;
  responseStatus: number;
}): string {
  // A JSON array is unambiguous even when an idempotency key contains
  // punctuation. The dedicated purpose prevents a valid shared-key envelope
  // from another store being accepted as a durable turn response.
  return JSON.stringify([
    AGENT_TURN_RECEIPT_AAD_PURPOSE,
    1,
    args.accountId,
    args.idempotencyKey,
    args.agentSessionId,
    args.requestHash,
    args.responseStatus,
  ]);
}

function readTerminal(
  row: typeof agentTurnReceipts.$inferSelect,
  encryptionKeyBase64: string,
): AgentTurnTerminalResponse {
  if (row.state !== 'completed' || row.responseStatus === null || row.responseCiphertext === null) {
    throw new Error('completed agent-turn receipt is malformed');
  }
  const plaintext = decryptPlatformSecret(
    row.responseCiphertext,
    encryptionKeyBase64,
    agentTurnReceiptAuthenticatedContext({
      accountId: row.accountId,
      idempotencyKey: row.idempotencyKey,
      agentSessionId: row.agentSessionId,
      requestHash: row.requestHash,
      responseStatus: row.responseStatus,
    }),
  );
  return canonicalAgentTurnTerminal({
    status: row.responseStatus,
    body: JSON.parse(plaintext) as unknown,
  });
}

export class DrizzleAgentTurnReceiptsRepo implements AgentTurnReceiptsRepo {
  private readonly clock: () => Date;

  constructor(
    private readonly database: Database,
    private readonly encryptionKeyBase64: string,
    options: { clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async reserve(args: ReserveAgentTurnReceiptArgs): Promise<AgentTurnReceiptReservation> {
    const inserted = await this.database.db
      .insert(agentTurnReceipts)
      .values({
        accountId: args.accountId,
        idempotencyKey: args.idempotencyKey,
        agentSessionId: args.agentSessionId,
        requestHash: args.requestHash,
        state: 'in_progress',
        createdAt: this.clock(),
      })
      .onConflictDoNothing()
      .returning({ idempotencyKey: agentTurnReceipts.idempotencyKey });
    if (inserted.length === 1) return { kind: 'reserved' };

    const [existing] = await this.database.db
      .select()
      .from(agentTurnReceipts)
      .where(
        and(
          eq(agentTurnReceipts.accountId, args.accountId),
          eq(agentTurnReceipts.idempotencyKey, args.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing === undefined) {
      throw new Error('agent-turn receipt conflict row disappeared before replay lookup');
    }
    if (
      existing.agentSessionId !== args.agentSessionId ||
      existing.requestHash !== args.requestHash
    ) {
      return { kind: 'mismatch' };
    }
    if (existing.state === 'in_progress') return { kind: 'in-progress' };
    return { kind: 'replay', terminal: readTerminal(existing, this.encryptionKeyBase64) };
  }

  async complete(args: CompleteAgentTurnReceiptArgs): Promise<void> {
    const terminal = canonicalAgentTurnTerminal(args.terminal);
    const responseCiphertext = encryptPlatformSecret(
      JSON.stringify(terminal.body),
      this.encryptionKeyBase64,
      agentTurnReceiptAuthenticatedContext({
        accountId: args.accountId,
        idempotencyKey: args.idempotencyKey,
        agentSessionId: args.agentSessionId,
        requestHash: args.requestHash,
        responseStatus: terminal.status,
      }),
    );
    const updated = await this.database.db
      .update(agentTurnReceipts)
      .set({
        state: 'completed',
        responseStatus: terminal.status,
        responseCiphertext,
        completedAt: this.clock(),
      })
      .where(
        and(
          eq(agentTurnReceipts.accountId, args.accountId),
          eq(agentTurnReceipts.idempotencyKey, args.idempotencyKey),
          eq(agentTurnReceipts.agentSessionId, args.agentSessionId),
          eq(agentTurnReceipts.requestHash, args.requestHash),
          eq(agentTurnReceipts.state, 'in_progress'),
        ),
      )
      .returning({ idempotencyKey: agentTurnReceipts.idempotencyKey });
    if (updated.length === 1) return;

    // A database client can retry an UPDATE after its commit acknowledgement is
    // lost. Treat an already-completed identical receipt as success, but never
    // overwrite a different terminal result.
    const replay = await this.reserve(args);
    if (replay.kind === 'replay' && JSON.stringify(replay.terminal) === JSON.stringify(terminal)) {
      return;
    }
    throw new Error('agent-turn receipt could not be completed atomically');
  }

  /**
   * Erase turn receipts belonging to accounts terminated before `cutoff`.
   *
   * `response_ciphertext` holds the agent turn's response BODY, which is
   * customer content — not metadata. The published retention table caps
   * "Session metadata" at 90 days operational and permits indefinite retention
   * only for "aggregated counters (no PII)", and DPA §3.8 commits to deletion
   * within 30 days of termination. Nothing deleted these rows at all.
   *
   * The ON DELETE CASCADE on `account_id` never helps: `deleteAccount` is a
   * SOFT delete (a status flip), so the accounts row is never removed and the
   * cascade never fires. That is the same reason proxy credentials and profiles
   * were both retained past their windows, and the reason this needs its own
   * arm rather than trusting the foreign key.
   *
   * BOUNDED on RECEIPT rows rather than on accounts: one terminated account can
   * own an unbounded number of receipts, so a per-account bound would still let
   * a single tick delete millions. The sweep is self-limiting — deleted rows
   * stop matching — so what a tick leaves behind drains on the next one.
   *
   * The bound sits on a subselect because PostgreSQL's DELETE takes no LIMIT.
   * The composite key `(account_id, idempotency_key)` is the table's primary
   * key, so the IN-list targets exactly the scanned rows.
   */
  async purgeForTerminatedAccountsBefore(cutoff: Date, maxPerTick = 500): Promise<number> {
    return await purgeTurnReceiptsForTerminatedAccountsBefore(this.database, cutoff, maxPerTick);
  }
}

/**
 * Standalone so the purge does NOT depend on the encryption key.
 *
 * `DrizzleAgentTurnReceiptsRepo` requires `MFA_ENCRYPTION_KEY`, because reading
 * and writing a receipt means decrypting and encrypting the response body. A
 * DELETE decrypts nothing. Wiring the sweeper to the class would therefore have
 * made an unset key silently switch off a retention commitment that has no
 * relationship to it — precisely the defect fixed in `2eeddefa7`, where one
 * unrelated flag was found gating three separate §9 promises. Keeping the
 * erasure path key-free means the arm runs on every deployment.
 */
export async function purgeTurnReceiptsForTerminatedAccountsBefore(
  database: Database,
  cutoff: Date,
  maxPerTick = 500,
): Promise<number> {
  const rows = await database.client<Array<{ account_id: string }>>`
    DELETE FROM agent_turn_receipts
    WHERE (account_id, idempotency_key) IN (
      SELECT r.account_id, r.idempotency_key
      FROM agent_turn_receipts r
      JOIN accounts a ON a.id = r.account_id
      WHERE a.status = 'deleted'
        AND a.deleted_at IS NOT NULL
        AND a.deleted_at < ${cutoff.toISOString()}::timestamptz
      LIMIT ${maxPerTick}
    )
    RETURNING account_id`;
  return rows.length;
}
