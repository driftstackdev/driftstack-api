// AI-B2.b increment 1 — unit tests for RealAgentExecutor.
//
// Covers:
// - cleanly-mapping intents dispatch against the SessionsService port
//   (navigate / interact:tap / interact:type / capture) → success
// - the vocab-gap intents (wait / interact:scroll / interact:swipe) →
//   typed failure "pending vocabulary reconciliation (AI-B2.c)"
// - tap/type missing selector/value → typed failure
// - halt-on-first-failure (later intents not dispatched)
// - missing account context → typed failure (never throws)
// - a throwing SessionsService surfaces as a failure result (never throws)

import { describe, expect, it, vi } from 'vitest';
import { RealAgentExecutor, type ExecutorSessionsPort } from '../../src/services/agent-executor.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { AccountContext } from '../../src/services/auth.js';

// The executor only passes `account` through to the port (which the mock
// ignores), so a cast minimal ctx is sufficient for these unit tests.
const account = {} as unknown as AccountContext;

function makePort(overrides: Partial<ExecutorSessionsPort> = {}): {
  port: ExecutorSessionsPort;
  navigate: ReturnType<typeof vi.fn>;
  interact: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn(() => Promise.resolve({ finalUrl: 'https://ex.com/final', status: 200 }));
  const interact = vi.fn(() => Promise.resolve({ durationMs: 12 }));
  const capture = vi.fn(() => Promise.resolve({ kind: 'screenshot' as const, byteSize: 4096 }));
  const port = { navigate, interact, capture, ...overrides };
  return { port, navigate, interact, capture };
}

function plan(intents: AgentIntent[]) {
  return { kind: 'plan' as const, intents, tokensConsumed: 0 };
}

describe('AI-B2.b RealAgentExecutor — clean dispatch', () => {
  it('navigate dispatches to sessions.navigate and summarizes finalUrl + status', async () => {
    const { port, navigate } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'navigate', url: 'https://ex.com' }]),
    });
    expect(r.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith(account, 'ses_1', { url: 'https://ex.com' });
    expect(r.results[0]).toMatchObject({ kind: 'success' });
    expect(r.results[0]?.kind === 'success' && r.results[0].summary).toContain('status 200');
  });

  it('interact:tap dispatches a discriminated tap action', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'tap', selector: '#go' }]),
    });
    expect(r.ok).toBe(true);
    expect(interact).toHaveBeenCalledWith(account, 'ses_1', {
      action: { kind: 'tap', selector: '#go' },
    });
  });

  it('interact:type maps value → text on a discriminated type action', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'type', selector: '#name', value: 'Drift' }]),
    });
    expect(r.ok).toBe(true);
    expect(interact).toHaveBeenCalledWith(account, 'ses_1', {
      action: { kind: 'type', selector: '#name', text: 'Drift' },
    });
  });

  it('capture dispatches the matching CaptureKind and summarizes byteSize', async () => {
    const { port, capture } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'capture', capture: 'screenshot' }]),
    });
    expect(r.ok).toBe(true);
    expect(capture).toHaveBeenCalledWith(account, 'ses_1', { kind: 'screenshot' });
    expect(r.results[0]?.kind === 'success' && r.results[0].summary).toContain('4096 bytes');
  });
});

describe('AI-B2.b RealAgentExecutor — vocab gaps + guards', () => {
  it.each(['wait', 'scroll', 'swipe'] as const)(
    '%s returns a typed failure (pending vocabulary reconciliation), halting the plan',
    async (kind) => {
      const { port } = makePort();
      const exec = new RealAgentExecutor({ sessions: port });
      const intent: AgentIntent =
        kind === 'wait' ? { kind: 'wait', condition: 'idle' } : { kind: 'interact', action: kind };
      const r = await exec.execute({ account, sessionId: 'ses_1', plan: plan([intent]) });
      expect(r.ok).toBe(false);
      expect(r.results[0]).toMatchObject({ kind: 'failure' });
      expect(r.results[0]?.kind === 'failure' && r.results[0].reason).toContain(
        'pending vocabulary reconciliation',
      );
    },
  );

  it('tap without a selector → typed failure', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'tap' }]),
    });
    expect(r.ok).toBe(false);
    expect(interact).not.toHaveBeenCalled();
    expect(r.results[0]?.kind === 'failure' && r.results[0].reason).toContain('selector');
  });

  it('halts on first failure — later intents are not dispatched', async () => {
    const { port, capture } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([
        { kind: 'navigate', url: 'https://ex.com' },
        { kind: 'interact', action: 'scroll' }, // fails (vocab gap)
        { kind: 'capture', capture: 'screenshot' }, // must NOT run
      ]),
    });
    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(capture).not.toHaveBeenCalled();
  });

  it('missing account context → typed failure, never throws', async () => {
    const { port } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      sessionId: 'ses_1',
      plan: plan([{ kind: 'navigate', url: 'https://ex.com' }]),
    });
    expect(r.ok).toBe(false);
    expect(r.results[0]?.kind === 'failure' && r.results[0].reason).toContain('account context');
  });

  it('a throwing SessionsService surfaces as a failure result (never throws)', async () => {
    const { port } = makePort({
      navigate: vi.fn(() => Promise.reject(new Error('session destroyed'))),
    });
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'navigate', url: 'https://ex.com' }]),
    });
    expect(r.ok).toBe(false);
    expect(r.results[0]?.kind === 'failure' && r.results[0].reason).toBe('session destroyed');
  });
});
