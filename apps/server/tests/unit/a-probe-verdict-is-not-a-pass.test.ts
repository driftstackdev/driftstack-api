// W-28 — the node's `ok` is migrating to `status`, and this pins the window.
//
// ⛔ `ok` on `probeEgressResult` means "the probe REACHED A VERDICT", never "the
// proxy is good": a proxy that answers nothing at all arrives as `ok:true` with
// reachable/auth_ok/udp_associate/can_route all false. Its structural sibling
// `ProxyValidationResult.ok` is FALSE for that identical condition, and the doc
// above the warning described the two frames as differing in exactly one
// (unrelated) respect. Two independent consumers read it as a pass; the second
// published a customer-facing PASS for a dead proxy.
//
// The warning existed, was emphatic, and did not work — which is evidence about
// the warning. So the field's SHAPE changes, not its comment: a Bool named `ok`
// beside seven Bools named for the subject invites being read as a summary of
// them, and an enum cannot be rendered as a green tick by accident.
//
// Step 1 of 3: the control plane accepts BOTH and prefers `status`, shipping
// before anything on the node changes — so no window exists where either side
// speaks a dialect the other cannot read, INCLUDING the direction where this
// change is the one rolled back.

import { describe, expect, it } from 'vitest';
import {
  CapabilityReportSchema,
  ProbeEgressResultSchema,
  probeReachedVerdict,
} from '../../src/schemas/harness-control-protocol.js';

/** A frame in the shape a DEAD proxy really produces — measured on a live proxy
 *  2026-09-06, four identical results. */
const DEAD = {
  type: 'probeEgressResult' as const,
  requestId: 'req-1',
  node_id: 'mac-us-001',
  ok: true,
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  latency_ms: null,
  h2_ok: false,
  quic_ok: false,
  quic_detail: 'skipped: endpoint_unreachable',
  exit_ip: null,
  error: null,
};

describe('a probe verdict is not a pass', () => {
  it('CRITICAL a legacy frame with no `status` still parses, and `ok` answers', () => {
    // The node has not migrated yet. Step 1 must not break it.
    const parsed = ProbeEgressResultSchema.safeParse(DEAD);
    expect(parsed.success).toBe(true);
    expect(probeReachedVerdict(DEAD)).toBe(true);
  });

  it('CRITICAL `status` WINS over `ok` once the node sends it', () => {
    expect(probeReachedVerdict({ ok: true, status: 'verdict' })).toBe(true);
    expect(probeReachedVerdict({ ok: false, status: 'could_not_run' })).toBe(false);
  });

  it('CRITICAL a frame whose two keys DISAGREE is refused, not silently resolved', () => {
    // ⛔ Both are derived from one construction site on the node, so a
    // disagreement cannot be version skew — only a real bug, which is exactly
    // when it must be loud. Refusing routes it through the rejection reporter and
    // times the probe out, rather than returning a verdict nobody can trust.
    const parsed = ProbeEgressResultSchema.safeParse({ ...DEAD, status: 'could_not_run' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'status')).toBe(true);
    }
  });

  it('VACUITY CONTROL — the SAME frame with the keys agreeing parses fine', () => {
    // Proves the arm above measures the disagreement, not the presence of
    // `status`: without this, a schema that rejected every `status` would pass it.
    const parsed = ProbeEgressResultSchema.safeParse({ ...DEAD, status: 'verdict' });
    expect(parsed.success).toBe(true);
  });

  it('CRITICAL a verdict is still NOT a pass — the legs decide that', () => {
    // The whole point of the migration, restated as an executable claim: the frame
    // that reached a verdict is the same frame that says the proxy is unusable.
    expect(probeReachedVerdict({ ...DEAD, status: 'verdict' })).toBe(true);
    expect(DEAD.reachable || DEAD.auth_ok || DEAD.can_route).toBe(false);
  });

  it('an unknown status value is refused rather than coerced', () => {
    expect(ProbeEgressResultSchema.safeParse({ ...DEAD, status: 'probably' }).success).toBe(false);
  });

  it('CRITICAL an undeclared key is STRIPPED, not rejected — which is why W-29 ships the field first', () => {
    // ⛔ Measured, because the producer side assumed the opposite and was going to
    // sequence around a frame-drop that does not happen. The quieter truth: this
    // frame is not strict, so an undeclared key costs nothing AND arrives nowhere.
    // Emitting before the schema knows the field would look like success on both
    // sides while the value silently vanished in between.
    const frame = {
      type: 'capabilityReport' as const,
      sessionId: 's1',
      timestamp: 't',
      egressPhase: 'phase_1_socks5' as const,
      proxyKind: 'socks5' as const,
      proxyUdpSupported: true,
      proxyIpv4Supported: true,
      proxyIpv6Supported: false,
      transportModeRequested: 'h2-and-h3' as const,
      transportModeActive: 'h2-and-h3' as const,
      h3InterposeLoaded: true,
      httpsSkipActive: false,
      safeguardChecks: [],
      archetypeId: 'a1',
    };
    const undeclared = CapabilityReportSchema.safeParse({ ...frame, notAFieldWeKnow: 'x' });
    expect(undeclared.success, 'an unknown key must not cost the whole frame').toBe(true);
    if (undeclared.success) {
      expect('notAFieldWeKnow' in undeclared.data).toBe(false);
    }
    // …and the declared one DOES survive, which is the whole point of step 1.
    const declared = CapabilityReportSchema.safeParse({
      ...frame,
      proxyUpstream: '198.51.100.7:1080',
    });
    expect(declared.success).toBe(true);
    if (declared.success) expect(declared.data.proxyUpstream).toBe('198.51.100.7:1080');
  });

  it('CRITICAL proxyUpstream cannot carry credentials — the pattern is the enforcement', () => {
    // A `user:pass@host:port` form is the shape a careless producer would send.
    // Rejecting it structurally beats a comment asking nobody to do that.
    const frame = {
      type: 'capabilityReport' as const,
      sessionId: 's1',
      timestamp: 't',
      egressPhase: 'phase_1_socks5' as const,
      proxyKind: 'socks5' as const,
      proxyUdpSupported: true,
      proxyIpv4Supported: true,
      proxyIpv6Supported: false,
      transportModeRequested: 'h2-and-h3' as const,
      transportModeActive: 'h2-and-h3' as const,
      h3InterposeLoaded: true,
      httpsSkipActive: false,
      safeguardChecks: [],
      archetypeId: 'a1',
    };
    for (const bad of ['u:p@198.51.100.7:1080', 'socks5://198.51.100.7:1080', '198.51.100.7']) {
      expect(CapabilityReportSchema.safeParse({ ...frame, proxyUpstream: bad }).success, bad).toBe(
        false,
      );
    }
    // VACUITY CONTROL — a plain host:port and an IPv6 literal both pass, so the
    // arm above measures the shape rather than a pattern that rejects everything.
    for (const good of ['198.51.100.7:1080', 'proxy.example.com:443', '[2001:db8::1]:1080']) {
      expect(
        CapabilityReportSchema.safeParse({ ...frame, proxyUpstream: good }).success,
        good,
      ).toBe(true);
    }
  });
});
