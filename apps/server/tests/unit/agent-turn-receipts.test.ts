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
  it('binds the digest to session, body, approvals, and an irreversible explicit-BYOK fingerprint', () => {
    const key = 'sk-ant-secret-never-persist-me';
    const digest = hashAgentTurnRequest({
      agentSessionId: base.agentSessionId,
      userMessage: 'submit the form',
      approveConsequentialActions: [{ category: 'purchase', matched_text: 'buy now' }],
      explicitByokApiKey: key,
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(key);
    expect(
      hashAgentTurnRequest({
        agentSessionId: base.agentSessionId,
        userMessage: 'submit the form',
        approveConsequentialActions: [{ category: 'purchase', matched_text: 'buy now' }],
        explicitByokApiKey: key,
      }),
    ).toBe(digest);
    expect(
      hashAgentTurnRequest({
        agentSessionId: base.agentSessionId,
        userMessage: 'submit the form',
        approveConsequentialActions: [{ category: 'purchase', matched_text: 'buy now' }],
        explicitByokApiKey: `${key}-different`,
      }),
    ).not.toBe(digest);
    expect(
      hashAgentTurnRequest({
        agentSessionId: `${base.agentSessionId}-different`,
        userMessage: 'submit the form',
      }),
    ).not.toBe(digest);
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
