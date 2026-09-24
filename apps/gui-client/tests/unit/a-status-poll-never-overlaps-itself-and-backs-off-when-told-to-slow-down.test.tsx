import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { RateLimitError } from '@driftstack/sdk';

/**
 * GUI audit #12 — the app's status polls were `setInterval`s that fired whether
 * or not the previous request had come back, over an SDK that itself retries a
 * 429 three times. Against a limited account each 5 s tick started a chain
 * lasting 30 s or more, so the chains overlapped and the request rate ROSE
 * exactly when the server asked it to fall — keeping the account limited and
 * failing every other call the app made.
 *
 * Now a poll keeps its cadence but skips a tick while the previous request is
 * still out (the in-flight guard), and a slow-down answer — 429, with or without
 * Retry-After — holds every tick back by at least what the server asked.
 *
 * The live AI view's session poll is driven for real here (5 s cadence, fake
 * clock); the Simulator's page-state poll has its own file.
 */

const get = vi.fn<(id: string) => Promise<unknown>>();
const livekitToken = vi.fn(() =>
  Promise.resolve({ ws_url: 'wss://lk.example.test', room: 'r', token: 't' }),
);
const CLIENT = { agentSessions: { get, livekitToken } };

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ client: CLIENT, settings: { apiKey: 'k', baseUrl: 'https://x' } }),
}));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => {
    useEffect(() => undefined, []);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

const { LiveAutomationPanel } = await import('../../src/views/agent-chat/LiveAutomationPanel');

function rateLimited(retryAfterSeconds: number): RateLimitError {
  return new RateLimitError(
    {
      type: 'https://errors.driftstack.dev/rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: 'x',
    },
    retryAfterSeconds,
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  livekitToken.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the live AI view's session poll", () => {
  it('CRITICAL never starts a request while the previous one is still out', async () => {
    get.mockImplementation(() => new Promise(() => {})); // a server that never answers
    render(<LiveAutomationPanel sessionId="agt_1" visible />);
    await advance(0);
    await advance(30_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL a 429 holds the next request back by the Retry-After it carries', async () => {
    get.mockImplementation(() => Promise.reject(rateLimited(60)));
    render(<LiveAutomationPanel sessionId="agt_1" visible />);
    await advance(0);
    expect(get).toHaveBeenCalledTimes(1);
    await advance(50_000);
    expect(get).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('CRITICAL a 429 without Retry-After still backs off rather than keeping the cadence', async () => {
    get.mockImplementation(() => Promise.reject(rateLimited(0)));
    render(<LiveAutomationPanel sessionId="agt_1" visible />);
    await advance(0);
    await advance(30_000);
    // The 5 s cadence would have made 7; backing off doubles each wait.
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('CONTROL — a healthy session is still polled every 5 s', async () => {
    get.mockImplementation(() => Promise.resolve({ status: 'active', closed_at: null }));
    render(<LiveAutomationPanel sessionId="agt_1" visible />);
    await advance(0);
    await advance(15_000);
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the shared guarded poll', () => {
  it('stops for good when told to', async () => {
    const { startGuardedPoll } = await import('../../src/lib/guarded-poll');
    const tick = vi.fn(() => Promise.resolve());
    const stop = startGuardedPoll(tick, { intervalMs: 1_000 });
    await advance(0);
    await advance(2_500);
    const calls = tick.mock.calls.length;
    stop();
    await advance(10_000);
    expect(tick.mock.calls.length).toBe(calls);
  });

  it('reads the wait from either error shape: the SDK rate-limit error or a control-API error', async () => {
    const { slowDownDelayMs } = await import('../../src/lib/guarded-poll');
    expect(slowDownDelayMs(rateLimited(30))).toBe(30_000);
    expect(slowDownDelayMs(rateLimited(0))).toBe(0);
    expect(slowDownDelayMs({ status: 429, retryAfterMs: 12_000 })).toBe(12_000);
    expect(slowDownDelayMs({ status: 429 })).toBe(0);
    expect(slowDownDelayMs({ status: 503, retryAfterMs: 5_000 })).toBe(5_000);
    // Not a slow-down: an ordinary failure keeps the normal cadence.
    expect(slowDownDelayMs({ status: 500 })).toBeNull();
    expect(slowDownDelayMs({ status: 503 })).toBeNull();
    expect(slowDownDelayMs(new Error('network'))).toBeNull();
  });
});
