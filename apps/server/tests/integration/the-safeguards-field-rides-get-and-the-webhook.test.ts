// `egress_capabilities.safeguards` on the two surfaces this file's sibling
// unit test does not reach: a real HTTP `GET /v1/sessions/{id}`, and the
// `session.egress_capability_changed` webhook payload built by
// `SessionsService.ingestEgressCapabilityReport`.
//
// Seeds a report with the device's expected safeguard-layer set DECLARED
// (and fully covered + passing) and, separately, with it left UNDECLARED —
// the "with/without the expected set" cases — driven through the REAL
// derivation (`deriveSafeguardsTriState`) rather than hand-typed literals, so
// a test asserting "passed" or "unverified" is asserting what the relay would
// really produce for that frame, not what this file assumes it would.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from './_helpers/in-memory-sessions-repo.js';
import { MockDriver } from '../../src/drivers/mock.js';
import { deriveSafeguardsTriState } from '../../src/services/session-capability-report-relay.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

function frame(overrides: Partial<CapabilityReport>): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_1',
    timestamp: '2026-09-21T00:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-only',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: false,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    ...overrides,
  };
}

// WITH the expected set declared, and fully covered by passing checks.
const WITH_EXPECTED_SET = frame({
  safeguardLayersExpected: ['dns', 'tls'],
  safeguardChecks: [
    { layer: 'dns', passed: true, timestamp: 't' },
    { layer: 'tls', passed: true, timestamp: 't' },
  ],
});
// WITHOUT the expected set declared — every reported check still passes.
const WITHOUT_EXPECTED_SET = frame({
  safeguardLayersExpected: undefined,
  safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
});

describe('egress_capabilities.safeguards on GET /v1/sessions/{id}', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL reflects "passed" when the device declared its expected set and it was fully covered', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    const derivedSafeguards = deriveSafeguardsTriState(WITH_EXPECTED_SET);
    expect(derivedSafeguards, 'positive control on the fixture itself').toBe('passed');

    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        safeguards: derivedSafeguards,
        warnings: [],
      },
      raw: {},
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ egress_capabilities: { safeguards?: string } }>().egress_capabilities,
    ).toMatchObject({ safeguards: 'passed' });
  });

  it('CRITICAL reflects "unverified" — the stricter population — when the device declared NO expected set, even though every reported check passed', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    const derivedSafeguards = deriveSafeguardsTriState(WITHOUT_EXPECTED_SET);
    expect(derivedSafeguards, 'positive control on the fixture itself').toBe('unverified');

    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        safeguards: derivedSafeguards,
        warnings: [],
      },
      raw: {},
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ egress_capabilities: { safeguards?: string } }>().egress_capabilities,
    ).toMatchObject({ safeguards: 'unverified' });
  });

  it('CRITICAL an OLD row seeded with no `safeguards` key at all surfaces no key on GET — never a defaulted value', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;

    // The exact shape a row written before this field existed carries: no
    // `safeguards` key in the derived object at all.
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        warnings: [],
      },
      raw: {},
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const capabilities = res.json<{ egress_capabilities: Record<string, unknown> }>()
      .egress_capabilities;
    expect(Object.prototype.hasOwnProperty.call(capabilities, 'safeguards')).toBe(false);
    expect(res.body).not.toContain('"safeguards"');
  });
});

describe('egress_capabilities.safeguards on the session.egress_capability_changed webhook', () => {
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

  it('CRITICAL the payload carries "passed" for a report with a declared, fully-covered expected set', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({ repo, driver: new MockDriver(), webhooks: { enqueueEvent } });

    const derivedSafeguards = deriveSafeguardsTriState(WITH_EXPECTED_SET);
    await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        safeguards: derivedSafeguards,
        warnings: [],
      },
      raw: {},
    });

    expect(enqueueEvent).toHaveBeenCalledOnce();
    const payload = (enqueueEvent.mock.calls[0] as unknown[])[2] as {
      egress_capabilities: { safeguards?: string };
    };
    expect(payload.egress_capabilities.safeguards).toBe('passed');
  });

  it('CRITICAL the payload carries "unverified" for a report with NO declared expected set — the stricter population, on the wire', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({ repo, driver: new MockDriver(), webhooks: { enqueueEvent } });

    const derivedSafeguards = deriveSafeguardsTriState(WITHOUT_EXPECTED_SET);
    await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        safeguards: derivedSafeguards,
        warnings: [],
      },
      raw: {},
    });

    const payload = (enqueueEvent.mock.calls[0] as unknown[])[2] as {
      egress_capabilities: { safeguards?: string };
    };
    expect(payload.egress_capabilities.safeguards).toBe('unverified');
  });

  it('a report with no `safeguards` key at all (pre-existing call site) sends a payload with no `safeguards` key — never defaulted', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({ repo, driver: new MockDriver(), webhooks: { enqueueEvent } });

    await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: { udp_associate: true, quic_route: 'proxy', dns_remote_resolve: true, warnings: [] },
      raw: {},
    });

    const payload = (enqueueEvent.mock.calls[0] as unknown[])[2] as {
      egress_capabilities: Record<string, unknown>;
    };
    expect(Object.prototype.hasOwnProperty.call(payload.egress_capabilities, 'safeguards')).toBe(
      false,
    );
  });
});
