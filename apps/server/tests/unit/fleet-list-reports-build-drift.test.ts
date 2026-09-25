// GET /v1/mac-nodes — the OPERATOR fleet list, and the surface the admin panel's
// Fleet page reads. 2026-09-19 added two MEASURED build digests to the device
// frames; this is where they, and the contradictions they expose, become visible.
//
// ⛔ THE ROUTE JOINS; IT DOES NOT JUDGE. Everything about who contradicts whom is
// decided by the pure `computeFleetBuildDrift`, which is tested on its own. What
// these arms prove is the part only the route can get wrong: that the heartbeat's
// raw values actually reach the report, that a session is attributed to the right
// DEVICE across the two identities in play (the human node_id the device
// authenticates as, and the fleet_nodes uuid the panel keys rows on), and that a
// session belonging to no listed device is dropped rather than re-attributed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMacNodesRoutes } from '../../src/routes/mac-nodes-register.js';
import type { DrizzleFleetNodesRepo } from '../../src/db/fleet-nodes-repo.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import { SessionCapabilityReportStore } from '../../src/services/session-capability-report-store.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const UUID_ONE = '11111111-1111-4111-8111-111111111111';
const UUID_TWO = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const D = 'dddddddddddd';

// The device's OWN beat timestamp. Finding (d) compares it against a capability
// report's `timestamp` (the same device clock), so both fixtures below carry a
// real time rather than leaving the route to invent one.
const BEAT_AT = '2026-09-19T19:10:00.000Z';

interface NodeFixture {
  id: string;
  nodeId: string | null;
  harnessVersion?: string;
  harnessBinarySha256?: string;
  webkitFrameworkSha256?: string;
  /** Overrides `beatAt` on the snapshot; `null` removes it entirely. */
  beatAt?: string | null;
}

function fakeRepo(nodes: NodeFixture[]): DrizzleFleetNodesRepo {
  return {
    listActive: () =>
      Promise.resolve(
        nodes.map((n) => ({
          id: n.id,
          nodeId: n.nodeId,
          displayName: `mac-${n.id.slice(0, 4)}`,
          region: 'us',
          hardwareClass: 'mac-mini-m2',
          registeredAt: new Date('2026-09-01T00:00:00Z'),
          lastSeenAt: new Date('2026-09-19T19:10:00Z'),
          lastHeartbeat: {
            ...(n.beatAt === null ? {} : { beatAt: n.beatAt ?? BEAT_AT }),
            cpuPercent: 10,
            memoryPercent: 20,
            activeSessionCount: 1,
            ...(n.harnessVersion !== undefined ? { harnessVersion: n.harnessVersion } : {}),
            ...(n.harnessBinarySha256 !== undefined
              ? { harnessBinarySha256: n.harnessBinarySha256 }
              : {}),
            ...(n.webkitFrameworkSha256 !== undefined
              ? { webkitFrameworkSha256: n.webkitFrameworkSha256 }
              : {}),
          },
          livekit: null,
          revokedAt: null,
          revocationReason: null,
        })),
      ),
  } as unknown as DrizzleFleetNodesRepo;
}

function capabilityReport(
  sessionId: string,
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId,
    timestamp: '2026-09-19T19:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'socks5',
    proxyUdpSupported: false,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-only',
    transportModeActive: 'h2-only',
    h3InterposeLoaded: false,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    ...overrides,
  };
}

async function buildHarness(
  repo: DrizzleFleetNodesRepo,
  capabilityReportStore?: SessionCapabilityReportStore,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('requireAuth', (req: { account?: unknown }) => {
    req.account = { account: { id: 'acc_test' }, apiKey: { id: 'apk_test' } };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerMacNodesRoutes(app, {
    repo,
    encryptionKey: ENCRYPTION_KEY,
    ...(capabilityReportStore !== undefined ? { capabilityReportStore } : {}),
  });
  await app.ready();
  return app;
}

interface DriftBody {
  data: { id: string; last_heartbeat: Record<string, unknown> | null }[];
  build_drift: {
    devices: {
      deviceId: string;
      declaredHarnessVersion: string | null;
      declaredWebkitForkBuild: string | null;
      harnessBinary: { state: string; sha256?: string; raw?: string; status?: string };
      frameworks: {
        state: string;
        status?: string;
        frameworks?: string[];
        parts?: Record<string, { state: string; sha256?: string }>;
      };
      flags: string[];
    }[];
    findings: {
      code: string;
      declaredField: string;
      deviceIds: string[];
      sessionIds: string[];
      frameworks: string[];
      detail: string;
    }[];
  };
}

async function list(app: FastifyInstance): Promise<DriftBody> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/mac-nodes',
    headers: { authorization: 'Bearer ds_live_test' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<DriftBody>();
}

describe('GET /v1/mac-nodes reports declared-vs-measured build drift', () => {
  it('CRITICAL two devices on one declared harnessVersion with two binaries are flagged', async () => {
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', harnessVersion: '88d2d0da2', harnessBinarySha256: A },
        { id: UUID_TWO, nodeId: 'mac-002', harnessVersion: '88d2d0da2', harnessBinarySha256: B },
      ]),
    );
    const body = await list(app);
    const finding = body.build_drift.findings.find((f) => f.code === 'harness_binary_drift');
    expect(finding?.deviceIds).toEqual([UUID_ONE, UUID_TWO].sort());
    // The panel keys rows on `id`, so the report must key devices on the same thing.
    expect(body.build_drift.devices.map((d) => d.deviceId).sort()).toEqual(
      [UUID_ONE, UUID_TWO].sort(),
    );
    // And the raw measured values ride the heartbeat snapshot the panel already reads.
    expect(body.data[0]?.last_heartbeat).toMatchObject({ harnessBinarySha256: A });
    await app.close();
  });

  it('CRITICAL a live session is attributed to its device across BOTH identities', async () => {
    // The store keys sessions by the human node_id the frame authenticated as;
    // the fleet row is a uuid. This is the only place those two meet, and getting
    // it wrong would attribute a session to the wrong device — inventing a
    // redeploy that never happened.
    const store = new SessionCapabilityReportStore();
    store.set(
      capabilityReport('agt_live', {
        // 15 minutes before the beat — clear of the two 300 s caches, so the
        // disagreement is about the world and not about when we looked.
        timestamp: '2026-09-19T18:55:00.000Z',
        webkitForkBuild: '4410edcd9',
        webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${C}`,
      }),
      'mac-001',
    );
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${D}` },
      ]),
      store,
    );
    const body = await list(app);
    const finding = body.build_drift.findings.find((f) => f.code === 'session_framework_drift');
    expect(finding?.sessionIds).toEqual(['agt_live']);
    expect(finding?.deviceIds).toEqual([UUID_ONE]);
    expect(finding?.frameworks, 'JavaScriptCore is the one that moved').toEqual(['jsc']);
    // The declared fork build comes from that same capability report.
    expect(body.build_drift.devices[0]?.declaredWebkitForkBuild).toBe('4410edcd9');
    await app.close();
  });

  it('CRITICAL the route supplies the time basis (d) needs, from the DEVICE clock', async () => {
    // ⛔ THE ONLY HOP THAT CAN SILENTLY DISARM FINDING (d). The gate lives in the
    // pure function and is tested there; what only the route can get wrong is
    // forwarding `beatAt` at all. Drop it and (d) stops firing for every device
    // in the fleet, forever, with no error anywhere — the report simply reports
    // less. Same fleet, same digests, same session: with a beat time it fires,
    // and the arm below proves the gap is what decides it.
    const store = new SessionCapabilityReportStore();
    store.set(
      capabilityReport('agt_live', {
        timestamp: '2026-09-19T18:55:00.000Z',
        webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${C}`,
      }),
      'mac-001',
    );
    const withBeat = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${D}` },
      ]),
      store,
    );
    expect((await list(withBeat)).build_drift.findings.map((f) => f.code)).toContain(
      'session_framework_drift',
    );
    await withBeat.close();

    const withoutBeat = await buildHarness(
      fakeRepo([
        {
          id: UUID_ONE,
          nodeId: 'mac-001',
          webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${D}`,
          beatAt: null,
        },
      ]),
      store,
    );
    expect(
      (await list(withoutBeat)).build_drift.findings,
      'no time basis is not a quiet pass — it is no finding',
    ).toEqual([]);
    await withoutBeat.close();
  });

  it('NEGATIVE CONTROL — a session inside two cache lifetimes of the beat is NOT flagged', async () => {
    // The device sets a session's framework value once at spawn from the same
    // 300 s cache the heartbeat reads. Two samples that close prove nothing, and
    // the route must not be quietly bypassing the gate the function applies.
    const store = new SessionCapabilityReportStore();
    store.set(
      capabilityReport('agt_live', {
        timestamp: '2026-09-19T19:05:00.000Z',
        webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${C}`,
      }),
      'mac-001',
    );
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${D}` },
      ]),
      store,
    );
    expect((await list(app)).build_drift.findings).toEqual([]);
    await app.close();
  });

  it('CRITICAL a device status token reaches the report as a STATUS, not as nonsense', async () => {
    // The device team will send `unreadable` / `nopath` in the digest fields.
    // The route must carry the raw value through untouched for the decoder to
    // classify; a route that normalised or dropped it would hand the operator
    // back the two-way hedge the token exists to replace.
    const app = await buildHarness(
      fakeRepo([
        {
          id: UUID_ONE,
          nodeId: 'mac-001',
          harnessVersion: '88d2d0da2',
          harnessBinarySha256: 'nopath',
        },
      ]),
    );
    const body = await list(app);
    expect(body.build_drift.devices[0]?.harnessBinary).toEqual({
      state: 'device-status',
      status: 'nopath',
    });
    const finding = body.build_drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.detail).toContain('had no path to read its executable');
    expect(finding?.detail, 'the device told us; do not hedge').not.toContain('cannot tell');
    await app.close();
  });

  it('CRITICAL a session whose node matches no listed device is DROPPED, not re-attributed', async () => {
    const store = new SessionCapabilityReportStore();
    store.set(
      capabilityReport('agt_orphan', { webkitFrameworkSha256: `wc:${D},wk:${D},jsc:${D}` }),
      'mac-999',
    );
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', webkitFrameworkSha256: `wc:${A},wk:${B},jsc:${C}` },
      ]),
      store,
    );
    const body = await list(app);
    expect(body.build_drift.findings).toEqual([]);
    await app.close();
  });

  it('CRITICAL a declared version with no measured digest is reported as unverified', async () => {
    const app = await buildHarness(
      fakeRepo([{ id: UUID_ONE, nodeId: 'mac-001', harnessVersion: '88d2d0da2' }]),
    );
    const body = await list(app);
    const finding = body.build_drift.findings.find((f) => f.code === 'measured_digest_missing');
    expect(finding?.deviceIds).toEqual([UUID_ONE]);
    expect(finding?.detail).toContain('cannot tell');
    expect(body.build_drift.devices[0]?.harnessBinary).toEqual({ state: 'absent' });
    await app.close();
  });

  it('NEGATIVE CONTROL — a fleet in agreement reports devices and NO findings', async () => {
    // Without this, every arm above would pass against a route that flagged
    // everything, and the panel would show a permanently red fleet.
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', harnessVersion: '88d2d0da2', harnessBinarySha256: A },
        { id: UUID_TWO, nodeId: 'mac-002', harnessVersion: '88d2d0da2', harnessBinarySha256: A },
      ]),
    );
    const body = await list(app);
    expect(body.build_drift.findings).toEqual([]);
    expect(body.build_drift.devices).toHaveLength(2);
    await app.close();
  });

  it('the report is still produced when no capability-report store is wired', async () => {
    // Absent store → finding (d) has nothing to compare. It must never be
    // reported as "no session drift"; the device half still works.
    const app = await buildHarness(
      fakeRepo([
        { id: UUID_ONE, nodeId: 'mac-001', harnessVersion: 'v9', harnessBinarySha256: A },
        { id: UUID_TWO, nodeId: 'mac-002', harnessVersion: 'v9', harnessBinarySha256: B },
      ]),
    );
    const body = await list(app);
    expect(body.build_drift.findings.map((f) => f.code)).toEqual(['harness_binary_drift']);
    await app.close();
  });
});

describe('the heartbeat consumer persists what the report reads', () => {
  // ⚠️ A SOURCE PIN, AND IT IS WEAKER THAN THE ARMS ABOVE — SAY SO RATHER THAN
  // LET IT LOOK LIKE A BEHAVIOURAL TEST. The snapshot object is built inline
  // inside `bootstrap.ts`'s fleet-heartbeat consumer, where it cannot be reached
  // without constructing the whole control plane. What this can prove is that the
  // two keys are still COPIED onto the persisted snapshot; what it cannot prove
  // is that the write reaches Postgres — the integration suite owns that.
  //
  // It is here because the alternative is no coverage at all on the one hop that
  // makes the digests durable, and the failure it guards is silent: the schema
  // would still decode the keys, the route would still compute a report, and
  // every device would simply read "not reported" forever.
  const BOOTSTRAP = readFileSync(
    fileURLToPath(new URL('../../src/lib/bootstrap.ts', import.meta.url)),
    'utf8',
  );

  it('CRITICAL both measured digests are spread onto the persisted snapshot', () => {
    expect(BOOTSTRAP).toContain('frame.harnessBinarySha256 !== undefined');
    expect(BOOTSTRAP).toContain('harnessBinarySha256: frame.harnessBinarySha256,');
    expect(BOOTSTRAP).toContain('frame.webkitFrameworkSha256 !== undefined');
    expect(BOOTSTRAP).toContain('webkitFrameworkSha256: frame.webkitFrameworkSha256,');
  });

  it('CRITICAL they are spread-when-defined, never written as an explicit null', () => {
    // A null is a value. "The device told us nothing" is not, and a snapshot that
    // stored null would make an older build indistinguishable from a device whose
    // file could not be read — collapsing exactly the distinction finding (c)
    // exists to keep open.
    expect(BOOTSTRAP).not.toContain('harnessBinarySha256: frame.harnessBinarySha256 ?? null');
    expect(BOOTSTRAP).not.toContain('webkitFrameworkSha256: frame.webkitFrameworkSha256 ?? null');
  });
});
