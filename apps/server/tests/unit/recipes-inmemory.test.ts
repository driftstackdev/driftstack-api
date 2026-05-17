// AI-B4 — unit tests for InMemoryRecipesRepo + create contract.
//
// V1.0 scope is write-only. Tests pin:
//   - create() mints an rec_ id and returns the inserted record
//   - intent_log + transcript_snapshot are stored verbatim (no
//     normalization, no per-entry validation — the SnapshotService is
//     responsible for ensuring source data integrity)
//   - label trim + length validation (1..120 chars after trim)
//   - description length validation (<= 2000 chars)
//   - multiple recipes from the same agent_session under different
//     labels are allowed (no implicit uniqueness)

import { describe, expect, it } from 'vitest';
import { InMemoryRecipesRepo } from '../../src/services/recipes.js';

const SAMPLE_INTENTS = [
  { kind: 'navigate' as const, url: 'https://example.com' },
  { kind: 'wait' as const, condition: 'idle' as const },
  { kind: 'capture' as const, capture: 'dom_snapshot' as const },
];

const SAMPLE_TRANSCRIPT = [
  { at: '2026-05-17T12:00:00Z', role: 'user' as const, body: 'open example.com' },
  { at: '2026-05-17T12:00:01Z', role: 'agent' as const, body: 'planned 3 intents' },
];

describe('AI-B4 InMemoryRecipesRepo.create', () => {
  it('mints an rec_inmem_ id and returns the inserted record', async () => {
    const repo = new InMemoryRecipesRepo(() => new Date('2026-05-17T12:00:00Z'));
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'login flow snapshot',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.id).toMatch(/^rec_inmem_/);
    expect(r.accountId).toBe('acc_1');
    expect(r.agentSessionId).toBe('agt_inmem_xxx');
    expect(r.label).toBe('login flow snapshot');
    expect(r.description).toBeNull();
    expect(r.createdAt.toISOString()).toBe('2026-05-17T12:00:00.000Z');
  });

  it('stores intent_log + transcript verbatim — no normalization, no validation', async () => {
    const repo = new InMemoryRecipesRepo();
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'x',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.intentLog).toHaveLength(3);
    expect(r.intentLog[0]).toEqual({ kind: 'navigate', url: 'https://example.com' });
    expect(r.transcriptSnapshot).toHaveLength(2);
    expect(r.transcriptSnapshot[0]?.body).toBe('open example.com');
  });

  it('accepts NULL agentSessionId (out-of-band composition path; not v1.0)', async () => {
    const repo = new InMemoryRecipesRepo();
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: null,
      label: 'x',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.agentSessionId).toBeNull();
  });

  it('persists optional description', async () => {
    const repo = new InMemoryRecipesRepo();
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'login flow',
      description: 'Logs into the test account and captures the dashboard.',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.description).toBe('Logs into the test account and captures the dashboard.');
  });

  it('treats empty-string description as null (clean storage shape)', async () => {
    const repo = new InMemoryRecipesRepo();
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'x',
      description: '',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.description).toBeNull();
  });

  it('trims label whitespace before storage', async () => {
    const repo = new InMemoryRecipesRepo();
    const r = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: '   leading and trailing   ',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r.label).toBe('leading and trailing');
  });

  it('throws on empty / whitespace-only label', async () => {
    const repo = new InMemoryRecipesRepo();
    await expect(
      repo.create({
        accountId: 'acc_1',
        agentSessionId: 'agt_inmem_xxx',
        label: '   ',
        intentLog: SAMPLE_INTENTS,
        transcriptSnapshot: SAMPLE_TRANSCRIPT,
      }),
    ).rejects.toThrow(/Recipe label/);
  });

  it('throws on label > 120 characters', async () => {
    const repo = new InMemoryRecipesRepo();
    await expect(
      repo.create({
        accountId: 'acc_1',
        agentSessionId: 'agt_inmem_xxx',
        label: 'a'.repeat(121),
        intentLog: SAMPLE_INTENTS,
        transcriptSnapshot: SAMPLE_TRANSCRIPT,
      }),
    ).rejects.toThrow(/Recipe label/);
  });

  it('throws on description > 2000 characters', async () => {
    const repo = new InMemoryRecipesRepo();
    await expect(
      repo.create({
        accountId: 'acc_1',
        agentSessionId: 'agt_inmem_xxx',
        label: 'x',
        description: 'a'.repeat(2001),
        intentLog: SAMPLE_INTENTS,
        transcriptSnapshot: SAMPLE_TRANSCRIPT,
      }),
    ).rejects.toThrow(/description/);
  });

  it('allows multiple recipes from the same agent session under different labels (no implicit uniqueness)', async () => {
    const repo = new InMemoryRecipesRepo();
    const r1 = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'smoke test',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    const r2 = await repo.create({
      accountId: 'acc_1',
      agentSessionId: 'agt_inmem_xxx',
      label: 'regression #4',
      intentLog: SAMPLE_INTENTS,
      transcriptSnapshot: SAMPLE_TRANSCRIPT,
    });
    expect(r1.id).not.toBe(r2.id);
  });
});
