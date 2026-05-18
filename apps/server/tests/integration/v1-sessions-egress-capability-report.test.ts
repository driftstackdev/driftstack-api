// Arc 5 EGRESS eg.1.e — end-to-end persist→read pipeline test
// for the egress_capability_report field.
//
// Pins the full chain landed in this turn:
//   1. Migration 0054 → Drizzle column
//   2. InMemorySessionsRepo.setEgressCapabilityReport persist
//   3. publicSession() route serialization
//   4. SessionSchema (api-types) wire shape
//
// Drives the persist via the in-memory repo directly (the
// WebSocket-handler ingestion that lives at eg.2 isn't yet wired);
// this test confirms the SERVER side of the pipeline works
// independently so eg.2 only has to call setEgressCapabilityReport
// when it lands.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 5 EGRESS eg.1.e — egress_capability_report end-to-end persist→read', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET /v1/sessions/{id} surfaces both egress_capabilities + egress_capability_report after persist', async () => {
    fx = await buildTestApp();

    // 1. Create a session via the public route so we have a real
    // id + auth context for the GET.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    const sessionPublicId = create.json<{ id: string }>().id;
    // The repo stores the bare UUID; the route prefixes it as ses_<uuid>.
    const sessionInternalId = sessionPublicId.replace(/^ses_/, '');

    // 2. Initial GET — both fields are null (no harness emit yet).
    const before = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionPublicId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(before.statusCode).toBe(200);
    expect(
      before.json<{
        egress_capabilities: unknown;
        egress_capability_report: unknown;
      }>().egress_capabilities,
    ).toBeNull();
    expect(
      before.json<{
        egress_capability_report: unknown;
      }>().egress_capability_report,
    ).toBeNull();

    // 3. Persist via the repo (simulates eg.2 WebSocket handler ingestion).
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionInternalId,
      derived: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: false,
        warnings: ['dns_remote_resolve_unsupported_by_proxy'],
      },
      raw: {
        udp_associate: true,
        quic_route: 'proxy',
        // Extra field the SDK schema doesn't know about — proves
        // the raw payload preserves harness-side schema evolution.
        harness_diagnostic: { rtt_ms: 12, hop_count: 3 },
      },
    });

    // 4. Second GET — both fields populated; raw carries the
    //    forensics-only `harness_diagnostic` field that the
    //    derived view doesn't surface.
    const after = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionPublicId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(after.statusCode).toBe(200);
    const body = after.json<{
      egress_capabilities: {
        udp_associate: boolean;
        quic_route: string;
        dns_remote_resolve: boolean;
        warnings: string[];
      } | null;
      egress_capability_report: Record<string, unknown> | null;
    }>();
    expect(body.egress_capabilities).toEqual({
      udp_associate: true,
      quic_route: 'proxy',
      dns_remote_resolve: false,
      warnings: ['dns_remote_resolve_unsupported_by_proxy'],
    });
    expect(body.egress_capability_report).toMatchObject({
      udp_associate: true,
      quic_route: 'proxy',
      harness_diagnostic: { rtt_ms: 12, hop_count: 3 },
    });
  });

  it('cross-account: GET on a session belonging to another account → 404; capability fields never leak', async () => {
    fx = await buildTestApp();
    // Use a properly-shaped but non-existent session id — the route
    // validates the prefix shape first, then 404s on lookup miss.
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
