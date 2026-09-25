import { AgentSessionSchema } from '@driftstack/api-types';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  SessionCapabilityReportStore,
  customerEgressState,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';

function report(sessionId: string, overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId,
    timestamp: '2026-07-13T06:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: true,
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

describe('SessionCapabilityReportStore', () => {
  it('projects the customer-safe live state and replaces it for the same session', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1'));
    expect(store.get('agt_1')).toEqual({
      timestamp: '2026-07-13T06:00:00.000Z',
      manual_input_available: true,
      streaming_state: 'live',
      egress_state: 'live',
      proxy_kind: 'socks5',
      proxy_udp_supported: true,
      transport_mode_requested: 'h2-and-h3',
      transport_mode_active: 'h2-and-h3',
      safeguards_passed: true,
      // T-6 — ⛔ null, not false: the node reports these only once it has
      // OBSERVED the fact, so absent means NOT OBSERVED. Reading either as a
      // negative would assert "this session carried no HTTP/3" from no evidence,
      // the same defect shape as the streaming_health zeroes below.
      h3_connection_observed: null,
      // (o) O2 — ⛔ null, not 0, for exactly the reason above: a 0 is the
      // measurement "this session has carried no HTTP/3 connection", and this
      // frame measured nothing.
      h3_connection_count: null,
      interpose_image_loaded: null,
      // T-26 — ⛔ null, not empty: absent means NOT OBSERVED (this frame carries
      // no exit identity), never "no exit". Same absent-until-measured contract.
      exit_ip: null,
      exit_country: null,
      exit_timezone: null,
      webrtc_candidate_ips: null,
      observed_at: null,
      // ⛔ null, not an object of zeroes: absent means the node never reported,
      // which must never render as a healthy stream (V-2188).
      streaming_health: null,
      // 2026-09-19 — declared + measured build identity for THIS session, and
      // the device that reported it. ⛔ null on every one, for the same
      // absent-until-measured reason as the fields above: this fixture carries no
      // `webkitForkBuild` and no `webkitFrameworkSha256`, and the caller passed no
      // reporting node, so the session is UNATTRIBUTED rather than attributed to a
      // placeholder. The drift report compares none of these when they are null.
      webkit_fork_build: null,
      webkit_framework_sha256: null,
      reporting_node_id: null,
    });

    store.set(
      report('agt_1', {
        timestamp: '2026-07-13T06:01:00.000Z',
        manualInputAvailable: false,
        streamingState: 'blank',
        egressState: 'dead_proxy',
        safeguardChecks: [{ layer: 'dns', passed: false, timestamp: 't' }],
      }),
    );
    expect(store.get('agt_1')).toMatchObject({
      timestamp: '2026-07-13T06:01:00.000Z',
      manual_input_available: false,
      streaming_state: 'blank',
      egress_state: 'dead_proxy',
      safeguards_passed: false,
    });
    expect(store.size).toBe(1);
  });

  it('uses null for optional legacy signals, evicts the oldest entry at its cap, and deletes', () => {
    const store = new SessionCapabilityReportStore(2);
    store.set(
      report('agt_1', {
        manualInputAvailable: undefined,
        streamingState: undefined,
        egressState: undefined,
      }),
    );
    expect(store.get('agt_1')).toMatchObject({
      manual_input_available: null,
      streaming_state: null,
      egress_state: null,
    });
    store.set(report('agt_2'));
    store.set(report('agt_3'));
    expect(store.get('agt_1')).toBeNull();
    expect(store.size).toBe(2);
    store.delete('agt_2');
    expect(store.get('agt_2')).toBeNull();
  });

  it('T-26 surfaces the live exit identity + WebRTC IPs and includes them in the customer-safe subset; absence stays null', () => {
    const store = new SessionCapabilityReportStore();
    store.set(
      report('agt_1', {
        exitIp: '203.0.113.7',
        exitCountry: 'US',
        exitTimezone: 'America/New_York',
        webrtcCandidateIps: ['203.0.113.7'],
        observedAt: '2026-09-07T00:00:00.000Z',
      }),
    );
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();
    expect(stored?.exit_ip).toBe('203.0.113.7');
    expect(stored?.exit_country).toBe('US');
    expect(stored?.exit_timezone).toBe('America/New_York');
    expect(stored?.webrtc_candidate_ips).toEqual(['203.0.113.7']);
    expect(stored?.observed_at).toBe('2026-09-07T00:00:00.000Z');
    // The GUI-facing subset carries them — they are the customer's OWN egress.
    const safe = customerSafeCapabilityReport(stored!);
    expect(safe.exit_ip).toBe('203.0.113.7');
    expect(safe.exit_country).toBe('US');
    expect(safe.webrtc_candidate_ips).toEqual(['203.0.113.7']);
    expect(safe.observed_at).toBe('2026-09-07T00:00:00.000Z');
    // ⛔ Vacuity: a frame WITHOUT the exit fields stores null, never a
    // fabricated value — the same absent-until-measured contract as h3.
    store.set(report('agt_2'));
    expect(store.get('agt_2')?.exit_ip).toBeNull();
    expect(store.get('agt_2')?.webrtc_candidate_ips).toBeNull();
    expect(store.get('agt_2')?.observed_at).toBeNull();
  });

  it('N-2 the customer-safe subset carries the {os, confidence, at} OS-fingerprint arg, and is null without it — never a placeholder OS', () => {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1'));
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();

    // With the arg the control plane read from the proxy row, ONLY the {os,
    // confidence} subset crosses — the internal reason/observed_ip/observed_via
    // (which the arg deliberately does not carry) never appear.
    //
    // ⛔ (V-219) `at` rides with it, and it is the one field here that has to.
    // Every other value in this report is a live harness frame; this one was
    // measured once, when the customer last pressed Test on the proxy, and
    // nothing re-reads it while the session runs. Without the stamp the cockpit
    // can only render a stored reading of any age in bare present tense.
    const safe = customerSafeCapabilityReport(stored!, {
      os: 'windows',
      confidence: 'medium',
      at: '2026-06-01T09:30:00.000Z',
    });
    expect(safe.os_fingerprint).toEqual({
      os: 'windows',
      confidence: 'medium',
      at: '2026-06-01T09:30:00.000Z',
    });

    // ⛔ Absent-is-not-a-negative: with NO arg (never measured, or no owned proxy)
    // the field is null — NOT OBSERVED, rendered "measuring…" — never coerced to a
    // placeholder OS. The key is always present so the wire shape is stable.
    const safeNone = customerSafeCapabilityReport(stored!);
    expect(safeNone.os_fingerprint).toBeNull();
    // A null arg is treated the same as absent.
    expect(customerSafeCapabilityReport(stored!, null).os_fingerprint).toBeNull();
  });
});

// A session created with no proxy of its own runs on the connection Driftstack
// provides (proxyId NULL). When that connection stops carrying traffic mid-session
// the device reports `egressState: 'dead_proxy'` — it cannot tell our connection
// from a customer's proxy — and the desktop app turned that into a red "Proxy
// connection failed" badge for a customer who chose no proxy. Only the server knows
// which it was, so the customer projection publishes it under its own value.
describe("a dead connection on a session with no proxy of its own is published as ours, not as the customer's proxy", () => {
  function storedWith(egressState: CapabilityReport['egressState']) {
    const store = new SessionCapabilityReportStore();
    store.set(report('agt_1', { egressState }));
    const stored = store.get('agt_1');
    expect(stored).not.toBeNull();
    return stored!;
  }

  it('CRITICAL proxyId null + dead_proxy projects default_connection_down', () => {
    expect(
      customerSafeCapabilityReport(storedWith('dead_proxy'), null, { proxyId: null }).egress_state,
    ).toBe('default_connection_down');
  });

  it("CRITICAL proxyId set + dead_proxy stays dead_proxy: that is the customer's own proxy", () => {
    expect(
      customerSafeCapabilityReport(storedWith('dead_proxy'), null, { proxyId: 'prx_own' })
        .egress_state,
    ).toBe('dead_proxy');
  });

  it('CRITICAL an undefined proxyId is NOT read as null — without the session, the device word stands', () => {
    // The fail-safe direction. A caller that does not say which session this is
    // (no third argument), or hands over a record whose proxyId is undefined
    // (a fake or a partial type that dropped the field), must publish what the
    // device said: calling a customer's dead proxy "ours" would send them away
    // from the one thing they can fix. Only an explicit null is "no proxy of its
    // own". Kills `(session?.proxyId ?? null) === null`, which read all three as null.
    expect(customerSafeCapabilityReport(storedWith('dead_proxy'), null).egress_state).toBe(
      'dead_proxy',
    );
    expect(customerSafeCapabilityReport(storedWith('dead_proxy')).egress_state).toBe('dead_proxy');
    expect(customerEgressState('dead_proxy', undefined)).toBe('dead_proxy');
    expect(customerEgressState('dead_proxy', {} as unknown as { proxyId: string | null })).toBe(
      'dead_proxy',
    );
    // Control: the explicit null still projects, so the arm above is not vacuous.
    expect(customerEgressState('dead_proxy', { proxyId: null })).toBe('default_connection_down');
  });

  it('proxyId null leaves live and an unreported state as they are', () => {
    expect(
      customerSafeCapabilityReport(storedWith('live'), null, { proxyId: null }).egress_state,
    ).toBe('live');
    expect(
      customerSafeCapabilityReport(storedWith(undefined), null, { proxyId: null }).egress_state,
    ).toBeNull();
  });

  it('the store keeps what the device said; only the customer projection changes it', () => {
    // The operator surfaces (fleet build drift, diagnostics) read the stored record,
    // and for them the device's own word is the fact.
    expect(storedWith('dead_proxy').egress_state).toBe('dead_proxy');
  });

  const ACC = 'acc_default_connection';

  async function readOverTheWire(
    proxyId: string | null,
    egressState: CapabilityReport['egressState'],
  ): Promise<Record<string, unknown>> {
    const repo = new InMemoryAgentSessionsRepo();
    const session = await repo.create({ accountId: ACC, tokenBudgetTotal: 100 });
    await repo.setNodeId(session.id, 'node-1', proxyId);
    const store = new SessionCapabilityReportStore();
    store.set(report(session.id, { egressState }));

    const app = Fastify({ logger: false });
    app.decorateRequest('account', null);
    app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
      (req as { account: unknown }).account = {
        account: { id: ACC, tier: 'starter' },
        apiKey: { id: 'key_default_connection', scopes: ['read', 'write'] },
      };
      done();
    });
    app.decorate('requireAuth', () => Promise.resolve());
    app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
    app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
    registerAgentSessionsRoutes(app, {
      runtime: {} as unknown as AgentRuntime,
      sessions: repo,
      sessionCapabilityReportStore: store,
    });
    await app.ready();
    try {
      const byId = await app.inject({ method: 'GET', url: `/v1/agent-sessions/${session.id}` });
      expect(byId.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/v1/agent-sessions' });
      expect(list.statusCode).toBe(200);
      const body = byId.json<Record<string, unknown>>();
      // The list projects through the same function, so it must say the same thing.
      const listed = list.json<{ data: Array<Record<string, unknown>> }>().data;
      expect(listed).toHaveLength(1);
      expect(listed[0]?.capability_report).toEqual(body.capability_report);
      // And the published contract admits what the server sends.
      const parsed = AgentSessionSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      return body.capability_report as Record<string, unknown>;
    } finally {
      await app.close();
    }
  }

  it('CRITICAL GET /v1/agent-sessions/:id and the list publish default_connection_down for a session with no proxy of its own, and the published schema accepts it', async () => {
    expect((await readOverTheWire(null, 'dead_proxy')).egress_state).toBe(
      'default_connection_down',
    );
  });

  it("CRITICAL the same read for a session on the customer's own proxy still says dead_proxy", async () => {
    expect((await readOverTheWire('prx_own', 'dead_proxy')).egress_state).toBe('dead_proxy');
  });
});
