// Arc 5 EGRESS eg.1.b — setEgressCapabilityReport repo method tests.
//
// Pins the contract for both Drizzle + InMemory implementations:
//   - Persists derived view + raw payload atomically
//   - Returns the updated record
//   - Returns null when the session doesn't exist (harness race)
//   - Subsequent calls overwrite (the harness may re-emit;
//     we keep the latest)
//
// Drizzle parity is tested separately at the integration level
// (apps/server/tests/integration/ — TBD when the WebSocket
// handler eg.2 ships); this slice covers the InMemory variant +
// the interface contract.

import { describe, expect, it } from 'vitest';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';

async function seedSession(repo: InMemorySessionsRepo): Promise<string> {
  const r = await repo.insertSession({
    accountId: 'acc_x',
    apiKeyId: 'key_x',
    driverSessionId: 'drv_x',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    purpose: 'production_customer',
    label: null,
    metadata: null,
  });
  return r.id;
}

describe('Arc 5 EGRESS eg.1.b setEgressCapabilityReport', () => {
  it('persists derived view + raw payload atomically; returns the updated record', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const updated = await repo.setEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: [],
      },
      raw: { udp_associate: true, quic_route: 'proxy', extra_harness_field: 42 },
    });
    expect(updated).not.toBeNull();
    expect(updated?.egressCapabilities).toEqual({
      udp_associate: true,
      quic_route: 'proxy',
      dns_remote_resolve: false,
      warnings: [],
    });
    expect(updated?.egressCapabilityReport).toEqual({
      udp_associate: true,
      quic_route: 'proxy',
      extra_harness_field: 42,
    });
  });

  it('null return when sessionId is unknown (harness emitted faster than session-create persisted)', async () => {
    const repo = new InMemorySessionsRepo();
    const updated = await repo.setEgressCapabilityReport({
      sessionId: 'ses_does_not_exist',
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: [],
      },
      raw: {},
    });
    expect(updated).toBeNull();
  });

  it('idempotent: second call overwrites both columns with the latest report', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    await repo.setEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: [],
      },
      raw: { generation: 1 },
    });
    const second = await repo.setEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: true,
        warnings: ['udp_unsupported_by_proxy'],
      },
      raw: { generation: 2 },
    });
    expect(second?.egressCapabilities?.udp_associate).toBe(false);
    expect(second?.egressCapabilities?.quic_route).toBe('disabled');
    expect(second?.egressCapabilities?.warnings).toEqual(['udp_unsupported_by_proxy']);
    expect(second?.egressCapabilityReport).toEqual({ generation: 2 });
  });

  it('updatedAt advances when the report is set', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const seed = await repo.findSession(sessionId, 'acc_x');
    expect(seed).not.toBeNull();
    const before = seed!.updatedAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await repo.setEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: [],
      },
      raw: {},
    });
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(before);
  });
});
