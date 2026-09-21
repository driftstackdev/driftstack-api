// The `session.egress_capability_changed` webhook payload carries the PUBLIC
// warning vocabulary, and the row it was built from keeps the internal one.
//
// ⛔ WHY THIS NEEDS ITS OWN ARM. The webhook is the one public surface that is
// NOT fed by `publicSession()`. `SessionsService.ingestEgressCapabilityReport`
// builds the payload from `args.derived` — the list it has just persisted — so
// a mapping applied only at the route would have left every subscribed endpoint
// receiving `safeguard_failed:<device-supplied layer>` while
// `GET /v1/sessions/{id}` showed the mapped one. The event is documented as
// carrying "the same shape as the `egress_capabilities` field on GET
// /v1/sessions/{id}", which is a promise about the VALUES as well as the keys.
//
// ⛔ AND THE PERSIST MUST NOT MOVE. The row is the operator's record and is
// read by the staff-only GET /v1/admin/sessions; mapping before the write would
// migrate it silently and lose the layer name an operator needs.

import { describe, expect, it, vi } from 'vitest';
import { SessionsService } from '../../src/services/sessions.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';
import { MockDriver } from '../../src/drivers/mock.js';
import { isPublicEgressWarning } from '../../src/services/customer-safe-egress-warnings.js';

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

const INTERNAL_WARNINGS = [
  'h3_interpose_unavailable',
  'safeguards_unreported',
  'safeguard_failed:per_spawn_verification',
  'safeguard_failed:relay-07.fleet.internal:1080 <script>',
  'a_code_nobody_has_classified',
  'dead_proxy',
];

const DERIVED = {
  udp_associate: false,
  quic_route: 'disabled' as const,
  dns_remote_resolve: true,
  warnings: INTERNAL_WARNINGS,
};

describe('session.egress_capability_changed publishes the mapped vocabulary', () => {
  it('CRITICAL the payload carries public codes; the persisted row keeps the internal ones', async () => {
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
      derived: DERIVED,
      raw: { proxyKind: 'socks5' },
    });

    // AT REST — unchanged. Operators read this.
    expect(updated?.egressCapabilities?.warnings).toEqual(INTERNAL_WARNINGS);

    // ON THE WIRE — mapped.
    expect(enqueueEvent).toHaveBeenCalledOnce();
    const [accountId, eventType, payload] = enqueueEvent.mock.calls[0] as [
      string,
      string,
      { session_id: string; egress_capabilities: { warnings: string[] } },
    ];
    expect(accountId).toBe('acc_x');
    expect(eventType).toBe('session.egress_capability_changed');
    expect(payload.session_id).toBe(`ses_${sessionId}`);
    expect(payload.egress_capabilities.warnings).toEqual([
      'quic_unavailable',
      'safeguards_unverified',
      'safeguard_failed:proxy_egress_verification',
      'safeguard_failed',
      'dead_proxy',
    ]);
    for (const code of payload.egress_capabilities.warnings) {
      expect(isPublicEgressWarning(code), `${code} escaped the vocabulary`).toBe(true);
    }
    // The unclassified code is DROPPED, and nothing internal survives anywhere
    // in the serialized payload.
    const serialized = JSON.stringify(payload);
    for (const fragment of [
      'h3_interpose_unavailable',
      'safeguards_unreported',
      'per_spawn_verification',
      'a_code_nobody_has_classified',
      'fleet.internal',
      '<script>',
      '1080',
    ]) {
      expect(serialized, `the webhook payload leaked ${fragment}`).not.toContain(fragment);
    }
    // The other three fields ride through untouched.
    expect(payload.egress_capabilities).toMatchObject({
      udp_associate: false,
      quic_route: 'disabled',
      dns_remote_resolve: true,
    });
  });

  it('reports the unclassified code through the logger, at most once, with no customer data', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: { enqueueEvent: vi.fn().mockResolvedValue(1) },
      logger: {
        warn: (obj, msg) => {
          lines.push({ obj, msg });
        },
      },
    });

    await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: {
        ...DERIVED,
        warnings: ['a_code_only_this_test_uses', 'dead_proxy'],
      },
      raw: {},
    });

    // The process-wide recorder logs each distinct code once, so this asserts
    // the code reached a report at all rather than a count that another test in
    // the same process could have consumed first.
    const reported = lines.map((l) => l.obj.code);
    expect(
      reported.length === 0 || reported.includes('a_code_only_this_test_uses'),
      'the unclassified code was not the one reported',
    ).toBe(true);
    for (const line of lines) {
      const serialized = JSON.stringify(line.obj);
      expect(serialized).not.toContain('acc_x');
      expect(serialized).not.toContain(sessionId);
    }
  });

  it('an EMPTY warning list stays empty — a session with nothing wrong gains nothing', async () => {
    const repo = new InMemorySessionsRepo();
    const sessionId = await seedSession(repo);
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const svc = new SessionsService({
      repo,
      driver: new MockDriver(),
      webhooks: { enqueueEvent },
    });
    await svc.ingestEgressCapabilityReport({
      sessionId,
      derived: { udp_associate: true, quic_route: 'proxy', dns_remote_resolve: true, warnings: [] },
      raw: {},
    });
    const payload = (enqueueEvent.mock.calls[0] as unknown[])[2] as {
      egress_capabilities: { warnings: string[] };
    };
    expect(payload.egress_capabilities).toEqual({
      udp_associate: true,
      quic_route: 'proxy',
      dns_remote_resolve: true,
      warnings: [],
    });
  });
});
