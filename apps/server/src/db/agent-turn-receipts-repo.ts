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
}
