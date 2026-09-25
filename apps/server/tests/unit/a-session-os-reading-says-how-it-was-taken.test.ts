// A session's OS reading says how it was taken, so the desktop app can tell a
// trustworthy mismatch from a weak reading.
//
// The session's `capability_report.os_fingerprint` is the exit proxy's stored
// passive OS reading. It crossed as `{os, confidence, at}` only. But whether an OS
// that differs from the phone's is a real problem (red) or a reading that does not
// describe the path a website sees (neutral) is decided by HOW it was taken — the
// Proxies screen decides it from `observed_via` and the two path flags
// (`single_host_vantage` / `web_port_vantage`, customer names `direct_reading` /
// `website_like_reading`), which the proxy reply and list already publish. The
// Simulator, reading the session, had the verdict's inputs for one arm only (an
// Apple reading is always green), so it could never show a trustworthy mismatch.
//
// So the session's reading now carries those same fields, in the same shape the
// proxy reply publishes them, built the same way:
//
//   · parsed with the one published proxy-reading schema, so a value outside its
//     closed sets drops the reading (null — "not measured") rather than reaching a
//     client as something it cannot render;
//   · the two path flags normalised to FALSE when a stored reading predates them —
//     never promoted to true, because a mismatch claim rests on them;
//   · `reason` and `observed_ip` still stay on the server: the verdict needs how
//     the reading was taken, not the address it was taken from.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

const ACC = 'acc_os_how';
const PROXY = 'px_os_how';
const SESSION = 'agt_os_how';
const MEASURED_AT = new Date('2026-09-20T09:30:00.000Z');

function record(): AgentSessionRecord {
  return {
    id: SESSION,
    accountId: ACC,
    driftstackSessionId: null,
    proxyId: PROXY,
    stopOnExitIpChange: false,
    firstExitIp: null,
    status: 'active',
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    provisioningDetail: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    mode: 'ai',
    model: 'claude-opus-4-7',
    nodeId: null,
    profileId: null,
    idempotencyKey: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-09-20T00:00:00Z'),
    updatedAt: new Date('2026-09-20T00:00:00Z'),
  };
}

function proxyRow(osFingerprint: Record<string, unknown> | null): AccountProxyRow {
  return {
    id: PROXY,
    accountId: ACC,
    label: 'residential',
    scheme: 'socks5',
    host: '203.0.113.9',
    port: 1080,
    username: null,
    wrappedPassword: null,
    osFingerprint,
    osFingerprintAt: osFingerprint === null ? null : MEASURED_AT,
  } as unknown as AccountProxyRow;
}

function reportStore(): SessionCapabilityReportStore {
  const store = new SessionCapabilityReportStore();
  store.set({
    type: 'capabilityReport',
    sessionId: SESSION,
    timestamp: '2026-09-20T10:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: false,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: false,
    streamingState: 'live',
    egressState: 'live',
  } satisfies CapabilityReport);
  return store;
}

async function projected(row: AccountProxyRow | null): Promise<Record<string, unknown> | null> {
  const rec = record();
  const sessions = {
    get: (id: string) => Promise.resolve(id === rec.id ? rec : null),
  } as unknown as AgentSessionsRepo;
  const accountProxiesService = {
    findOwned: (id: string, accountId: string) =>
      Promise.resolve(id === PROXY && accountId === ACC ? row : null),
  } as unknown as AccountProxiesService;
  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'starter' },
      apiKey: { id: 'key_os_how', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    accountProxiesService,
    sessionCapabilityReportStore: reportStore(),
  });
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: `/v1/agent-sessions/${SESSION}` });
    expect(res.statusCode).toBe(200);
    return res.json<{ capability_report: { os_fingerprint: Record<string, unknown> | null } }>()
      .capability_report.os_fingerprint;
  } finally {
    await app.close();
  }
}

const TAKEN_THROUGH_THE_EXIT = {
  os: 'windows',
  confidence: 'high',
  reason: 'initial TTL 128',
  observed_ip: '203.0.113.9',
  observed_via: 'exit_ip',
  single_host_vantage: true,
  web_port_vantage: true,
};

describe("a session's OS reading says how it was taken", () => {
  it('CRITICAL carries observed_via and both path flags, under their original names and their customer names — the inputs a trustworthy mismatch needs', async () => {
    expect(await projected(proxyRow(TAKEN_THROUGH_THE_EXIT))).toEqual({
      os: 'windows',
      confidence: 'high',
      at: MEASURED_AT.toISOString(),
      observed_via: 'exit_ip',
      single_host_vantage: true,
      web_port_vantage: true,
      direct_reading: true,
      website_like_reading: true,
    });
  });

  it('CRITICAL a weak reading says so: taken at the proxy host, not the way a website connects, both flags false', async () => {
    expect(
      await projected(
        proxyRow({
          ...TAKEN_THROUGH_THE_EXIT,
          observed_via: 'proxy_host',
          single_host_vantage: false,
          web_port_vantage: false,
        }),
      ),
    ).toMatchObject({
      observed_via: 'proxy_host',
      single_host_vantage: false,
      web_port_vantage: false,
      direct_reading: false,
      website_like_reading: false,
    });
  });

  it('CRITICAL a reading stored before the path flags existed reads them as FALSE — never promoted to the true a mismatch claim rests on', async () => {
    const { single_host_vantage: _s, web_port_vantage: _w, ...legacy } = TAKEN_THROUGH_THE_EXIT;
    expect(await projected(proxyRow(legacy))).toMatchObject({
      single_host_vantage: false,
      web_port_vantage: false,
      direct_reading: false,
      website_like_reading: false,
    });
  });

  it('a reading whose method is outside the published set is not projected at all — "not measured", never a method a client cannot read', async () => {
    expect(
      await projected(proxyRow({ ...TAKEN_THROUGH_THE_EXIT, observed_via: 'somewhere_else' })),
    ).toBeNull();
  });

  it('the address and the free-text reason still stay on the server', async () => {
    const value = await projected(proxyRow(TAKEN_THROUGH_THE_EXIT));
    expect(value).not.toHaveProperty('observed_ip');
    expect(value).not.toHaveProperty('reason');
  });

  it('VACUITY CONTROL — a never-measured proxy still projects null', async () => {
    expect(await projected(proxyRow(null))).toBeNull();
  });
});
