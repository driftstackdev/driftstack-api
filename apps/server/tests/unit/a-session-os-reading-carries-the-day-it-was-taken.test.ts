// (V-219) The session's exit-OS fingerprint is a STORED reading, and the
// projection that crosses it to the customer never said when it was taken.
//
// ⛔ WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE. `capability_report` is the
// answer to "what is this session, right now". Everything else in it is a live
// harness frame — the streaming state, the egress state, the exit identity, the
// HTTP/3 count — measured moments ago and re-measured on every frame. This one
// field is not: the control plane observes a proxy's TCP stack exactly once,
// when the customer presses Test on the Proxies screen, and persists it on the
// proxy row. Nothing re-reads it while a session runs. So a reading of ANY age
// rode into a live report beside fields that were seconds old, and the cockpit
// rendered it as `OS: windows · high` — present tense, no age, indistinguishable
// from the live facts around it.
//
// The stamp existed the whole time. Migration 0119 added `os_fingerprint_at`
// beside `os_fingerprint` and the /:id/test route writes both in one update,
// only when a SYN was actually observed — so the column is an honest measurement
// time, not a touch time. The projection read one column and ignored the other.
// This is the same defect the desktop client's probe cache had on the same day
// (`at` written by every reading, read by nobody), on a second surface.
//
// The rule pinned below: a reading we cannot DATE is not projected at all.
// Fail-closed, matching the observer lookup's refusal of a record with no
// `seen_at` and the client cache's refusal of an entry with no `at` — and it
// costs nothing, because the only writer sets both columns together.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type { AccountProxiesService } from '../../src/services/account-proxies.js';
import type { AccountProxyRow } from '../../src/db/account-proxies-repo.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

const ACC = 'acc_os_age';
const PROXY = 'px_os_age';
const MEASURED_AT = new Date('2026-06-01T09:30:00.000Z');

const FINGERPRINT = {
  os: 'windows',
  confidence: 'high',
  reason: 'initial TTL 128',
  observed_ip: '203.0.113.9',
  observed_via: 'exit_ip',
} as const;

function makeRecord(): AgentSessionRecord {
  return {
    id: 'agt_os',
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
    createdAt: new Date('2026-06-19T00:00:00Z'),
    updatedAt: new Date('2026-06-19T00:00:00Z'),
  };
}

/** A proxy row exactly as the repo hands it back — only the two N-2 columns
 *  vary between arms; everything else is constant so the arms differ in one
 *  thing. `null`/`null` is the never-measured row the migration describes. */
function proxyRow(over: Partial<AccountProxyRow>): AccountProxyRow {
  return {
    id: PROXY,
    accountId: ACC,
    label: 'residential',
    scheme: 'socks5',
    host: 'proxy.example.com',
    port: 1080,
    username: null,
    wrappedPassword: null,
    osFingerprint: null,
    osFingerprintAt: null,
    ...over,
  } as unknown as AccountProxyRow;
}

function reportStore(): SessionCapabilityReportStore {
  const store = new SessionCapabilityReportStore();
  store.set({
    type: 'capabilityReport',
    sessionId: 'agt_os',
    timestamp: '2026-09-15T04:00:00.000Z',
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

async function buildApp(row: AccountProxyRow | null) {
  const rec = makeRecord();
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
      apiKey: { id: 'key_os_age', scopes: ['read', 'write'] },
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
  return app;
}

const projected = async (row: AccountProxyRow | null): Promise<unknown> => {
  const app = await buildApp(row);
  try {
    const res = await app.inject({ method: 'GET', url: '/v1/agent-sessions/agt_os' });
    expect(res.statusCode).toBe(200);
    return res.json<{ capability_report: { os_fingerprint: unknown } }>().capability_report
      .os_fingerprint;
  } finally {
    await app.close();
  }
};

describe("a session's projected OS reading says when it was measured", () => {
  it('CRITICAL carries `at` — the ONE field in capability_report that is not a live measurement must be the one field that can be dated, or the cockpit can only render it in bare present tense', async () => {
    expect(
      await projected(
        proxyRow({ osFingerprint: { ...FINGERPRINT }, osFingerprintAt: MEASURED_AT }),
      ),
    ).toEqual({
      os: 'windows',
      confidence: 'high',
      at: MEASURED_AT.toISOString(),
    });
  });

  it('CRITICAL an UNDATED reading is projected as NOTHING. "We measured windows" and "we measured windows at a time we cannot name" are different claims, and only the first can be rendered honestly — so the second fails closed, exactly as the observer lookup refuses a record with no seen_at.', async () => {
    expect(
      await projected(proxyRow({ osFingerprint: { ...FINGERPRINT }, osFingerprintAt: null })),
    ).toBeNull();
  });

  it('VACUITY CONTROL — a never-measured row still projects null, so the arms above are about the STAMP and not about the fingerprint being absent', async () => {
    expect(await projected(proxyRow({}))).toBeNull();
  });

  it('VACUITY CONTROL — a session whose proxy the account does not own reads null, never another account’s reading', async () => {
    expect(await projected(null)).toBeNull();
  });

  it('CRITICAL the internal diagnostics stay server-side — `reason`, `observed_ip` and `observed_via` name an address and a method, and adding a field to this projection is exactly how one would cross by accident', async () => {
    const value = await projected(
      proxyRow({ osFingerprint: { ...FINGERPRINT }, osFingerprintAt: MEASURED_AT }),
    );
    expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([
      'at',
      'confidence',
      'os',
    ]);
  });
});
