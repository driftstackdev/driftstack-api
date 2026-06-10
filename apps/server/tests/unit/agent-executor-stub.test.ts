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
  consequentialSignature,
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

  // W443/W445 — consequential-action confirmation halt.
  it('halts BEFORE a consequential tap (confirmation_required + awaitingConfirmation); later intents do not run', async () => {
    const exec = new StubAgentExecutor();
    const result = await exec.execute({
      sessionId: 'sess_1',
      plan: {
        kind: 'plan',
        intents: [
          { kind: 'navigate', url: 'https://shop.example.com' },
          { kind: 'interact', action: 'tap', selector: 'Buy Now' },
          { kind: 'capture', capture: 'screenshot' },
        ],
        tokensConsumed: 1,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.awaitingConfirmation).toBe(true);
    // navigate ran; halted at the Buy Now tap; the capture never ran.
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.kind).toBe('success');
    const last = result.results[1]!;
    expect(last.kind).toBe('confirmation_required');
    if (last.kind === 'confirmation_required') {
      expect(last.category).toBe('purchase');
      expect(last.matchedText.toLowerCase()).toContain('buy now');
    }
  });

  it('proceeds past the consequential tap once its signature is approved', async () => {
    const exec = new StubAgentExecutor();
    const result = await exec.execute({
      sessionId: 'sess_1',
      plan: {
        kind: 'plan',
        intents: [
          { kind: 'interact', action: 'tap', selector: 'Buy Now' },
          { kind: 'capture', capture: 'screenshot' },
        ],
        tokensConsumed: 1,
      },
      approvedConsequentialActions: new Set([consequentialSignature('purchase', 'Buy Now')]),
    });
    expect(result.ok).toBe(true);
    expect(result.awaitingConfirmation).toBeUndefined();
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.kind === 'success')).toBe(true);
  });
});
