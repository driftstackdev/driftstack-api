import { describe, expect, it, vi } from 'vitest';
import { reconcileWorkerReportedOrphans } from '../../src/services/cp-daemon-reconcile.js';
import type { AgentSessionsRepo } from '../../src/services/agent-sessions.js';

// Minimal AgentSessionsRepo stub — the helper only calls `get`. Each test maps
// sessionId → the row the CP holds (or null = absent), or makes `get` throw.
function repoFor(rows: Record<string, { status: string } | null | 'throw'>): AgentSessionsRepo {
  return {
    get: vi.fn((id: string): Promise<never> => {
      const r = rows[id];
      if (r === 'throw') return Promise.reject(new Error('db blip'));
      return Promise.resolve((r ?? null) as never);
    }),
  } as unknown as AgentSessionsRepo;
}

const logger = { info: vi.fn(), warn: vi.fn() } as never;

describe('reconcileWorkerReportedOrphans (CP↔daemon reconcile, A2 W2808)', () => {
  it('re-issues sessionEnd for an EXISTING non-active (CP-terminal) row', async () => {
    const sent: string[] = [];
    await reconcileWorkerReportedOrphans({
      agentSessions: repoFor({ s1: { status: 'closed' } }),
      activeSessionStates: { s1: 'running' },
      macNodeId: 'node-a',
      sendSessionEnd: (id) => sent.push(id),
      logger,
    });
    expect(sent).toEqual(['s1']);
  });

  it('does NOT re-issue for a live (active) row', async () => {
    const sent: string[] = [];
    await reconcileWorkerReportedOrphans({
      agentSessions: repoFor({ s1: { status: 'active' } }),
      activeSessionStates: { s1: 'running' },
      macNodeId: 'node-a',
      sendSessionEnd: (id) => sent.push(id),
      logger,
    });
    expect(sent).toEqual([]);
  });

  it('does NOT re-issue for an ABSENT row (new-session race guard)', async () => {
    const sent: string[] = [];
    await reconcileWorkerReportedOrphans({
      agentSessions: repoFor({ s1: null }),
      activeSessionStates: { s1: 'provisioning' },
      macNodeId: 'node-a',
      sendSessionEnd: (id) => sent.push(id),
      logger,
    });
    expect(sent).toEqual([]);
  });

  it('reconciles a mixed beat — only the CP-terminal sessions are ended', async () => {
    const sent: string[] = [];
    await reconcileWorkerReportedOrphans({
      agentSessions: repoFor({
        live: { status: 'active' },
        orphan1: { status: 'closed' },
        absent: null,
        orphan2: { status: 'errored' },
      }),
      activeSessionStates: {
        live: 'running',
        orphan1: 'running',
        absent: 'running',
        orphan2: 'running',
      },
      macNodeId: 'node-a',
      sendSessionEnd: (id) => sent.push(id),
      logger,
    });
    expect(sent.sort()).toEqual(['orphan1', 'orphan2']);
  });

  it('swallows a per-session lookup error and still reconciles the rest', async () => {
    const sent: string[] = [];
    await expect(
      reconcileWorkerReportedOrphans({
        agentSessions: repoFor({ bad: 'throw', orphan: { status: 'closed' } }),
        activeSessionStates: { bad: 'running', orphan: 'running' },
        macNodeId: 'node-a',
        sendSessionEnd: (id) => sent.push(id),
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(sent).toEqual(['orphan']);
  });
});
