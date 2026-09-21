// Every public response that echoes the stored capability-report blob carries
// exactly the allowlisted keys — and the routes are ENUMERATED, not listed.
//
// ⛔ THE DEFECT. `sessions.egress_capability_report` holds the device's whole
// capabilityReport frame. `publicSession()` echoed it verbatim, so declaring a
// key on `CapabilityReportPayloadSchema` published it to customers the same day,
// with no allowlist in between — `webkitForkBuild`, an internal build string
// naming one of our checkouts, rode that path for months.
//
// ⛔ WHY THE ROUTE SET IS READ FROM THE OPENAPI DOCUMENT. A hand table of the
// echoing routes is only as complete as the last person to re-derive it, and
// this exact blob is echoed by FOUR public operations spread over two route
// files (`POST /v1/profiles/{id}/launch` is registered in `routes/sessions.ts`,
// which is how it has gone missing from hand tables before). The set below is
// computed from the published document by following `$ref`s to every component
// that carries the field: a fifth echoing operation added tomorrow is covered
// the moment it is documented, and one that is NOT documented fails the
// positive control rather than passing unexamined.
//
// The admin operation is enumerated by the same walk and asserted the OTHER way:
// it must still carry the build strings. Operators need them, and
// `requireScope('driftstack_internal_admin')` really does gate that route.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { CapabilityReportPayloadSchema } from '../../src/schemas/harness-control-protocol.js';
import { PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS } from '../../src/services/customer-safe-egress-capability-report.js';

const WIRE_FIELD = 'egress_capability_report';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

// ───────────────────────────────────────────────────────────────────────────
// The frame. Every key the schema declares, plus one the device team has not
// shipped yet — the case the allowlist exists for.
// ───────────────────────────────────────────────────────────────────────────

/** The stored blob: a full frame minus `type`, exactly what the relay persists.
 *  Values are realistic because an operator reading the admin row has to be able
 *  to tell a real leak from a fixture. */
const STORED_BLOB: Record<string, unknown> = {
  sessionId: 'agt_11111111-1111-4111-8111-111111111111',
  timestamp: '2026-09-21T09:00:00.000Z',
  egressPhase: 'phase_1_socks5',
  proxyKind: 'socks5',
  proxyUdpSupported: true,
  dnsLocalResolverAbsent: true,
  proxyIpv4Supported: true,
  proxyIpv6Supported: false,
  proxyGeoCountry: 'NL',
  proxyGeoRegion: 'North Holland',
  proxyIpType: 'residential',
  transportModeRequested: 'h2-and-h3',
  transportModeActive: 'h2-and-h3',
  h3InterposeLoaded: true,
  interposeImageLoaded: true,
  h3ConnectionObserved: true,
  h3ConnectionCount: 4,
  httpsSkipActive: false,
  safeguardChecks: [
    { layer: 'dns', passed: true, timestamp: '2026-09-21T09:00:00.000Z' },
    {
      layer: 'screen_recording',
      passed: false,
      detail: '/Users/ci/checkout/HarnessCoordinator.swift:9688 TCC denial',
      timestamp: '2026-09-21T09:00:00.000Z',
    },
  ],
  safeguardLayersExpected: ['dns', 'screen_recording', 'webrtc'],
  archetypeId: 'iphone16pro_ios18_6_safari18_6',
  webkitForkBuild: '4410edcd9',
  webkitFrameworkSha256: 'wc:4410edcd9abc,wk:1122334455aa,jsc:99887766ddee',
  proxyUpstream: 'relay-07.fleet.internal:1080',
  manualInputAvailable: true,
  streamingState: 'live',
  egressState: 'live',
  exitIp: '203.0.113.7',
  exitCountry: 'NL',
  exitTimezone: 'Europe/Amsterdam',
  webrtcCandidateIps: ['203.0.113.7', '10.1.2.3'],
  observedAt: '2026-09-21T09:00:01.000Z',
  streamingHealth: { subscribers: 2, videoFpsMin: 4, inputStalls: 11 },
  // ⭐ THE KEY NOBODY HAS DECLARED. The whole point of an allowlist is that this
  // one is private without anyone deciding anything about it.
  someFutureDeviceKey: 'built from /Users/ci/checkout at 4410edcd9',
};

/** Keys a customer must never see on this blob. Named individually because the
 *  failure message for "the build string is on the public API" should say so. */
const OPERATOR_KEYS = Object.keys(STORED_BLOB).filter(
  (key) => !(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS as readonly string[]).includes(key),
);

const DERIVED = {
  udp_associate: true,
  quic_route: 'proxy' as const,
  dns_remote_resolve: true,
  warnings: ['safeguard_failed:screen_recording'],
};

// ───────────────────────────────────────────────────────────────────────────
// Enumeration — which documented operations can return this field
// ───────────────────────────────────────────────────────────────────────────

interface EchoOperation {
  method: 'get' | 'post';
  path: string;
}

/** Component schema names that carry `egress_capability_report`, directly or
 *  through a `$ref`. Computed to a fixpoint so a wrapper schema counts too. */
function carrierComponents(doc: Record<string, unknown>): Set<string> {
  const schemas = ((doc.components as Record<string, unknown> | undefined)?.schemas ??
    {}) as Record<string, unknown>;
  const carriers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, schema] of Object.entries(schemas)) {
      if (carriers.has(name)) continue;
      const text = JSON.stringify(schema);
      const direct = text.includes(`"${WIRE_FIELD}"`);
      const viaRef = [...carriers].some((c) => text.includes(`#/components/schemas/${c}"`));
      if (direct || viaRef) {
        carriers.add(name);
        changed = true;
      }
    }
  }
  return carriers;
}

function enumerateEchoOperations(): EchoOperation[] {
  const doc = generateOpenApiSpec() as unknown as Record<string, unknown>;
  const carriers = carrierComponents(doc);
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const found: EchoOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (method !== 'get' && method !== 'post') continue;
      const responses = (operation as Record<string, unknown> | null)?.responses;
      if (responses === undefined || responses === null) continue;
      const text = JSON.stringify(responses);
      const direct = text.includes(`"${WIRE_FIELD}"`);
      const viaRef = [...carriers].some((c) => text.includes(`#/components/schemas/${c}"`));
      if (direct || viaRef) found.push({ method, path });
    }
  }
  return found.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

/** Fill the path parameters of an enumerated operation.
 *
 *  ⚠️ A PARAMETER MAP, NOT A ROUTE LIST. Every enumerated operation must come out
 *  of here with a concrete URL; one that does not is REPORTED, never skipped — a
 *  silently skipped route is exactly the hole enumerating was supposed to close. */
function concreteUrl(op: EchoOperation, ids: { session: string; profile: string }): string {
  const url = op.path
    .replace('/v1/profiles/{id}', `/v1/profiles/${ids.profile}`)
    .replace('/v1/sessions/{id}', `/v1/sessions/${ids.session}`);
  return url;
}

/** Every value stored under `egress_capability_report` anywhere in a response —
 *  the field sits at the top level on a detail response and under `data[]` on a
 *  list, so the walk finds both without knowing which is which. */
function collectReports(body: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(body)) {
    for (const item of body) collectReports(item, out);
    return out;
  }
  if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (key === WIRE_FIELD) out.push(value);
      else collectReports(value, out);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────

describe('the capability-report fixture covers the whole schema', () => {
  it('POSITIVE CONTROL — the stored blob carries every declared key, so nothing is untested by omission', () => {
    const declared = Object.keys(CapabilityReportPayloadSchema.shape).filter((k) => k !== 'type');
    expect(declared.length).toBeGreaterThan(20);
    const missing = declared.filter((key) => !(key in STORED_BLOB));
    expect(
      missing,
      'the schema grew a key this fixture does not send, so the allowlist is untested for it',
    ).toEqual([]);
    // And the unknown-future-key case is genuinely present.
    expect(STORED_BLOB).toHaveProperty('someFutureDeviceKey');
    expect(OPERATOR_KEYS).toContain('webkitForkBuild');
    expect(OPERATOR_KEYS).toContain('someFutureDeviceKey');
  });
});

describe('every documented public echo of the capability report is an allowlist', () => {
  it('CRITICAL enumerated from the OpenAPI document — each public operation returns exactly the allowlisted keys', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };

    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json<{ id: string }>().id;

    const profile = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: auth,
      payload: { name: 'allowlist-fixture' },
    });
    expect(profile.statusCode, profile.body).toBeLessThan(300);
    const profileId = profile.json<{ id: string }>().id;
    expect(profileId).toMatch(/^prof_/);

    // Persist exactly what the relay persists: the full frame minus `type`.
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: DERIVED,
      raw: STORED_BLOB,
    });

    const operations = enumerateEchoOperations();
    const publicOps = operations.filter((op) => !op.path.startsWith('/v1/admin'));
    const adminOps = operations.filter((op) => op.path.startsWith('/v1/admin'));

    // POSITIVE CONTROLS on the enumeration itself. An empty or near-empty set
    // would make every assertion below vacuously true — the failure mode of
    // every census that silently stopped matching.
    expect(publicOps.length, 'the OpenAPI walk found no public echo of the report').toBeGreaterThan(
      0,
    );
    expect(adminOps.length, 'the OpenAPI walk found no admin echo of the report').toBeGreaterThan(
      0,
    );
    const publicLabels = publicOps.map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(publicLabels).toContain('GET /v1/sessions/{id}');
    expect(publicLabels).toContain('POST /v1/profiles/{id}/launch');

    let sawNonNullPublicReport = false;
    for (const op of publicOps) {
      const url = concreteUrl(op, { session: sessionId, profile: profileId });
      expect(url, `no parameter substitution for ${op.method} ${op.path}`).not.toContain('{');
      const res = await fx.app.inject({
        method: op.method === 'get' ? 'GET' : 'POST',
        url,
        headers: auth,
        ...(op.method === 'post' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${op.method} ${url} -> ${res.statusCode} ${res.body}`).toBeLessThan(
        300,
      );
      const reports = collectReports(res.json());
      expect(
        reports.length,
        `${op.method} ${url} returned no ${WIRE_FIELD} at all`,
      ).toBeGreaterThan(0);
      for (const report of reports) {
        // A create returns a brand-new session, whose report is null: that is the
        // honest value, and null is not a leak.
        if (report === null) continue;
        sawNonNullPublicReport = true;
        const keys = Object.keys(report as Record<string, unknown>).sort();
        expect(keys, `${op.method} ${url} echoed keys outside the allowlist`).toEqual(
          [...PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS].sort(),
        );
        for (const operatorKey of OPERATOR_KEYS) {
          expect(report, `${op.method} ${url} leaked ${operatorKey}`).not.toHaveProperty(
            operatorKey,
          );
        }
      }
    }
    expect(
      sawNonNullPublicReport,
      'no public operation returned a populated report, so the allowlist was never exercised',
    ).toBe(true);

    // The admin half of the decision: operators keep the build strings.
    for (const op of adminOps) {
      const res = await fx.app.inject({ method: 'GET', url: op.path, headers: auth });
      expect(res.statusCode).toBe(200);
      const adminReport = collectReports(res.json()).find((r) => r !== null) as Record<
        string,
        unknown
      >;
      expect(adminReport, `${op.path} returned no populated report`).toBeTruthy();
      expect(adminReport).toMatchObject({
        webkitForkBuild: '4410edcd9',
        webkitFrameworkSha256: 'wc:4410edcd9abc,wk:1122334455aa,jsc:99887766ddee',
        proxyUpstream: 'relay-07.fleet.internal:1080',
      });
      expect(adminReport).toHaveProperty('streamingHealth');
      expect(adminReport).toHaveProperty('someFutureDeviceKey');
    }
  });

  it('NEGATIVE CONTROL — the same stored blob unfiltered carries every operator key, so the arm above is not vacuous', async () => {
    fx = await buildTestApp();
    const auth = { authorization: `Bearer ${fx.plaintext}` };
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth,
      payload: {},
    });
    const sessionId = created.json<{ id: string }>().id;
    await fx.sessionsRepo.setEgressCapabilityReport({
      sessionId: sessionId.replace(/^ses_/, ''),
      derived: DERIVED,
      raw: STORED_BLOB,
    });

    // The blob AT REST — what the public response would be if `publicSession()`
    // echoed `s.egressCapabilityReport` the way it used to. Read back from the
    // repo, not reconstructed, so this fails if storage ever starts filtering
    // (which it must not: this row is the only DURABLE record of what the device
    // reported — the in-memory capability-report store the fleet drift report
    // reads is bounded and dies with the process).
    const stored = fx.sessionsRepo.getSession(
      sessionId.replace(/^ses_/, ''),
    )?.egressCapabilityReport;
    expect(stored).toBeTruthy();
    for (const operatorKey of OPERATOR_KEYS) {
      expect(
        stored,
        `the stored blob lost ${operatorKey} — filter at the edge, not at rest`,
      ).toHaveProperty(operatorKey);
    }

    // And the same session's PUBLIC response does not.
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: auth,
    });
    const publicReport = res.json<Record<string, unknown>>()[WIRE_FIELD] as Record<string, unknown>;
    for (const operatorKey of OPERATOR_KEYS) {
      expect(publicReport).not.toHaveProperty(operatorKey);
    }
  });
});
