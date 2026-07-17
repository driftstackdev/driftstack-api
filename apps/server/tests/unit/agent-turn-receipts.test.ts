import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_RECEIPT_MAX_RESPONSE_BYTES,
  hashAgentTurnRequest,
  InMemoryAgentTurnReceiptsRepo,
} from '../../src/services/agent-turn-receipts.js';

const base = {
  accountId: '00000000-0000-4000-8000-000000000001',
  agentSessionId: 'agt_00000000-0000-4000-8000-000000000002',
  idempotencyKey: 'turn-1',
  requestHash: 'a'.repeat(64),
};

describe('agent-turn idempotency receipts', () => {
  it('binds only semantic turn fields while preserving the legacy-null canonical digest', () => {
    const key = 'sk-ant-secret-never-persist-me';
    const semanticTurn = {
      agentSessionId: base.agentSessionId,
      userMessage: 'submit the form',
      approveConsequentialActions: [{ category: 'purchase', matched_text: 'buy now' }],
    };
    const digest = hashAgentTurnRequest(semanticTurn);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe('82a956d2d258d91f90ef09023efddae7aa8170b9509bf3e2c07ce19004273259');
    // The field-deletion digest requires a guarded data/AAD migration. It must
    // never replace the compatibility digest as a cleanup shortcut.
    expect(digest).not.toBe('715b1e13d68518f4c4d11494c76ee13a3022d6c452f002ad8a4ab052ff0e92a6');

    type HashArgs = Parameters<typeof hashAgentTurnRequest>[0];
    type CredentialInputWasRemoved = 'explicitByokApiKey' extends keyof HashArgs ? never : true;
    const credentialInputWasRemoved: CredentialInputWasRemoved = true;
    expect(credentialInputWasRemoved).toBe(true);

    // Structural JavaScript/TypeScript callers can still carry unrelated legacy
    // properties. They are ignored rather than becoming a secret equality oracle.
    const originalLegacyPayload = { ...semanticTurn, explicitByokApiKey: key };
    const rotatedLegacyPayload = { ...semanticTurn, explicitByokApiKey: `${key}-rotated` };
    expect(hashAgentTurnRequest(originalLegacyPayload)).toBe(digest);
    expect(hashAgentTurnRequest(rotatedLegacyPayload)).toBe(digest);

    expect(
      hashAgentTurnRequest({
        agentSessionId: `${base.agentSessionId}-different`,
        userMessage: 'submit the form',
      }),
    ).not.toBe(digest);
    expect(
      hashAgentTurnRequest({ ...semanticTurn, userMessage: 'submit a different form' }),
    ).not.toBe(digest);
    expect(
      hashAgentTurnRequest({
        ...semanticTurn,
        approveConsequentialActions: [
          { category: 'purchase', matched_text: 'buy now' },
          { category: 'external-side-effect', matched_text: 'send it' },
        ],
      }),
    ).not.toBe(
      hashAgentTurnRequest({
        ...semanticTurn,
        approveConsequentialActions: [
          { category: 'external-side-effect', matched_text: 'send it' },
          { category: 'purchase', matched_text: 'buy now' },
        ],
      }),
    );
  });

  it('reserves once, reports overlap, and replays the exact completed terminal body', async () => {
    const repo = new InMemoryAgentTurnReceiptsRepo();
    await expect(repo.reserve(base)).resolves.toEqual({ kind: 'reserved' });
    await expect(repo.reserve(base)).resolves.toEqual({ kind: 'in-progress' });

    const terminal = {
      status: 200,
      body: { kind: 'plan-executed', ok: true, nested: { count: 1 } },
    };
    await repo.complete({ ...base, terminal });
    terminal.body.nested.count = 99;
    await expect(repo.reserve(base)).resolves.toEqual({
      kind: 'replay',
      terminal: {
        status: 200,
        body: { kind: 'plan-executed', ok: true, nested: { count: 1 } },
      },
    });
  });

  it('rejects key reuse across bodies or sessions but scopes identical keys by account', async () => {
    const repo = new InMemoryAgentTurnReceiptsRepo();
    await repo.reserve(base);
    await expect(repo.reserve({ ...base, requestHash: 'b'.repeat(64) })).resolves.toEqual({
      kind: 'mismatch',
    });
    await expect(
      repo.reserve({ ...base, agentSessionId: `${base.agentSessionId}-other` }),
    ).resolves.toEqual({ kind: 'mismatch' });
    await expect(
      repo.reserve({ ...base, accountId: '00000000-0000-4000-8000-000000000099' }),
    ).resolves.toEqual({ kind: 'reserved' });
  });

  it('fails closed on missing/different completion and bounds persisted response bytes', async () => {
    const repo = new InMemoryAgentTurnReceiptsRepo();
    await expect(
      repo.complete({ ...base, terminal: { status: 200, body: { ok: true } } }),
    ).rejects.toThrow('missing or mismatched');

    await repo.reserve(base);
    await repo.complete({ ...base, terminal: { status: 409, body: { detail: 'first' } } });
    await expect(
      repo.complete({ ...base, terminal: { status: 409, body: { detail: 'second' } } }),
    ).rejects.toThrow('different result');

    const oversized = new InMemoryAgentTurnReceiptsRepo();
    await oversized.reserve(base);
    await expect(
      oversized.complete({
        ...base,
        terminal: { status: 200, body: 'x'.repeat(AGENT_TURN_RECEIPT_MAX_RESPONSE_BYTES + 1) },
      }),
    ).rejects.toThrow('exceeds');
  });
});
