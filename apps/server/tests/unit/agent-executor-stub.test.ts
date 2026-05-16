// AI-B2 — unit tests for StubAgentExecutor + runResultToTranscriptEntry.
//
// Covers:
// - Every intent kind returns synthetic success
// - capture intent emits a captureId
// - ok=true when all succeed
// - runResultToTranscriptEntry serialization shape (✓/✗ prefixes,
//   halt-on-failure suffix)

import { describe, expect, it } from 'vitest';
import {
  StubAgentExecutor,
  runResultToTranscriptEntry,
  type ExecutorRunResult,
} from '../../src/services/agent-executor.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';

const ALL_INTENT_KINDS: AgentIntent[] = [
  { kind: 'navigate', url: 'https://example.com' },
  { kind: 'interact', action: 'tap', selector: '#submit' },
  { kind: 'interact', action: 'type', selector: '#name', value: 'Driftstack' },
  { kind: 'wait', condition: 'idle' },
  { kind: 'wait', condition: 'selector_visible', selector: '#ready', timeoutMs: 5000 },
  { kind: 'capture', capture: 'screenshot' },
  { kind: 'capture', capture: 'dom_snapshot' },
];

describe('AI-B2 StubAgentExecutor', () => {
  it('executes a full plan returning synthetic success for every intent', async () => {
    const exec = new StubAgentExecutor();
    const result = await exec.execute({
      sessionId: 'ses_xyz',
      plan: { kind: 'plan', intents: ALL_INTENT_KINDS, tokensConsumed: 1234 },
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(ALL_INTENT_KINDS.length);
    expect(result.results.every((r) => r.kind === 'success')).toBe(true);
  });

  it('capture intent results carry a captureId in the form cap_stub_{sessionId}_{n}', async () => {
    const exec = new StubAgentExecutor();
    const result = await exec.execute({
      sessionId: 'ses_xyz',
      plan: {
        kind: 'plan',
        intents: [
          { kind: 'navigate', url: 'https://example.com' },
          { kind: 'capture', capture: 'screenshot' },
          { kind: 'capture', capture: 'dom_snapshot' },
        ],
        tokensConsumed: 0,
      },
    });
    const captures = result.results.filter((r) => r.kind === 'success' && 'captureId' in r);
    expect(captures).toHaveLength(2);
    expect((captures[0] as { captureId: string }).captureId).toBe('cap_stub_ses_xyz_2');
    expect((captures[1] as { captureId: string }).captureId).toBe('cap_stub_ses_xyz_3');
  });

  it('summary string for navigate intent mentions the URL', async () => {
    const exec = new StubAgentExecutor();
    const result = await exec.execute({
      sessionId: 'ses_xyz',
      plan: {
        kind: 'plan',
        intents: [{ kind: 'navigate', url: 'https://example.com' }],
        tokensConsumed: 0,
      },
    });
    const first = result.results[0];
    if (first?.kind !== 'success') throw new Error('expected success');
    expect(first.summary).toMatch(/https:\/\/example\.com/);
  });

  it('does NOT throw — failures surface as IntentResult discriminants (stub is all-success; this test asserts the contract via resolve)', async () => {
    const exec = new StubAgentExecutor();
    await expect(
      exec.execute({
        sessionId: 'ses_xyz',
        plan: { kind: 'plan', intents: [], tokensConsumed: 0 },
      }),
    ).resolves.toEqual({ results: [], ok: true });
  });
});

describe('AI-B2 runResultToTranscriptEntry', () => {
  it('serializes all-success run as ✓-prefixed lines', () => {
    const runResult: ExecutorRunResult = {
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://example.com' },
          summary: 'navigated to https://example.com',
        },
      ],
      ok: true,
    };
    const entry = runResultToTranscriptEntry(runResult, '2026-05-16T00:00:00Z');
    expect(entry.role).toBe('agent');
    expect(entry.body).toContain('✓ navigated to https://example.com');
    expect(entry.body).not.toContain('plan halted');
  });

  it('serializes partial-failure run with ✗ prefix on the failed intent + halt suffix', () => {
    const runResult: ExecutorRunResult = {
      results: [
        {
          kind: 'success',
          intent: { kind: 'navigate', url: 'https://example.com' },
          summary: 'navigated to https://example.com',
        },
        {
          kind: 'failure',
          intent: { kind: 'interact', action: 'tap', selector: '#missing' },
          reason: 'selector not found',
        },
      ],
      ok: false,
    };
    const entry = runResultToTranscriptEntry(runResult, '2026-05-16T00:00:00Z');
    expect(entry.body).toContain('✓ navigated to https://example.com');
    expect(entry.body).toContain('✗ interact — selector not found');
    expect(entry.body).toContain('(plan halted on failure)');
  });

  it('uses agent role on transcript entries (so the decomposer sees them as its own prior turns)', () => {
    const runResult: ExecutorRunResult = { results: [], ok: true };
    const entry = runResultToTranscriptEntry(runResult, '2026-05-16T00:00:00Z');
    expect(entry.role).toBe('agent');
  });
});
