// (c) 2026-09-10 — the provisioning-detail relay: a harness `sessionStatus`
// frame with status 'provisioning' + a detail token (today: vpn_egress_active —
// the VPN tunnel is up, the browser has not attached yet) lands on the session
// as provisioning_detail so the customer read can say WHY it is still
// provisioning; an 'active' frame clears it. Ownership-gated: only the node the
// session is bound to may write it. Mutations that go red here: dropping the
// owner check; writing on a terminal frame; not clearing on 'active'; skipping
// the length cap; writing when the stored value is already equal.
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../src/schemas/harness-control-protocol.js';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import {
  handleSessionProvisioningDetail,
  PROVISIONING_DETAIL_MAX_LENGTH,
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

describe('provisioning-detail relay', () => {
  it('CRITICAL the OWNING node sets the token on a provisioning frame', async () => {
    const d = deps(session());
    expect(
      await handleSessionProvisioningDetail(
        d,
        frame('provisioning', 'vpn_egress_active'),
        'mac-owner',
      ),
    ).toBe('set');
    expect(d.setProvisioningDetail).toHaveBeenCalledWith('as_1', 'vpn_egress_active');
  });

  it('CRITICAL a NON-owning node is ignored (a rogue node must not describe another node’s session)', async () => {
    const d = deps(session());
    expect(
      await handleSessionProvisioningDetail(
        d,
        frame('provisioning', 'vpn_egress_active'),
        'mac-rogue',
      ),
    ).toBe('ignored');
    expect(d.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('an UNBOUND session (nodeId null) accepts the first reporter, like the terminal-close relay', async () => {
    const d = deps(session({ nodeId: null }));
    expect(
      await handleSessionProvisioningDetail(
        d,
        frame('provisioning', 'vpn_egress_active'),
        'mac-any',
      ),
    ).toBe('set');
  });

  it("CRITICAL an 'active' frame CLEARS the token — once the browser attached, nothing is provisioning", async () => {
    const d = deps(session({ provisioningDetail: 'vpn_egress_active' }));
    expect(await handleSessionProvisioningDetail(d, frame('active'), 'mac-owner')).toBe('cleared');
    expect(d.setProvisioningDetail).toHaveBeenCalledWith('as_1', null);
  });

  it('terminal frames and a provisioning frame WITHOUT a detail are no-ops', async () => {
    const d = deps(session());
    expect(await handleSessionProvisioningDetail(d, frame('ended'), 'mac-owner')).toBe('ignored');
    expect(await handleSessionProvisioningDetail(d, frame('errored', 'boom'), 'mac-owner')).toBe(
      'ignored',
    );
    expect(await handleSessionProvisioningDetail(d, frame('provisioning'), 'mac-owner')).toBe(
      'ignored',
    );
    expect(d.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('a CLOSED session and an unknown session are ignored', async () => {
    const closed = deps(session({ status: 'closed' }));
    expect(
      await handleSessionProvisioningDetail(
        closed,
        frame('provisioning', 'vpn_egress_active'),
        'mac-owner',
      ),
    ).toBe('ignored');
    const missing = deps(null);
    expect(
      await handleSessionProvisioningDetail(
        missing,
        frame('provisioning', 'vpn_egress_active'),
        'mac-owner',
      ),
    ).toBe('ignored');
    expect(closed.setProvisioningDetail).not.toHaveBeenCalled();
    expect(missing.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it(`the detail is capped at ${PROVISIONING_DETAIL_MAX_LENGTH} chars (a node cannot grow the row unboundedly)`, async () => {
    const d = deps(session());
    await handleSessionProvisioningDetail(
      d,
      frame('provisioning', 'x'.repeat(PROVISIONING_DETAIL_MAX_LENGTH + 50)),
      'mac-owner',
    );
    expect(d.setProvisioningDetail.mock.calls[0]?.[1]).toHaveLength(PROVISIONING_DETAIL_MAX_LENGTH);
  });

  it('an unchanged token is not re-written (no write churn on repeated frames)', async () => {
    const d = deps(session({ provisioningDetail: 'vpn_egress_active' }));
    expect(
      await handleSessionProvisioningDetail(
        d,
        frame('provisioning', 'vpn_egress_active'),
        'mac-owner',
      ),
    ).toBe('set');
    expect(d.setProvisioningDetail).not.toHaveBeenCalled();
  });

  it('a repo failure is swallowed (fire-and-forget off the receive loop) and reads as ignored', async () => {
    const d = deps(session());
    d.agentSessions.setProvisioningDetail.mockRejectedValueOnce(new Error('db down'));
    expect(
      await handleSessionProvisioningDetail(
        d,
        frame('provisioning', 'vpn_egress_active'),
        'mac-owner',
      ),
    ).toBe('ignored');
  });
});
