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
  it('counts active and provisioning (paused/closed do not consume a slot)', () => {
    expect(
      countActiveAgentSessions([
        { status: 'active' },
        { status: 'paused' },
        { status: 'closed' },
        { status: 'active' },
      ]),
    ).toBe(2);
  });

  // V-218 — the control plane now reports `provisioning` for a session whose node
  // has begun bring-up and not yet reported a browser. Server-side that row still
  // counts against the concurrency cap (the cap reads the STORED status, which is
  // `active`), so a client that ignored it would show a smaller number than the
  // server enforces — and the customer would see "cap reached" with fewer sessions
  // listed than the cap allows, which is the confusing direction.
  it('CRITICAL counts a `provisioning` session — it holds a slot, and a VPN session can sit there for the whole bring-up', () => {
    expect(countActiveAgentSessions([{ status: 'provisioning' }, { status: 'active' }])).toBe(2);
  });

  it('CRITICAL VACUITY CONTROL: the widening is exactly two statuses — an unknown status still does not count, so a future value cannot silently start consuming slots', () => {
    expect(
      countActiveAgentSessions([{ status: 'terminating' }, { status: 'creating' }, { status: '' }]),
    ).toBe(0);
  });

  it('a stale liveness beat still suppresses a provisioning session, exactly as it does an active one', () => {
    expect(countActiveAgentSessions([{ status: 'provisioning', liveness: { fresh: false } }])).toBe(
      0,
    );
  });

  it('a present-but-STALE liveness beat (worker went silent) does not count; absent or fresh does', () => {
    expect(
      countActiveAgentSessions([
        { status: 'active', liveness: { fresh: false } }, // zombie — worker silent
        { status: 'active', liveness: { fresh: true } }, // genuinely live
        { status: 'active' }, // no fleet control plane → trust the binding
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
