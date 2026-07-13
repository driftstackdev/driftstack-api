// AI-B2.b/c — unit tests for RealAgentExecutor.
//
// Covers:
// - dispatch against the SessionsService port for navigate / interact:tap /
//   interact:type / interact:scroll / wait / capture → success
// - AI-B2.c vocab reconciliation: wait selector_visible→{kind:selector},
//   idle→{kind:time}; scroll→one-viewport vertical (down/up via value)
// - interact:swipe → typed failure (no driver gesture)
// - tap/type missing selector/value + wait:selector_visible missing selector
//   → typed failure
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
  wait: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
} {
  const navigate = vi.fn(() => Promise.resolve({ finalUrl: 'https://ex.com/final', status: 200 }));
  const interact = vi.fn(() => Promise.resolve({ durationMs: 12 }));
  const wait = vi.fn(() => Promise.resolve({ satisfied: true }));
  const capture = vi.fn(() => Promise.resolve({ kind: 'screenshot' as const, byteSize: 4096 }));
  const port = { navigate, interact, wait, capture, ...overrides };
  return { port, navigate, interact, wait, capture };
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

  it('interact:press maps value → key on a discriminated press action (W540)', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'press', value: 'Enter' }]),
    });
    expect(r.ok).toBe(true);
    expect(interact).toHaveBeenCalledWith(account, 'ses_1', {
      action: { kind: 'press', key: 'Enter' },
    });
  });

  it('interact:press without a value → typed failure, no dispatch (W540)', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'press' }]),
    });
    expect(r.results[0]).toMatchObject({
      kind: 'failure',
      reason: expect.stringMatching(/press requires a value/) as unknown,
    });
    expect(interact).not.toHaveBeenCalled();
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
  it('consumes one consequential approval before dispatching a repeated match', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const callerApprovals = new Set(['purchase:buy now']);
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([
        { kind: 'interact', action: 'tap', selector: '#primary', value: 'Buy Now' },
        { kind: 'interact', action: 'tap', selector: '#secondary', value: 'Buy Now' },
      ]),
      approvedConsequentialActions: callerApprovals,
    });
    expect(interact).toHaveBeenCalledTimes(1);
    expect(r.results.map((item) => item.kind)).toEqual(['success', 'confirmation_required']);
    expect(r.awaitingConfirmation).toBe(true);
    expect(callerApprovals.size).toBe(1);
  });

  it('wait:idle → time-bounded driver wait (idle has no driver predicate)', async () => {
    const { port, wait } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'wait', condition: 'idle', timeoutMs: 2000 }]),
    });
    expect(r.ok).toBe(true);
    expect(wait).toHaveBeenCalledWith(account, 'ses_1', { condition: { kind: 'time', ms: 2000 } });
  });

  it('wait:selector_visible → driver selector wait; missing selector → typed failure', async () => {
    const { port, wait } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const ok = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'wait', condition: 'selector_visible', selector: '#ready' }]),
    });
    expect(ok.ok).toBe(true);
    expect(wait).toHaveBeenCalledWith(account, 'ses_1', {
      condition: { kind: 'selector', selector: '#ready' },
    });
    const bad = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'wait', condition: 'selector_visible' }]),
    });
    expect(bad.ok).toBe(false);
    expect(bad.results[0]?.kind === 'failure' && bad.results[0].reason).toContain('selector');
  });

  it('scroll → one-viewport vertical scroll; down by default, up via value', async () => {
    const { port, interact } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'scroll' }]),
    });
    expect(interact).toHaveBeenCalledWith(account, 'ses_1', {
      action: { kind: 'scroll', delta_x: 0, delta_y: 600 },
    });
    interact.mockClear();
    await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'scroll', value: 'up' }]),
    });
    expect(interact).toHaveBeenCalledWith(account, 'ses_1', {
      action: { kind: 'scroll', delta_x: 0, delta_y: -600 },
    });
  });

  it('swipe → typed failure (no driver gesture); halts the plan', async () => {
    const { port } = makePort();
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'interact', action: 'swipe' }]),
    });
    expect(r.ok).toBe(false);
    expect(r.results[0]?.kind === 'failure' && r.results[0].reason).toContain(
      'swipe is not supported',
    );
  });

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
        { kind: 'interact', action: 'swipe' }, // fails (no driver gesture)
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

  it('redacts credentials from a throwing SessionsService diagnostic', async () => {
    const { port } = makePort({
      navigate: vi.fn(() =>
        Promise.reject(
          new Error(
            'upstream https://user:hunter2@internal.test/cb?code=AUTH_CODE rejected Bearer live-token-secret',
          ),
        ),
      ),
    });
    const exec = new RealAgentExecutor({ sessions: port });
    const r = await exec.execute({
      account,
      sessionId: 'ses_1',
      plan: plan([{ kind: 'navigate', url: 'https://ex.com' }]),
    });
    const result = r.results[0];
    if (result?.kind !== 'failure') throw new Error('narrow');
    expect(result.reason).not.toMatch(/hunter2|AUTH_CODE|live-token-secret/);
    expect(result.reason).toContain('https://[redacted]@internal.test');
    expect(result.reason).toContain('code=[redacted]');
    expect(result.reason).toContain('Bearer [redacted]');
  });
});
