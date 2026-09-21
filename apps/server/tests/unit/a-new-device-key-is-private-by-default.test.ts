// The device team ships a key; the customer API does not.
//
// ⛔ THE DEFECT THESE ARMS CLOSE. `sessions.egress_capability_report` is the
// device's whole capabilityReport frame, and `publicSession()` echoed it
// VERBATIM on four customer responses. So the act of DECLARING a key on
// `CapabilityReportPayloadSchema` published it — no allowlist, no reviewer, no
// day in between. `webkitForkBuild` (an internal build string naming one of our
// checkouts) rode that path for months, and a measured framework digest was kept
// off it only by deleting that ONE key by name before storage: a denylist of
// one, which defends against the key somebody already thought of and nothing
// else.
//
// The fix inverts the default, so these arms test the INVERSION, not a list:
//   1. every key the schema declares is CLASSIFIED — a new key with no
//      classification fails here (and does not compile in the service file).
//   2. a key that is classified `operator` never reaches the filter's output.
//   3. the two allowlists that govern this one frame AGREE. There are two
//      because the frame leaves through two different shapes — the raw blob
//      (camelCase) on the sessions API and the derived projection (snake_case)
//      on the agent-session API — and a fact public through one and private
//      through the other is still public.
//
// ⚠️ THE SHAPE IS READ FROM THE SCHEMA, NOT COPIED. A hand-written key list in a
// test goes stale the day the schema grows a key, and its staleness fails OPEN:
// the new key is simply not checked. Every arm below derives its key set from
// `CapabilityReportPayloadSchema.shape`, with a positive control so an accessor
// that silently returns nothing cannot read as a pass.

import { describe, expect, it } from 'vitest';
import { CapabilityReportPayloadSchema } from '../../src/schemas/harness-control-protocol.js';
import {
  EGRESS_CAPABILITY_REPORT_AUDIENCE,
  PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS,
  customerSafeEgressCapabilityReport,
} from '../../src/services/customer-safe-egress-capability-report.js';
import {
  SessionCapabilityReportStore,
  customerSafeCapabilityReport,
} from '../../src/services/session-capability-report-store.js';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';

/** Every key the wire frame declares, minus the `type` discriminator the relay
 *  strips (it names the envelope, not the session). Read from the schema. */
const DECLARED_KEYS: string[] = Object.keys(CapabilityReportPayloadSchema.shape)
  .filter((key) => key !== 'type')
  .sort();

/** camelCase → snake_case, the exact renaming the store projection performs.
 *
 *  ⚠️ SPLIT ON UPPERCASE ONLY, NEVER ON DIGITS. The obvious `[A-Z0-9]+` form
 *  turns `h3ConnectionObserved` into `h_3_connection_observed` and
 *  `webkitFrameworkSha256` into `webkit_framework_sha_256` — names that match
 *  nothing, so every comparison below would silently be skipped and the guard
 *  would pass while checking two of the fields it is meant to check. */
function snake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Fields the STORE record carries and the projection deliberately withholds.
 *  Listed so the drift arm can tell "the projection has no such field" (nothing
 *  to compare) apart from "the projection has it and keeps it private" (a real
 *  comparison). Each is an `Omit` member of `CustomerSafeCapabilityReport`. */
const STORE_ONLY_PRIVATE_COUNTERPARTS = [
  'streaming_health',
  'interpose_image_loaded',
  'webkit_fork_build',
  'webkit_framework_sha256',
  'reporting_node_id',
];

describe('the capability-report key set is fully classified', () => {
  it('POSITIVE CONTROL — the schema shape is actually readable', () => {
    // Without this, an accessor that returned `{}` would make every arm below
    // vacuously true: "no unclassified keys" is trivially satisfied by no keys.
    expect(DECLARED_KEYS.length).toBeGreaterThan(20);
    expect(DECLARED_KEYS).toContain('webkitForkBuild');
    expect(DECLARED_KEYS).toContain('exitIp');
    expect(DECLARED_KEYS).not.toContain('type');
  });

  it('CRITICAL every declared key is classified customer or operator — a NEW device key fails here', () => {
    const classified = Object.keys(EGRESS_CAPABILITY_REPORT_AUDIENCE).sort();
    const unclassified = DECLARED_KEYS.filter((key) => !classified.includes(key));
    const stale = classified.filter((key) => !DECLARED_KEYS.includes(key));
    expect(
      unclassified,
      'a key was added to CapabilityReportPayloadSchema without deciding whether a customer may see it. ' +
        'Classify it in EGRESS_CAPABILITY_REPORT_AUDIENCE — when in doubt, operator.',
    ).toEqual([]);
    expect(
      stale,
      'EGRESS_CAPABILITY_REPORT_AUDIENCE classifies a key the schema no longer declares.',
    ).toEqual([]);
    expect(classified).toEqual(DECLARED_KEYS);
  });

  it('CRITICAL the public key set is exactly the customer-classified keys, and excludes the build strings', () => {
    const expectedPublic = DECLARED_KEYS.filter(
      (key) =>
        EGRESS_CAPABILITY_REPORT_AUDIENCE[key as keyof typeof EGRESS_CAPABILITY_REPORT_AUDIENCE] ===
        'customer',
    );
    expect([...PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS]).toEqual(expectedPublic);
    // The named leak from the review, plus its measured twin, plus the fields
    // whose whole purpose is to name our infrastructure.
    for (const operatorKey of [
      'webkitForkBuild',
      'webkitFrameworkSha256',
      'proxyUpstream',
      'egressPhase',
      'streamingHealth',
      'interposeImageLoaded',
      'safeguardChecks',
    ]) {
      expect(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS).not.toContain(operatorKey);
    }
    // VACUITY CONTROL — the allowlist still allows. Without this the arm above
    // passes against an empty list, which would be "secure" and useless.
    expect(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS).toContain('exitIp');
    expect(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS).toContain('proxyKind');
    expect(PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS.length).toBeGreaterThan(10);
  });
});

describe('the two allowlists over one frame agree', () => {
  // The agent-session projection (`customerSafeCapabilityReport`) and the raw
  // sessions blob (`customerSafeEgressCapabilityReport`) are separate lists
  // because their key namespaces differ and the raw frame carries keys the store
  // record never materialises. Separate lists drift; this arm is the guard that
  // makes the drift fail rather than ship.
  function projectionKeys(): Set<string> {
    const store = new SessionCapabilityReportStore();
    const frame: CapabilityReport = {
      type: 'capabilityReport',
      sessionId: 'agt_drift',
      timestamp: '2026-09-21T00:00:00.000Z',
      egressPhase: 'phase_1_socks5',
      proxyKind: 'socks5',
      proxyUdpSupported: true,
      proxyIpv4Supported: true,
      proxyIpv6Supported: false,
      transportModeRequested: 'h2-and-h3',
      transportModeActive: 'h2-and-h3',
      h3InterposeLoaded: true,
      httpsSkipActive: false,
      safeguardChecks: [{ layer: 'dns', passed: true, timestamp: 't' }],
      archetypeId: 'iphone16pro_ios18_6_safari18_6',
    };
    store.set(frame, 'mac-node-1');
    const stored = store.get('agt_drift');
    expect(stored).not.toBeNull();
    return new Set(Object.keys(customerSafeCapabilityReport(stored!)));
  }

  it('CRITICAL a fact public in one list is public in the other, and private in one is private in the other', () => {
    const projection = projectionKeys();
    expect(projection.size, 'POSITIVE CONTROL — the projection projects').toBeGreaterThan(5);

    const disagreements: string[] = [];
    for (const key of DECLARED_KEYS) {
      const snakeKey = snake(key);
      // Only the facts that exist in BOTH namespaces can disagree. The store
      // record does not materialise every frame key (it derives
      // `safeguards_passed` from `safeguardChecks`, for instance), and a fact the
      // projection never carries cannot be leaked by it.
      const storeCarriesIt =
        projection.has(snakeKey) || STORE_ONLY_PRIVATE_COUNTERPARTS.includes(snakeKey);
      if (!storeCarriesIt) continue;
      const publicInRaw = PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS.includes(
        key as (typeof PUBLIC_EGRESS_CAPABILITY_REPORT_KEYS)[number],
      );
      const publicInProjection = projection.has(snakeKey);
      if (publicInRaw !== publicInProjection) {
        disagreements.push(
          `${key} is ${publicInRaw ? 'PUBLIC' : 'private'} on the sessions blob but ` +
            `${publicInProjection ? 'PUBLIC' : 'private'} as ${snakeKey} on the agent projection`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe('the filter itself', () => {
  it('CRITICAL copies allowlisted keys through and drops everything else, including a key nobody has declared yet', () => {
    const stored: Record<string, unknown> = {
      exitIp: '203.0.113.7',
      exitCountry: 'NL',
      proxyKind: 'socks5',
      webkitForkBuild: '4410edcd9',
      proxyUpstream: 'relay.internal.driftstack.dev:1080',
      // The future key: declared by nobody, shipped by the device tomorrow.
      someKeyTheDeviceTeamAddsNextWeek: 'internal-build-path-/Users/ci/checkout',
    };
    const filtered = customerSafeEgressCapabilityReport(stored);
    expect(filtered).toEqual({ exitIp: '203.0.113.7', exitCountry: 'NL', proxyKind: 'socks5' });
    expect(filtered).not.toHaveProperty('someKeyTheDeviceTeamAddsNextWeek');
  });

  it('null stays null, and a report with nothing customer-visible in it is {} rather than null', () => {
    expect(customerSafeEgressCapabilityReport(null)).toBeNull();
    expect(customerSafeEgressCapabilityReport(undefined)).toBeNull();
    // `null` means NO REPORT HAS ARRIVED. `{}` means one arrived and none of it
    // crosses. Collapsing the second into the first would tell a customer their
    // device never reported.
    expect(customerSafeEgressCapabilityReport({ webkitForkBuild: 'x' })).toEqual({});
  });

  it('never materialises an absent key — absence means UNMEASURED on every field of this frame', () => {
    // A filter that wrote `exitIp: null` would turn "nobody looked" into "there
    // is no exit", which is the same over-claim the store's `?? null` contract
    // exists to prevent one layer down.
    const filtered = customerSafeEgressCapabilityReport({ proxyKind: 'socks5' });
    expect(filtered).not.toHaveProperty('exitIp');
    expect(Object.keys(filtered!)).toEqual(['proxyKind']);
  });

  it('refuses a non-object blob rather than spreading it into index keys', () => {
    expect(
      customerSafeEgressCapabilityReport([1, 2, 3] as unknown as Record<string, unknown>),
    ).toBeNull();
    expect(
      customerSafeEgressCapabilityReport('nope' as unknown as Record<string, unknown>),
    ).toBeNull();
  });
});
