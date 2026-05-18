// Arc 5 EGRESS eg.8 — end-to-end smoke test for the capability_report flow.
//
// Pins the full chain end-to-end:
//
//   harness emit (simulated)
//     → SessionsService.ingestEgressCapabilityReport (eg.7.e)
//        → repo.setEgressCapabilityReport (eg.1.b)
//        → emit session.egress_capability_changed webhook (eg.7)
//     → GET /v1/sessions/:id returns both derived + raw fields (eg.1.c)
//     → audit row + SDK + dashboard all consume the SAME source-of-truth
//
// What's NOT in scope (gated on cross-agent):
//   - eg.2 WebSocket control-plane listener (Agent 1 harness side)
//   - eg.2-side validation of the harness wire envelope
//
// The smoke simulates the harness emit by calling ingestEgressCapabilityReport
// directly. When eg.2 lands, the WebSocket handler will call the same
// service method — so this smoke pins the SERVER side of the chain
// independently of the cross-agent piece.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { SessionsService } from '../../src/services/sessions.js';

describe('Arc 5 EGRESS eg.8 — end-to-end capability_report smoke', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('full chain: ingest → repo persist → webhook emit → GET surfaces both fields', async () => {
    fx = await buildTestApp();
    const enqueuedEvents: Array<{
      accountId: string;
      eventType: string;
      data: Record<string, unknown>;
    }> = [];
    // Build a SessionsService instance that taps into the fixture's
    // repo + a vi.fn() webhook emitter so we can observe the emit
    // without depending on the durable delivery worker.
    const enqueueEvent = vi.fn(
      (accountId: string, eventType: string, data: Record<string, unknown>) => {
        enqueuedEvents.push({ accountId, eventType, data });
        return Promise.resolve(1);
      },
    );
    const svc = new SessionsService({
      repo: fx.sessionsRepo,
      driver: fx.driver,
      webhooks: { enqueueEvent },
    });

    // 1. Create a session via the public route (matches the real
    //    create flow that establishes the session id + account scope).
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const publicId = create.json<{ id: string }>().id;
    const internalId = publicId.replace(/^ses_/, '');

    // 2. Simulate the harness emitting an egress.capability_report
    //    event. The WebSocket handler (eg.2) will call this same
    //    method when it lands; today the smoke drives it directly.
    const derived = {
      udp_associate: false,
      quic_route: 'disabled' as const,
      dns_remote_resolve: false,
      warnings: ['udp_unsupported_by_proxy', 'dns_remote_resolve_unsupported_by_proxy'],
    };
    const raw = {
      udp_associate: false,
      quic_route: 'disabled',
      dns_remote_resolve: false,
      warnings: ['udp_unsupported_by_proxy', 'dns_remote_resolve_unsupported_by_proxy'],
      harness_diagnostic: { rtt_ms: 47, hop_count: 4, fork_pid: 12345 },
    };
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId: internalId,
      derived,
      raw,
    });

    // 3. Repo persist landed.
    expect(updated).not.toBeNull();
    expect(updated?.egressCapabilities).toEqual(derived);
    expect(updated?.egressCapabilityReport).toEqual(raw);

    // 4. Webhook event emitted with the exact wire shape (eg.7).
    expect(enqueueEvent).toHaveBeenCalledOnce();
    expect(enqueuedEvents).toHaveLength(1);
    const evt = enqueuedEvents[0]!;
    expect(evt.eventType).toBe('session.egress_capability_changed');
    expect(evt.data).toEqual({
      session_id: publicId,
      egress_capabilities: derived,
    });

    // 5. Public GET /v1/sessions/:id surfaces both fields (eg.1.c).
    //    Customer's SDK sees the same shape via z.infer<SessionSchema>.
    const getRes = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${publicId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{
      egress_capabilities: typeof derived;
      egress_capability_report: typeof raw;
    }>();
    expect(body.egress_capabilities).toEqual(derived);
    expect(body.egress_capability_report).toEqual(raw);
    // Forensics field survives the round-trip (the chief value-prop
    // of the eg.1 raw-vs-derived split).
    expect(body.egress_capability_report.harness_diagnostic).toMatchObject({
      rtt_ms: 47,
      hop_count: 4,
    });
  });

  it('idempotent: second ingest overwrites both columns AND fires another webhook (customers see every change, even if same payload)', async () => {
    fx = await buildTestApp();
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({
      repo: fx.sessionsRepo,
      driver: fx.driver,
      webhooks: { enqueueEvent },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const internalId = create.json<{ id: string }>().id.replace(/^ses_/, '');

    const derived1 = {
      udp_associate: true,
      quic_route: 'proxy' as const,
      dns_remote_resolve: false,
      warnings: [],
    };
    const derived2 = {
      udp_associate: false,
      quic_route: 'disabled' as const,
      dns_remote_resolve: true,
      warnings: ['udp_unsupported_by_proxy'],
    };
    await svc.ingestEgressCapabilityReport({
      sessionId: internalId,
      derived: derived1,
      raw: { generation: 1 },
    });
    const second = await svc.ingestEgressCapabilityReport({
      sessionId: internalId,
      derived: derived2,
      raw: { generation: 2 },
    });
    expect(second?.egressCapabilities).toEqual(derived2);
    expect(second?.egressCapabilityReport).toEqual({ generation: 2 });
    expect(enqueueEvent).toHaveBeenCalledTimes(2);
  });

  it('harness race: ingest on unknown session_id returns null + DOES NOT fire webhook', async () => {
    fx = await buildTestApp();
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({
      repo: fx.sessionsRepo,
      driver: fx.driver,
      webhooks: { enqueueEvent },
    });
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId: 'ses_does_not_exist_yet',
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: [],
      },
      raw: {},
    });
    expect(updated).toBeNull();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('webhook emit failure is best-effort: persist still lands, GET still returns the new state', async () => {
    fx = await buildTestApp();
    const enqueueEvent = vi.fn().mockRejectedValue(new Error('webhook delivery system down'));
    const svc = new SessionsService({
      repo: fx.sessionsRepo,
      driver: fx.driver,
      webhooks: { enqueueEvent },
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const publicId = create.json<{ id: string }>().id;
    const internalId = publicId.replace(/^ses_/, '');
    const derived = {
      udp_associate: true,
      quic_route: 'proxy' as const,
      dns_remote_resolve: false,
      warnings: [],
    };
    const updated = await svc.ingestEgressCapabilityReport({
      sessionId: internalId,
      derived,
      raw: {},
    });
    expect(updated).not.toBeNull();
    // GET still surfaces the new state despite the webhook failure.
    const getRes = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${publicId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json<{ egress_capabilities: typeof derived }>().egress_capabilities).toEqual(
      derived,
    );
  });
});
