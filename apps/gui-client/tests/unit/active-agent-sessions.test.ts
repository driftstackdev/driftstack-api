// Consistency #5 — active-agent-sessions helper. Profile launches create
// `agt_` AGENT sessions the server's driver-only `concurrent_session_active`
// omits; these helpers fold them back into the GUI's "how many phones are
// running" surfaces. Pure count + best-effort fetch (degrades to null).

import { describe, it, expect, vi } from 'vitest';
import {
  countActiveAgentSessions,
  fetchActiveAgentSessionCount,
} from '../../src/lib/active-agent-sessions';
import type { DriftstackClient } from '../../src/lib/client';

describe('countActiveAgentSessions', () => {
  it('counts only status === active (paused/closed do not consume a slot)', () => {
    expect(
      countActiveAgentSessions([
        { status: 'active' },
        { status: 'paused' },
        { status: 'closed' },
        { status: 'active' },
      ]),
    ).toBe(2);
  });

  it('empty list → 0', () => {
    expect(countActiveAgentSessions([])).toBe(0);
  });
});

describe('fetchActiveAgentSessionCount', () => {
  it('null client → null (unknown, never treated as zero)', async () => {
    expect(await fetchActiveAgentSessionCount(null)).toBeNull();
  });

  it('client without an agentSessions resource (older deployment) → null, no throw', async () => {
    // A partial client shape — `agentSessions` absent. Must degrade to null
    // rather than throwing "Cannot read properties of undefined".
    const partial = {} as unknown as DriftstackClient;
    expect(await fetchActiveAgentSessionCount(partial)).toBeNull();
  });

  it('sums the active agent sessions from the list', async () => {
    const client = {
      agentSessions: {
        list: vi.fn(() =>
          Promise.resolve({
            data: [{ status: 'active' }, { status: 'closed' }, { status: 'active' }],
            has_more: false,
            next_cursor: null,
          }),
        ),
      },
    } as unknown as DriftstackClient;
    expect(await fetchActiveAgentSessionCount(client)).toBe(2);
  });

  it('a list failure (route 503 / network) → null (best-effort, never undercount)', async () => {
    const client = {
      agentSessions: { list: vi.fn(() => Promise.reject(new Error('503'))) },
    } as unknown as DriftstackClient;
    expect(await fetchActiveAgentSessionCount(client)).toBeNull();
  });
});
