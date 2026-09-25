// ⛔ ITEM 3 (owner report 2026-09-16) — the read path for `manual_input_available`
// carries THREE states, and all three must survive serialisation.
//
// Remote control of the phone is gated on this one field. The GUI can only say
// "the phone has not reported yet" instead of an indefinite, unexplained
// "connecting" if ABSENCE is still recognisable when it reaches the client. Two
// one-character changes would destroy that and neither would fail any other test
// in this suite:
//
//   * `frame.manualInputAvailable ?? false` in the store — a device that never
//     answered would be reported as having said NO, and the GUI would render a
//     confident "View only — device input is unavailable" from no evidence.
//   * dropping the key from `customerSafeCapabilityReport` (or spreading only
//     the non-null fields) — the client's parser maps a missing key to null, so
//     "reported false" would arrive as "never reported" instead.
//
// So this pins the three states at the projection AND over the wire (the JSON the
// customer actually receives), plus the fourth shape the client must keep
// distinct: no capability_report key at all, which is what a session whose device
// has sent nothing looks like.
//
// It does NOT change what the device sends — only that what it sent, or did not
// send, stays legible.

import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAgentSessionsRoutes } from '../../src/routes/agent-sessions.js';
import type { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  SessionCapabilityReportStore,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

const ACC = 'acc_input_capability';
const SESSION = 'agt_input_capability';

function frame(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: SESSION,
    timestamp: '2026-09-16T06:00:00.000Z',
    egressPhase: 'phase_1_socks5',
    proxyKind: 'openvpn',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: false,
    httpsSkipActive: true,
    safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

function makeRecord(status: AgentSessionRecord['status'] = 'active'): AgentSessionRecord {
  return {
    id: SESSION,
    accountId: ACC,
    driftstackSessionId: null,
    proxyId: null,
    stopOnExitIpChange: false,
    firstExitIp: null,
    profileSaveBackRefused: false,
    status,
    transcript: [],
    tokenBudgetTotal: 100_000,
    tokenBudgetRemaining: 100_000,
    closedReason: null,
    provisioningDetail: null,
    createdByUserId: null,
    closedAt: null,
    pairModeState: null,
    lastErrorEvent: null,
    mode: 'manual',
    model: 'claude-opus-4-7',
    nodeId: null,
    profileId: null,
    idempotencyKey: null,
    guiControlKeyExpiresAt: null,
    guiControlKeyCiphertext: null,
    createdAt: new Date('2026-09-16T06:00:00Z'),
    updatedAt: new Date('2026-09-16T06:00:00Z'),
  };
}

async function buildApp(
  capabilityReportStore: SessionCapabilityReportStore,
  status: AgentSessionRecord['status'] = 'active',
) {
  const rec = makeRecord(status);
  const sessions = {
    get: (id: string) => Promise.resolve(id === rec.id ? rec : null),
  } as unknown as AgentSessionsRepo;

  const app = Fastify({ logger: false });
  app.decorateRequest('account', null);
  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    (req as { account: unknown }).account = {
      account: { id: ACC, tier: 'starter' },
      apiKey: { id: 'key_input_capability', scopes: ['read', 'write'] },
    };
    done();
  });
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerAgentSessionsRoutes(app, {
    runtime: {} as unknown as AgentRuntime,
    sessions,
    sessionCapabilityReportStore: capabilityReportStore,
  });
  await app.ready();
  return app;
}

/** The raw JSON body the customer receives — `res.json()` alone cannot tell a
 *  key that is absent from one whose value is null once it is an object, so the
 *  arms below read BOTH the parsed shape and the serialised text. */
async function readSession(
  store: SessionCapabilityReportStore,
  status: AgentSessionRecord['status'] = 'active',
): Promise<{
  parsed: { capability_report?: Record<string, unknown> };
  raw: string;
}> {
  const app = await buildApp(store, status);
  const res = await app.inject({ method: 'GET', url: `/v1/agent-sessions/${SESSION}` });
  expect(res.statusCode).toBe(200);
  const out = {
    parsed: res.json<{ capability_report?: Record<string, unknown> }>(),
    raw: res.body,
  };
  await app.close();
  return out;
}

describe('an absent input capability survives the customer-safe projection', () => {
  it('projects true as true, false as false, and an unanswered field as null — the key is always present', () => {
    const store = new SessionCapabilityReportStore();

    store.set(frame({ manualInputAvailable: true }));
    const yes = store.get(SESSION);
    expect(yes).not.toBeNull();
    expect(customerSafeCapabilityReport(yes!).manual_input_available).toBe(true);

    store.set(frame({ manualInputAvailable: false }));
    const no = store.get(SESSION);
    expect(no).not.toBeNull();
    expect(customerSafeCapabilityReport(no!).manual_input_available).toBe(false);

    // ⛔ The device sent a report but said nothing about input. NOT false: that
    // would be the device's answer, and it never gave one.
    store.set(frame({ manualInputAvailable: undefined }));
    const quiet = store.get(SESSION);
    expect(quiet).not.toBeNull();
    const projected = customerSafeCapabilityReport(quiet!);
    expect(projected.manual_input_available).toBeNull();
    // The KEY must survive the allowlist — a dropped key is indistinguishable
    // from a report that never arrived once it reaches the client parser.
    expect(Object.keys(projected)).toContain('manual_input_available');
    const roundTripped = JSON.parse(JSON.stringify(projected)) as Record<string, unknown>;
    expect(Object.keys(roundTripped)).toContain('manual_input_available');
    expect(roundTripped.manual_input_available).toBeNull();
  });
});

describe('the three input-capability states survive GET /v1/agent-sessions/:id', () => {
  it('keeps true, false, a reported-but-unanswered null, and no report at all pairwise distinguishable on the wire, for a LIVE session', async () => {
    // (1) No report at all — the whole key is omitted, which is how a device that
    // has sent nothing must read. Never an invented report of false.
    const empty = new SessionCapabilityReportStore();
    const none = await readSession(empty);
    expect('capability_report' in none.parsed).toBe(false);
    expect(none.raw).not.toContain('manual_input_available');

    // (2) A report that carried no answer — the key is present, the value null.
    const quietStore = new SessionCapabilityReportStore();
    quietStore.set(frame({ manualInputAvailable: undefined }));
    const quiet = await readSession(quietStore);
    expect(quiet.parsed.capability_report).toBeDefined();
    expect(Object.keys(quiet.parsed.capability_report ?? {})).toContain('manual_input_available');
    expect(quiet.parsed.capability_report?.manual_input_available).toBeNull();
    // Serialised as an explicit null, not dropped and not coerced to false.
    expect(quiet.raw).toContain('"manual_input_available":null');

    // (3) The device's explicit no.
    const noStore = new SessionCapabilityReportStore();
    noStore.set(frame({ manualInputAvailable: false }));
    const no = await readSession(noStore);
    expect(no.parsed.capability_report?.manual_input_available).toBe(false);
    expect(no.raw).toContain('"manual_input_available":false');

    // (4) The device's explicit yes.
    const yesStore = new SessionCapabilityReportStore();
    yesStore.set(frame({ manualInputAvailable: true }));
    const yes = await readSession(yesStore);
    expect(yes.parsed.capability_report?.manual_input_available).toBe(true);
    expect(yes.raw).toContain('"manual_input_available":true');

    // The whole point: no two of the four collapse into each other. Read exactly
    // as the client reads them — "was there a report at all", then the value.
    const state = (r: { parsed: { capability_report?: Record<string, unknown> } }): string =>
      r.parsed.capability_report === undefined
        ? 'no-report'
        : String(r.parsed.capability_report.manual_input_available);
    expect([state(none), state(quiet), state(no), state(yes)]).toEqual([
      'no-report',
      'null',
      'false',
      'true',
    ]);
    expect(new Set([state(none), state(quiet), state(no), state(yes)]).size).toBe(4);
  });
});

// ⛔ THE ONE PLACE THE FOUR STATES DO COLLAPSE, pinned so it is a decision and
// not a hole. The arms above all run against `status: 'active'`; the route drops
// the whole projection for a CLOSED session:
//
//     if (rec.status !== 'closed') { … base.capability_report = … }
//
// so for a closed session "the device said yes", "the device said no", "the
// device answered nothing" and "the device never reported" serialise to the
// identical absent-key shape. Nothing is recoverable from the wire there, which
// is exactly why the CLIENT must stop speaking about the phone's report once a
// session is terminal (apps/gui-client: the unreported badge, the keyboard
// tooltip and the Manual caption are all gated on liveness) — otherwise it
// renders OUR erasure as the device's silence.
describe('a CLOSED session projects no report at all — the collapse is deliberate', () => {
  it('serialises a stored true, a stored false and no report at all identically once the session is closed', async () => {
    const yesStore = new SessionCapabilityReportStore();
    yesStore.set(frame({ manualInputAvailable: true }));
    const closedYes = await readSession(yesStore, 'closed');

    const noStore = new SessionCapabilityReportStore();
    noStore.set(frame({ manualInputAvailable: false }));
    const closedNo = await readSession(noStore, 'closed');

    const closedNone = await readSession(new SessionCapabilityReportStore(), 'closed');

    for (const res of [closedYes, closedNo, closedNone]) {
      expect('capability_report' in res.parsed).toBe(false);
      expect(res.raw).not.toContain('manual_input_available');
    }
    // The positive control that the drop is the STATUS's doing and not a broken
    // fixture: the very same store, read on a live session, still answers.
    const liveYes = await readSession(yesStore, 'active');
    expect(liveYes.parsed.capability_report?.manual_input_available).toBe(true);

    // And 'paused' is NOT closed — only the terminal status drops it.
    const pausedNo = await readSession(noStore, 'paused');
    expect(pausedNo.parsed.capability_report?.manual_input_available).toBe(false);
  });
});
