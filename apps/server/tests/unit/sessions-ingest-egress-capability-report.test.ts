// Arc 5 EGRESS eg.7.e — SessionsService.ingestEgressCapabilityReport tests.
//
// Pins the service-level orchestration: persist via repo +
// best-effort webhook emit. The eg.2 WebSocket handler will call
// this method; today it's exercised directly.

import { describe, expect, it, vi } from 'vitest';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import { MockDriver } from '../../src/drivers/mock.js';

async function seedSession(repo: InMemorySessionsRepo): Promise<string> {
  const r = await repo.insertSession({
    accountId: 'acc_x',
    apiKeyId: 'key_x',
    driverSessionId: 'drv_x',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    purpose: 'general',
    label: null,
    metadata: null,
  });
  return r.id;
}

const SAMPLE_DERIVED = {
  udp_associate: true,
  quic_route: 'proxy' as const,
  dns_remote_resolve: false,
  warnings: [],
};

describe('Arc 5 EGRESS eg.7.e SessionsService.ingestEgressCapabilityReport', () => {
  it('persists via repo + fires session.egress_capability_changed webhook', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: { enqueueEvent },
    });
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: SAMPLE_DERIVED,
      raw: { foo: 'bar' },
    });
    expect(updated).not.toBeNull();
    expect(updated?.egressCapabilities).toEqual(SAMPLE_DERIVED);
    expect(updated?.egressCapabilityReport).toEqual({ foo: 'bar' });
    expect(enqueueEvent).toHaveBeenCalledOnce();
    expect(enqueueEvent).toHaveBeenCalledWith('acc_x', 'session.egress_capability_changed', {
      session_id: `ses_${sessionId}`,
      egress_capabilities: SAMPLE_DERIVED,
    });
  });

  it('returns null when sessionId is unknown; webhook NOT fired', async () => {
    const repo = new InMemorySessionsRepo();
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: { enqueueEvent },
    });
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId: 'ses_does_not_exist',
      derived: SAMPLE_DERIVED,
      raw: {},
    });
    expect(updated).toBeNull();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('persists even when webhook emit throws (best-effort emit)', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockRejectedValue(new Error('webhook system down'));
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: { enqueueEvent },
    });
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: SAMPLE_DERIVED,
      raw: {},
    });
    expect(updated).not.toBeNull();
    expect(updated?.egressCapabilities).toEqual(SAMPLE_DERIVED);
    // The persist already landed; subsequent fetch confirms the
    // webhook failure didn't roll back state.
    const fetched = await repo.findSession(sessionId, 'acc_x');
    expect(fetched?.egressCapabilities).toEqual(SAMPLE_DERIVED);
  });

  it('persists without firing when webhooks dep is null (no-emit deployment)', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: null,
    });
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: SAMPLE_DERIVED,
      raw: {},
    });
    expect(updated).not.toBeNull();
    expect(updated?.egressCapabilities).toEqual(SAMPLE_DERIVED);
  });
});
