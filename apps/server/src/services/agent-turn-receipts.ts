// Durable at-most-once receipts for POST /agent-sessions/:id/message.
// A viewer can disconnect while the server deliberately finishes a browser
// turn. Reusing the same Idempotency-Key must replay that terminal result,
// never execute the natural-language task again.

import { createHash } from 'node:crypto';

export const AGENT_TURN_RECEIPT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface AgentTurnTerminalResponse {
  status: number;
  body: unknown;
}

export type AgentTurnReceiptReservation =
  | { kind: 'reserved' }
  | { kind: 'in-progress' }
  | { kind: 'mismatch' }
  | { kind: 'replay'; terminal: AgentTurnTerminalResponse };

export interface ReserveAgentTurnReceiptArgs {
  accountId: string;
  agentSessionId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CompleteAgentTurnReceiptArgs extends ReserveAgentTurnReceiptArgs {
  terminal: AgentTurnTerminalResponse;
}

export interface AgentTurnReceiptsRepo {
  reserve(args: ReserveAgentTurnReceiptArgs): Promise<AgentTurnReceiptReservation>;
  complete(args: CompleteAgentTurnReceiptArgs): Promise<void>;
}

export function hashAgentTurnRequest(args: {
  agentSessionId: string;
  userMessage: string;
  approveConsequentialActions?: ReadonlyArray<{
    category: string;
    matched_text: string;
  }>;
  explicitByokApiKey?: string;
}): string {
  // Bind explicit BYOK overrides without ever persisting their plaintext. A
  // stored account/session key is deliberately excluded: a later config
  // rotation must not invalidate replay of an already-completed turn.
  const explicitByokFingerprint =
    args.explicitByokApiKey === undefined
      ? null
      : createHash('sha256').update(args.explicitByokApiKey, 'utf8').digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        agent_session_id: args.agentSessionId,
        user_message: args.userMessage,
        approve_consequential_actions: args.approveConsequentialActions ?? null,
        explicit_byok_fingerprint: explicitByokFingerprint,
      }),
      'utf8',
    )
    .digest('hex');
}

function receiptMapKey(accountId: string, idempotencyKey: string): string {
  return `${accountId}\u0000${idempotencyKey}`;
}

export function canonicalAgentTurnTerminal(
  terminal: AgentTurnTerminalResponse,
): AgentTurnTerminalResponse {
  if (!Number.isSafeInteger(terminal.status) || terminal.status < 100 || terminal.status > 599) {
    throw new Error(`agent-turn receipt status is invalid: ${terminal.status.toString()}`);
  }
  const encoded = JSON.stringify(terminal.body);
  if (encoded === undefined) throw new Error('agent-turn receipt body is not JSON-serializable');
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > AGENT_TURN_RECEIPT_MAX_RESPONSE_BYTES) {
    throw new Error(
      `agent-turn receipt body exceeds ${AGENT_TURN_RECEIPT_MAX_RESPONSE_BYTES.toString()} bytes`,
    );
  }
  return { status: terminal.status, body: JSON.parse(encoded) as unknown };
}

interface InMemoryReceipt {
  agentSessionId: string;
  requestHash: string;
  terminal?: AgentTurnTerminalResponse;
}

export class InMemoryAgentTurnReceiptsRepo implements AgentTurnReceiptsRepo {
  private readonly receipts = new Map<string, InMemoryReceipt>();

  // Repository parity: production reserve is asynchronous database I/O.
  // eslint-disable-next-line @typescript-eslint/require-await
  async reserve(args: ReserveAgentTurnReceiptArgs): Promise<AgentTurnReceiptReservation> {
    const mapKey = receiptMapKey(args.accountId, args.idempotencyKey);
    const existing = this.receipts.get(mapKey);
    if (existing === undefined) {
      this.receipts.set(mapKey, {
        agentSessionId: args.agentSessionId,
        requestHash: args.requestHash,
      });
      return { kind: 'reserved' };
    }
    if (
      existing.agentSessionId !== args.agentSessionId ||
      existing.requestHash !== args.requestHash
    ) {
      return { kind: 'mismatch' };
    }
    if (existing.terminal === undefined) return { kind: 'in-progress' };
    return {
      kind: 'replay',
      terminal: canonicalAgentTurnTerminal(existing.terminal),
    };
  }

  // Repository parity: production complete is asynchronous database I/O.
  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(args: CompleteAgentTurnReceiptArgs): Promise<void> {
    const mapKey = receiptMapKey(args.accountId, args.idempotencyKey);
    const existing = this.receipts.get(mapKey);
    if (
      existing === undefined ||
      existing.agentSessionId !== args.agentSessionId ||
      existing.requestHash !== args.requestHash
    ) {
      throw new Error('agent-turn receipt reservation is missing or mismatched');
    }
    const terminal = canonicalAgentTurnTerminal(args.terminal);
    if (existing.terminal !== undefined) {
      const prior = JSON.stringify(canonicalAgentTurnTerminal(existing.terminal));
      const next = JSON.stringify(terminal);
      if (prior !== next) {
        throw new Error('agent-turn receipt was completed with a different result');
      }
      return;
    }
    existing.terminal = terminal;
  }
}
