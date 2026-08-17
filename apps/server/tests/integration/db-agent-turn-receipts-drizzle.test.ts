import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentSessionsRepo } from '../../src/db/agent-sessions-repo.js';
import { DrizzleAgentTurnReceiptsRepo } from '../../src/db/agent-turn-receipts-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  it('CRITICAL the service was reachable, so a green here is not "no service"', () => {
    // Without this, every arm below early-returns against a dead service and the
    // file reports PASSED — a green meaning "nothing was tested".
    expect(dbReachable, 'the integration dependency was unreachable').toBeTruthy();
  });

  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM agent_turn_receipts LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM agent_turn_receipts WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent-turn receipt Drizzle path against real Postgres',
  () => {
    it('atomically reserves one winner, stores ciphertext, replays exactly, and rejects cross-session reuse', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const handle = { client, db, close: async () => {} };
      const sessions = new DrizzleAgentSessionsRepo(handle, {
        transcriptEncryptionKeyBase64: ENCRYPTION_KEY,
      });
      const receipts = new DrizzleAgentTurnReceiptsRepo(handle, ENCRYPTION_KEY);
      const accountId = randomUUID();
      seeded.push(accountId);
      await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`turn-receipt-${accountId}@test.local`})`;
      const firstSession = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
      const secondSession = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
      const args = {
        accountId,
        agentSessionId: firstSession.id,
        idempotencyKey: 'drizzle-turn-1',
        requestHash: 'a'.repeat(64),
      };

      const race = await Promise.all([receipts.reserve(args), receipts.reserve(args)]);
      expect(race.map((result) => result.kind).sort()).toEqual(['in-progress', 'reserved']);
      await receipts.complete({
        ...args,
        terminal: { status: 200, body: { kind: 'plan-executed', marker: 'secret-body' } },
      });
      await expect(receipts.reserve(args)).resolves.toEqual({
        kind: 'replay',
        terminal: {
          status: 200,
          body: { kind: 'plan-executed', marker: 'secret-body' },
        },
      });

      const [stored] = await client<
        Array<{ response_ciphertext: Buffer; state: string }>
      >`SELECT response_ciphertext, state FROM agent_turn_receipts WHERE account_id = ${accountId} AND idempotency_key = 'drizzle-turn-1'`;
      expect(stored?.state).toBe('completed');
      expect(stored?.response_ciphertext.toString('utf8')).not.toContain('secret-body');

      await expect(
        receipts.reserve({ ...args, agentSessionId: secondSession.id }),
      ).resolves.toEqual({ kind: 'mismatch' });
    });

    it('binds ciphertext to every replay identity field and rejects tamper or a wrong key', async () => {
      if (!dbReachable || !client) return;
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const handle = { client, db, close: async () => {} };
      const sessions = new DrizzleAgentSessionsRepo(handle, {
        transcriptEncryptionKeyBase64: ENCRYPTION_KEY,
      });
      const receipts = new DrizzleAgentTurnReceiptsRepo(handle, ENCRYPTION_KEY);
      const wrongKeyReceipts = new DrizzleAgentTurnReceiptsRepo(
        handle,
        Buffer.alloc(32, 24).toString('base64'),
      );
      const accountId = randomUUID();
      const otherAccountId = randomUUID();
      seeded.push(accountId, otherAccountId);
      await client`INSERT INTO accounts (id, email) VALUES
        (${accountId}, ${`turn-receipt-aad-${accountId}@test.local`}),
        (${otherAccountId}, ${`turn-receipt-aad-${otherAccountId}@test.local`})`;
      const firstSession = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
      const secondSession = await sessions.create({ accountId, tokenBudgetTotal: 1000 });
      const args = {
        accountId,
        agentSessionId: firstSession.id,
        idempotencyKey: 'drizzle-turn-aad',
        requestHash: 'b'.repeat(64),
      };
      const terminal = {
        status: 201,
        body: { kind: 'plan-executed', marker: 'record-bound-body' },
      };

      await expect(receipts.reserve(args)).resolves.toEqual({ kind: 'reserved' });
      await receipts.complete({ ...args, terminal });
      const [stored] = await client<
        Array<{ response_ciphertext: Buffer }>
      >`SELECT response_ciphertext FROM agent_turn_receipts
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      expect(stored?.response_ciphertext).toBeInstanceOf(Buffer);
      const originalCiphertext = Buffer.from(stored!.response_ciphertext);

      await expect(wrongKeyReceipts.reserve(args)).rejects.toThrow();

      await client`UPDATE agent_turn_receipts SET response_status = 202
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(receipts.reserve(args)).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET response_status = 201
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;

      const movedHash = 'c'.repeat(64);
      await client`UPDATE agent_turn_receipts SET request_hash = ${movedHash}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(receipts.reserve({ ...args, requestHash: movedHash })).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET request_hash = ${args.requestHash}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;

      await client`UPDATE agent_turn_receipts SET agent_session_id = ${secondSession.id}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(
        receipts.reserve({ ...args, agentSessionId: secondSession.id }),
      ).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET agent_session_id = ${firstSession.id}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;

      const movedKey = 'drizzle-turn-aad-moved';
      await client`UPDATE agent_turn_receipts SET idempotency_key = ${movedKey}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(receipts.reserve({ ...args, idempotencyKey: movedKey })).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET idempotency_key = ${args.idempotencyKey}
        WHERE account_id = ${accountId} AND idempotency_key = ${movedKey}`;

      await client`UPDATE agent_turn_receipts SET account_id = ${otherAccountId}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(receipts.reserve({ ...args, accountId: otherAccountId })).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET account_id = ${accountId}
        WHERE account_id = ${otherAccountId} AND idempotency_key = ${args.idempotencyKey}`;

      const tamperedCiphertext = Buffer.from(originalCiphertext);
      const lastCiphertextByte = tamperedCiphertext.length - 1;
      tamperedCiphertext[lastCiphertextByte] = tamperedCiphertext[lastCiphertextByte]! ^ 1;
      await client`UPDATE agent_turn_receipts SET response_ciphertext = ${tamperedCiphertext}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;
      await expect(receipts.reserve(args)).rejects.toThrow();
      await client`UPDATE agent_turn_receipts SET response_ciphertext = ${originalCiphertext}
        WHERE account_id = ${accountId} AND idempotency_key = ${args.idempotencyKey}`;

      await expect(receipts.reserve(args)).resolves.toEqual({ kind: 'replay', terminal });
      await expect(receipts.complete({ ...args, terminal })).resolves.toBeUndefined();
      await expect(
        receipts.complete({
          ...args,
          terminal: { status: 201, body: { kind: 'plan-executed', marker: 'different' } },
        }),
      ).rejects.toThrow('agent-turn receipt could not be completed atomically');
    });
  },
);
