import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REPO = readFileSync(resolve(ROOT, 'apps/server/src/db/agent-turn-receipts-repo.ts'), 'utf8');
const MIGRATION = readFileSync(
  resolve(ROOT, 'apps/server/src/db/migrations/0103_agent_turn_idempotency_receipts.sql'),
  'utf8',
);

describe('agent-turn durable receipt persistence', () => {
  it('uses an atomic account-wide key reservation and binds replay to session plus request hash', () => {
    expect(REPO).toContain('.onConflictDoNothing()');
    expect(REPO).toMatch(/eq\(agentTurnReceipts\.accountId, args\.accountId\)/);
    expect(REPO).toMatch(/existing\.agentSessionId !== args\.agentSessionId/);
    expect(REPO).toMatch(/existing\.requestHash !== args\.requestHash/);
    expect(MIGRATION).toContain(
      'CONSTRAINT "agent_turn_receipts_pk" PRIMARY KEY ("account_id", "idempotency_key")',
    );
  });

  it('encrypts every terminal body under its complete replay identity and completes only the matching reservation', () => {
    expect(REPO).toContain(
      "const AGENT_TURN_RECEIPT_AAD_PURPOSE = 'driftstack.agent-turn-receipt';",
    );
    expect(REPO).toMatch(
      /return JSON\.stringify\(\[\s*AGENT_TURN_RECEIPT_AAD_PURPOSE,\s*1,\s*args\.accountId,\s*args\.idempotencyKey,\s*args\.agentSessionId,\s*args\.requestHash,\s*args\.responseStatus,\s*\]\);/,
    );
    expect(REPO).toContain('encryptPlatformSecret(');
    expect(REPO).toContain('decryptPlatformSecret(');
    expect(REPO.match(/agentTurnReceiptAuthenticatedContext\(\{/g)).toHaveLength(2);
    expect(REPO).toMatch(
      /decryptPlatformSecret\([\s\S]*?agentTurnReceiptAuthenticatedContext\(\{[\s\S]*?accountId: row\.accountId,[\s\S]*?idempotencyKey: row\.idempotencyKey,[\s\S]*?agentSessionId: row\.agentSessionId,[\s\S]*?requestHash: row\.requestHash,[\s\S]*?responseStatus: row\.responseStatus,/,
    );
    expect(REPO).toMatch(
      /encryptPlatformSecret\([\s\S]*?agentTurnReceiptAuthenticatedContext\(\{[\s\S]*?accountId: args\.accountId,[\s\S]*?idempotencyKey: args\.idempotencyKey,[\s\S]*?agentSessionId: args\.agentSessionId,[\s\S]*?requestHash: args\.requestHash,[\s\S]*?responseStatus: terminal\.status,/,
    );
    expect(REPO).toMatch(/eq\(agentTurnReceipts\.state, 'in_progress'\)/);
    expect(MIGRATION).toContain('"response_ciphertext" bytea');
    expect(MIGRATION).toMatch(/"state" = 'completed'[\s\S]*"response_ciphertext" IS NOT NULL/);
    expect(MIGRATION).not.toContain('response_body');
  });

  it('pins bounded hashes, keys, statuses, and cascade cleanup to the owning account/session', () => {
    expect(MIGRATION).toContain('length("idempotency_key") BETWEEN 1 AND 255');
    expect(MIGRATION).toContain(`"request_hash" ~ '^[0-9a-f]{64}$'`);
    expect(MIGRATION).toContain('"response_status" BETWEEN 100 AND 599');
    expect(MIGRATION).toContain('REFERENCES "accounts"("id") ON DELETE CASCADE');
    expect(MIGRATION).toContain('REFERENCES "agent_sessions"("id") ON DELETE CASCADE');
  });
});
