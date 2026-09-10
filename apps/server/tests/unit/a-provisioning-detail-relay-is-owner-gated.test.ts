// (c) 2026-09-10 — the provisioning-detail relay: a harness `sessionStatus` frame
// with status 'provisioning' + a snake_case TOKEN (today: vpn_egress_active — the
// VPN tunnel is up, the browser has not attached yet) lands on the session as
// provisioning_detail; 'active' and terminal frames clear it. Three properties
// pinned here answer the review of the first version: tokens only (prose never
// persists nor overwrites), fail-closed ownership (a NULL owner accepts nobody),
// and ordered, unconditional clears (no read-compare-write race between a
// provisioning frame and the active frame replayed right behind it).
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../src/schemas/harness-control-protocol.js';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import {
  handleSessionProvisioningDetail,
  makeSessionProvisioningDetailRelay,
  PROVISIONING_DETAIL_TOKEN_RE,
} from '../../src/services/session-provisioning-detail-relay.js';

function frame(status: string, detail?: string): SessionStatus {
  return {
    type: 'sessionStatus',
    sessionId: 'as_1',
    status,
    ...(detail !== undefined ? { detail } : {}),
  } as unknown as SessionStatus;
}
function session(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'as_1',
    nodeId: 'mac-owner',
    status: 'creating',
    provisioningDetail: null,
    ...over,
  } as unknown as AgentSessionRecord;
}
function deps(rec: AgentSessionRecord | null) {
  const setProvisioningDetail = vi.fn((_id: string, _d: string | null) => Promise.resolve(rec));
  return {
    agentSessions: { get: vi.fn(() => Promise.resolve(rec)), setProvisioningDetail },
    setProvisioningDetail,
  };
}
const OWNER = 'mac-owner';
const T = 'vpn_egress_active';

describe('provisioning-detail relay — tokens, ownership, clears', () => {
  it('CRITICAL the OWNING node sets the token on a provisioning frame', async () => {
    const d = deps(session());
    expect(await handleSessionProvisioningDetail(d, frame('provisioning', T), OWNER)).toBe('set');
    expect(d.setProvisioningDetail).toHaveBeenCalledWith('as_1', T);
  });

  it('CRITICAL a NON-owning node is ignored, and so is a NULL owner (fail closed, like every sibling relay)', async () => {
    const rogue = deps(session());
    expect(
      await handleSessionProvisioningDetail(rogue, frame('provisioning', T), 'mac-rogue'),
    ).toBe('ignored');
    expect(rogue.setProvisioningDetail).not.toHaveBeenCalled();
    const unowned = deps(session({ nodeId: null }));
    expect(
      await handleSessionProvisioningDetail(unowned, frame('provisioning', T), 'mac-any'),
    ).toBe('ignored');
    expect(unowned.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('CRITICAL only a snake_case TOKEN persists — the harness’s diagnostic prose never lands on the public read', async () => {
    for (const prose of [
      'duplicate session assign ignored (idempotent)',
      'provision already in flight (idempotent)',
      'VPN Egress Active',
      'x'.repeat(65),
      '',
    ]) {
      const d = deps(session());
      expect(
        await handleSessionProvisioningDetail(d, frame('provisioning', prose), OWNER),
        prose,
      ).toBe('ignored');
      expect(d.setProvisioningDetail, prose).not.toHaveBeenCalled();
    }
    for (const token of ['vpn_egress_bringing_up', 'vpn_egress_active', 'egress_geo_resolving']) {
      expect(PROVISIONING_DETAIL_TOKEN_RE.test(token), token).toBe(true);
    }
  });

  it("CRITICAL an 'active' frame clears UNCONDITIONALLY — even when the pre-read snapshot already says null", async () => {
    // The snapshot-gated clear was the race: a provisioning frame's write could land
    // after this handler had read null and decided there was nothing to clear.
    const d = deps(session({ provisioningDetail: null, status: 'active' }));
    expect(await handleSessionProvisioningDetail(d, frame('active'), OWNER)).toBe('cleared');
    expect(d.setProvisioningDetail).toHaveBeenCalledWith('as_1', null);
  });

  it('terminal frames (ended / errored) clear too — a closed session never reads as still provisioning', async () => {
    for (const s of ['ended', 'errored']) {
      const d = deps(session({ provisioningDetail: T }));
      expect(await handleSessionProvisioningDetail(d, frame(s), OWNER), s).toBe('cleared');
      expect(d.setProvisioningDetail, s).toHaveBeenCalledWith('as_1', null);
    }
  });

  it('a token never lands on a session that is already ACTIVE or CLOSED (a late replay cannot resurrect the step)', async () => {
    for (const s of ['active', 'closed']) {
      const d = deps(session({ status: s as AgentSessionRecord['status'] }));
      expect(await handleSessionProvisioningDetail(d, frame('provisioning', T), OWNER), s).toBe(
        'ignored',
      );
      expect(d.setProvisioningDetail, s).not.toHaveBeenCalled();
    }
  });

  it('a provisioning frame WITHOUT a detail, an unknown session, and an unrelated status are no-ops', async () => {
    const d = deps(session());
    expect(await handleSessionProvisioningDetail(d, frame('provisioning'), OWNER)).toBe('ignored');
    expect(await handleSessionProvisioningDetail(d, frame('reconnecting', T), OWNER)).toBe(
      'ignored',
    );
    expect(await handleSessionProvisioningDetail(deps(null), frame('provisioning', T), OWNER)).toBe(
      'ignored',
    );
    expect(d.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('an unchanged token is not re-written (no write churn on repeated frames)', async () => {
    const d = deps(session({ provisioningDetail: T }));
    expect(await handleSessionProvisioningDetail(d, frame('provisioning', T), OWNER)).toBe('set');
    expect(d.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('a repo failure is swallowed (fire-and-forget off the receive loop) and reads as ignored', async () => {
    const d = deps(session());
    d.agentSessions.setProvisioningDetail.mockRejectedValueOnce(new Error('db down'));
    expect(await handleSessionProvisioningDetail(d, frame('provisioning', T), OWNER)).toBe(
      'ignored',
    );
  });

  it('CRITICAL the relay applies frames for one session IN ORDER: provisioning then active, replayed back-to-back, ends null', async () => {
    // A repo whose reads resolve late, so a non-serialised relay would have both
    // handlers read before either writes — the exact race the harness reconnect
    // queue produces when it flushes [provisioning, active] FIFO after an outage.
    const writes: Array<string | null> = [];
    let state: AgentSessionRecord = session();
    const agentSessions = {
      get: vi.fn(() => new Promise<AgentSessionRecord>((r) => setTimeout(() => r(state), 5))),
      setProvisioningDetail: vi.fn((_id: string, d: string | null) => {
        writes.push(d);
        state = { ...state, provisioningDetail: d };
        return Promise.resolve(state);
      }),
    };
    const relay = makeSessionProvisioningDetailRelay(agentSessions, null);
    relay(frame('provisioning', T), OWNER);
    relay(frame('active'), OWNER);
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toEqual([T, null]);
    expect(state.provisioningDetail).toBeNull();
  });
});
