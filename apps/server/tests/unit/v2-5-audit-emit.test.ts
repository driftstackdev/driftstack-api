// v2-#5 Q.1.f — audit emission tests for
// DrizzleAgentDecomposerUsageRecorder.
//
// Pins:
//   1. When accountAudit is null, no audit emit happens (back-compat
//      for tests that don't wire one).
//   2. When accountAudit is set, claude usage → audit action =
//      'agent.decompose.claude'; deterministic usage → action =
//      'agent.decompose.deterministic'.
//   3. Audit emit failures DO NOT propagate — they're swallowed with
//      a warn-level log; the usage row still landed.
//   4. Audit payload mirrors the usage metadata (decomposer_kind +
//      decompose_result_kind + tokens_consumed + cost_usd_cents +
//      agent_session_id).

import { describe, expect, it, vi } from 'vitest';
import { DrizzleAgentDecomposerUsageRecorder } from '../../src/db/agent-decomposer-usage-recorder.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import type { Database } from '../../src/db/client.js';

function makeFakeDb(): { db: Database; inserts: Array<Record<string, unknown>> } {
  const inserts: Array<Record<string, unknown>> = [];
  const valuesFn = (row: Record<string, unknown>) => {
    inserts.push(row);
    return Promise.resolve(undefined);
  };
  const db = {
    db: {
      insert: () => ({ values: valuesFn }),
    },
  } as unknown as Database;
  return { db, inserts };
}

function makeFakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => makeFakeLogger(),
  } as unknown as Parameters<typeof DrizzleAgentDecomposerUsageRecorder>[1];
}

describe('v2-#5 Q.1.f DrizzleAgentDecomposerUsageRecorder audit emit', () => {
  it('null accountAudit → no emit, just usage insert', async () => {
    const { db, inserts } = makeFakeDb();
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), null);
    await rec.record({
      accountId: 'acc_1',
      driftstackSessionId: null,
      agentSessionId: 'aas_1',
      decomposeResultKind: 'plan',
      usage: { decomposerKind: 'deterministic' },
      tokensConsumed: 100,
      now: new Date('2026-05-17T22:00:00Z'),
    });
    expect(inserts).toHaveLength(1);
  });

  it("claude usage → audit action 'agent.decompose.claude' with full metadata payload", async () => {
    const { db } = makeFakeDb();
    const recordFn = vi.fn(() => Promise.resolve(undefined));
    const fakeAudit = { record: recordFn } as unknown as AccountAuditService;
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), fakeAudit);
    await rec.record({
      accountId: 'acc_1',
      driftstackSessionId: 'ses_xyz',
      agentSessionId: 'aas_1',
      decomposeResultKind: 'plan',
      usage: {
        decomposerKind: 'claude',
        anthropicInputTokens: 100,
        anthropicOutputTokens: 50,
        costUsdCents: 2,
        model: 'claude-opus-4-7',
      },
      tokensConsumed: 150,
      now: new Date('2026-05-17T22:00:00Z'),
    });
    expect(recordFn).toHaveBeenCalledTimes(1);
    const auditInput = recordFn.mock.calls[0]![0] as {
      accountId: string;
      action: string;
      actorType: string;
      targetResourceId: string;
      payload: Record<string, unknown>;
    };
    expect(auditInput.accountId).toBe('acc_1');
    expect(auditInput.action).toBe('agent.decompose.claude');
    expect(auditInput.actorType).toBe('system');
    expect(auditInput.targetResourceId).toBe('agent_session_aas_1');
    expect(auditInput.payload.decomposer_kind).toBe('claude');
    expect(auditInput.payload.decompose_result_kind).toBe('plan');
    expect(auditInput.payload.anthropic_input_tokens).toBe(100);
    expect(auditInput.payload.anthropic_output_tokens).toBe(50);
    expect(auditInput.payload.cost_usd_cents).toBe(2);
    expect(auditInput.payload.tokens_consumed).toBe(150);
    expect(auditInput.payload.agent_session_id).toBe('aas_1');
    expect(auditInput.payload.model).toBe('claude-opus-4-7');
  });

  it("deterministic usage → audit action 'agent.decompose.deterministic'", async () => {
    const { db } = makeFakeDb();
    const recordFn = vi.fn(() => Promise.resolve(undefined));
    const fakeAudit = { record: recordFn } as unknown as AccountAuditService;
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), fakeAudit);
    await rec.record({
      accountId: 'acc_2',
      driftstackSessionId: null,
      agentSessionId: 'aas_2',
      decomposeResultKind: 'refuse',
      usage: { decomposerKind: 'deterministic' },
      tokensConsumed: 0,
      now: new Date('2026-05-17T22:00:00Z'),
    });
    expect(recordFn).toHaveBeenCalledTimes(1);
    const auditInput = recordFn.mock.calls[0]![0] as { action: string };
    expect(auditInput.action).toBe('agent.decompose.deterministic');
  });

  // Arc 1 sub-slice 6.4 (v2-#6) — keySource='bundled' routes the
  // insert to record_type='agent_decomposer_bundled' AND writes the
  // posted $0.10 (10 cent) flat cost, hiding the actual upstream
  // Anthropic costUsdCents per Q5=A.
  it("v2-#6 sub-slice 6.4 keySource='bundled' → record_type='agent_decomposer_bundled' + posted 10 cents", async () => {
    const { db, inserts } = makeFakeDb();
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), null);
    await rec.record({
      accountId: 'acc_bundled',
      driftstackSessionId: null,
      agentSessionId: 'aas_b1',
      decomposeResultKind: 'plan',
      usage: {
        decomposerKind: 'claude',
        anthropicInputTokens: 1000,
        anthropicOutputTokens: 500,
        // Actual upstream cost — must NOT appear in the metadata when
        // keySource='bundled' (Q5=A hide).
        costUsdCents: 45,
        model: 'claude-opus-4-7',
      },
      tokensConsumed: 1500,
      now: new Date('2026-05-18T10:00:00Z'),
      keySource: 'bundled',
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row.recordType).toBe('agent_decomposer_bundled');
    expect((row.metadata as Record<string, unknown>).cost_usd_cents).toBe(10);
    expect((row.metadata as Record<string, unknown>).cost_basis).toBe('bundled_flat_per_turn');
    expect((row.metadata as Record<string, unknown>).key_source).toBe('bundled');
  });

  it("v2-#6 sub-slice 6.4 keySource='header' → record_type='agent_decomposer' + real upstream cost preserved", async () => {
    const { db, inserts } = makeFakeDb();
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), null);
    await rec.record({
      accountId: 'acc_byok',
      driftstackSessionId: null,
      agentSessionId: 'aas_h1',
      decomposeResultKind: 'plan',
      usage: {
        decomposerKind: 'claude',
        anthropicInputTokens: 1000,
        anthropicOutputTokens: 500,
        costUsdCents: 45,
        model: 'claude-opus-4-7',
      },
      tokensConsumed: 1500,
      now: new Date('2026-05-18T10:00:00Z'),
      keySource: 'header',
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row.recordType).toBe('agent_decomposer');
    expect((row.metadata as Record<string, unknown>).cost_usd_cents).toBe(45);
    expect((row.metadata as Record<string, unknown>).cost_basis).toBeUndefined();
    expect((row.metadata as Record<string, unknown>).key_source).toBe('header');
  });

  it('audit emit failure → swallowed; usage insert still landed', async () => {
    const { db, inserts } = makeFakeDb();
    const recordFn = vi.fn(() => Promise.reject(new Error('audit table down')));
    const fakeAudit = { record: recordFn } as unknown as AccountAuditService;
    const rec = new DrizzleAgentDecomposerUsageRecorder(db, makeFakeLogger(), fakeAudit);
    // No exception escapes.
    await rec.record({
      accountId: 'acc_3',
      driftstackSessionId: null,
      agentSessionId: 'aas_3',
      decomposeResultKind: 'plan',
      usage: { decomposerKind: 'deterministic' },
      tokensConsumed: 0,
      now: new Date('2026-05-17T22:00:00Z'),
    });
    expect(inserts).toHaveLength(1);
    expect(recordFn).toHaveBeenCalledTimes(1);
  });
});
