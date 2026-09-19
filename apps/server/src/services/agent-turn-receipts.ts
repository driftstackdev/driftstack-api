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
  /**
   * Give a reservation back, as if the key had never been used: the next request
   * with the same key reserves it afresh and runs.
   *
   * For ONE case only — a request that was refused before its turn did any work
   * (the message route decides which; see agentMessageRefusalDidNoWork). Storing
   * such a refusal as the key's final result would replay "wait and try again"
   * at a customer who waited and tried again.
   *
   * ⛔ IT NEVER UNDOES A RESULT. Only a reservation still IN PROGRESS, for this
   * exact session and request, is removed. A completed receipt is left exactly as
   * it is (and this resolves without error), because a completed receipt is the
   * record that a task ran, and removing it is how a task runs twice.
   *
   * ⛔ A REJECTED RELEASE MAY STILL HAVE LANDED (the write committed, its
   * acknowledgement was lost), after which the key can already belong to the
   * customer's retry. `complete` cannot tell that retry's reservation from the
   * caller's — they share every identifying field — so a caller that attempted a
   * release must NEVER go on to `complete` the same key, whether the release
   * resolved or rejected. The message route answers the refusal and stops.
   *
   * Optional, so a store that cannot release still satisfies the interface; the
   * route then completes the receipt with the refusal, as it always did.
   */
  release?(args: ReserveAgentTurnReceiptArgs): Promise<void>;
}

export function hashAgentTurnRequest(args: {
  agentSessionId: string;
  userMessage: string;
  approveConsequentialActions?: ReadonlyArray<{
    category: string;
    matched_text: string;
  }>;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        agent_session_id: args.agentSessionId,
        user_message: args.userMessage,
        approve_consequential_actions: args.approveConsequentialActions ?? null,
        // Compatibility sentinel: this key historically admitted a secret-derived
        // fingerprint. Credentials are not logical-turn identity, but removing the
        // key would change every existing headerless digest and the authenticated
        // encryption context of durable receipts. Keep the canonical null bytes;
        // never accept or derive credential material here again.
        explicit_byok_fingerprint: null,
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

  // Repository parity: production release is asynchronous database I/O.
  // eslint-disable-next-line @typescript-eslint/require-await
  async release(args: ReserveAgentTurnReceiptArgs): Promise<void> {
    const mapKey = receiptMapKey(args.accountId, args.idempotencyKey);
    const existing = this.receipts.get(mapKey);
    if (
      existing === undefined ||
      existing.agentSessionId !== args.agentSessionId ||
      existing.requestHash !== args.requestHash ||
      // A completed receipt is a result. It is never released.
      existing.terminal !== undefined
    ) {
      return;
    }
    this.receipts.delete(mapKey);
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
