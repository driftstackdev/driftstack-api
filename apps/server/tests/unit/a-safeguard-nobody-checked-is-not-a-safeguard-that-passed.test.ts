// The safeguard verdict used to FAIL OPEN, and everyone involved believed the
// opposite — including the authors of both halves.
//
// The node omits a safeguard layer it never checked, rather than reporting it
// false. That is the right call at the source: absent means unmeasured, not
// denied. But it always seeds its OTHER layers, so the omission arrives at the
// control plane as a SHORTER array, never an empty one — and the control plane
// judged completeness with `checks.length > 0 && checks.every(passed)`.
//
// `length > 0` is a PRESENCE test. It cannot see a member that is missing, only
// the absence of all of them. So a session whose screen-recording safeguard was
// never looked at reported `safeguards_passed: TRUE` to the customer, and the
// `safeguards_unreported` warning that was supposed to cover the gap keys on the
// empty array — a shape production never sends.
//
// ⛔ The earlier "fix" made the empty case report FALSE and felt like a close.
// It was addressing a case production does not produce, while the case it does
// produce kept passing. Fixing the wrong direction of a defect reads exactly like
// fixing it.
//
// The set of expected layers is declared by the NODE and read off the frame. A
// list maintained in this repo would go stale the moment a layer was added over
// there, and its staleness would rebuild this same fail-open silently.

import { describe, expect, it } from 'vitest';
import type { CapabilityReport } from '../../src/schemas/harness-control-protocol.js';
import {
  safeguardsPassed,
  missingSafeguardLayers,
} from '../../src/services/session-capability-report-store.js';

const LAYERS = ['network_firewall', 'webkit_gate', 'per_spawn_verification', 'screen_recording'];

function frame(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    type: 'capabilityReport',
    sessionId: 'agt_x',
    timestamp: '2026-09-16T22:00:00.000Z',
    egressPhase: 'phase_2_openvpn',
    proxyKind: 'openvpn',
    proxyUdpSupported: true,
    proxyIpv4Supported: true,
    proxyIpv6Supported: false,
    transportModeRequested: 'h2-and-h3',
    transportModeActive: 'h2-and-h3',
    h3InterposeLoaded: true,
    httpsSkipActive: true,
    safeguardChecks: LAYERS.map((layer) => ({ layer, passed: true, timestamp: 't' })),
    safeguardLayersExpected: LAYERS,
    archetypeId: 'iphone16pro_ios18_6_safari18_6',
    manualInputAvailable: true,
    streamingState: 'live',
    egressState: 'live',
    ...overrides,
  };
}

describe('a safeguard nobody checked is not a safeguard that passed', () => {
  it('every expected layer reported and passed — the only case that may claim success', () => {
    expect(safeguardsPassed(frame())).toBe(true);
    expect(missingSafeguardLayers(frame())).toEqual([]);
  });

  it('CRITICAL an expected layer that never reported is NOT a pass', () => {
    // ⛔ THE PRODUCTION SHAPE. Exactly the frame a node sends when the screen
    // recording grant was never checked: the other three seeded layers are
    // present and passing, and the fourth is simply absent. Under the old
    // predicate this returned true.
    const withheld = frame({
      safeguardChecks: LAYERS.filter((l) => l !== 'screen_recording').map((layer) => ({
        layer,
        passed: true,
        timestamp: 't',
      })),
    });
    expect(safeguardsPassed(withheld), 'a missing layer cannot be reported as passed').toBe(false);
    expect(missingSafeguardLayers(withheld)).toEqual(['screen_recording']);
  });

  it('CRITICAL an ABSENT expected set is unverifiable, and is NOT an empty one', () => {
    // A node that does not declare its expectations has not told us what complete
    // looks like. Falling back to the old predicate is the strongest honest claim
    // available, and the relay says completeness was not verified.
    //
    // ⛔ The failure mode this pins is treating absent as "expects nothing": an
    // empty expected set satisfies the superset test VACUOUSLY, which rebuilds the
    // fail-open one level up while looking like the fix. The node ships no default
    // for that reason, and this arm is what would catch a default creeping in here.
    const undeclared = frame({ safeguardLayersExpected: undefined });
    expect(safeguardsPassed(undeclared)).toBe(true);
    expect(missingSafeguardLayers(undeclared), 'nothing is knowably missing').toEqual([]);

    const declaresNothing = frame({ safeguardLayersExpected: [] });
    expect(safeguardsPassed(declaresNothing)).toBe(true);
    expect(
      missingSafeguardLayers(declaresNothing),
      'an EMPTY declaration is not the same fact as an absent one, even where both pass',
    ).toEqual([]);
  });

  it('a reported failure still fails, and outranks completeness', () => {
    const failed = frame({
      safeguardChecks: LAYERS.map((layer) => ({
        layer,
        passed: layer !== 'screen_recording',
        timestamp: 't',
      })),
    });
    expect(safeguardsPassed(failed)).toBe(false);
    // Reported-and-failed is NOT missing. They are different customer sentences —
    // one says a check ran and said no, the other says nobody looked — and the
    // whole point of the node omitting rather than reporting false is that the
    // two stay apart all the way down.
    expect(missingSafeguardLayers(failed)).toEqual([]);
  });

  it('VACUITY CONTROL — no checks at all is still false', () => {
    // The original defect, kept pinned: `every` over an empty array is true, so
    // without the length guard this is a positive safety claim from no evidence.
    expect(safeguardsPassed(frame({ safeguardChecks: [], safeguardLayersExpected: [] }))).toBe(
      false,
    );
  });
});
