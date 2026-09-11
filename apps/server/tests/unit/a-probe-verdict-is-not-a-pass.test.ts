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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
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

  it('CRITICAL the registry OBSERVES which keys the node sent — names only, no values', () => {
    // ⛔ Without this, `status` arriving-and-agreeing and `status` not arriving at
    // all produce identical evidence: the frame parses either way. A clean parse
    // is a fact about validation, not about the key set, and reading one as the
    // other is the proxy-for-the-thing mistake this whole migration removes. It
    // is also what step 3 needs to confirm `ok` has GONE, so it is not scaffolding.
    const src = readFileSync(
      resolve(HERE, '..', '..', 'src', 'services', 'fleet-control-registry.ts'),
      'utf8',
    );
    expect(src).toContain("'probeEgressResult accepted: key set'");
    // W-29 — the SAME observation on capabilityReport. Without it nothing can see
    // whether the node sends `h3ConnectionCount`: a clean parse says nothing about
    // the key set (the customer projection carries the count since (o) O2, but
    // the parse-side key log is still the only evidence of what the NODE sent).
    expect(src).toContain("'capabilityReport accepted: key set'");
    expect(src).toContain("Object.keys(frame).sort().join(',')");
    // ⛔ Structure only, on BOTH lines. The first version of this arm checked the
    // probeEgressResult site alone — the identical "an instrument built for one
    // member of a pair covers only that member" mistake, committed inside the
    // change that exists to fix it. Whatever is asserted of one of these lines is
    // asserted of every one of them.
    for (const marker of [
      'probeEgressResult accepted: key set',
      'capabilityReport accepted: key set',
    ]) {
      const at = src.indexOf(marker);
      expect(at, `${marker} not found`).toBeGreaterThan(0);
      const line = src.slice(at - 400, at);
      expect(
        line,
        `${marker}: key NAMES only — these frames hold an exit IP, a proxy detail ` +
          'string, an archetype id and the customer upstream',
      ).not.toMatch(
        // ⛔ `proxyUpstream` is named explicitly: it is CUSTOMER INFRASTRUCTURE and
        // belongs in the control-plane join, never in a log line. Naming it gives a
        // later "just add the upstream for debugging" something to fail against.
        /JSON\.stringify\(frame\)|\.\.\.frame|frame\.exit_ip|frame\.quic_detail|frame\.proxyUpstream|frame\.archetypeId/,
      );
    }
    // ⛔ THE ONE EXEMPTION, asserted rather than left as an absence in the list
    // above. `h3ConnectionCount` is logged BY VALUE on purpose: presence answers
    // "does the node send it", and the question that matters is whether it MOVES,
    // which a key set cannot show. Pinning it means removing the value REDS this
    // arm — so the instrument cannot quietly lose the ability to answer the
    // question it exists for. It is a small non-negative integer: it identifies no
    // customer, names no endpoint, and correlates to no person.
    expect(src).toContain('h3ConnectionCount: frame.h3ConnectionCount,');
  });

  it('CRITICAL h3ConnectionCount is accepted — a latched boolean cannot carry liveness', () => {
    // ⛔ `h3ConnectionObserved` is backed by an insert-only Set on the node and can
    // never return to false. It is a sound "h3 was reached at least once" claim
    // and an unsound liveness signal: a consumer treating it as current would
    // refresh a verdict on a relay that died an hour ago, and the timestamp would
    // look fresh BECAUSE nothing was checking. The monotone count carries the rate
    // the boolean cannot. Declared before it is emitted — this frame strips
    // undeclared keys rather than rejecting them, so an early emission would be
    // invisible on both sides.
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
    const ok = CapabilityReportSchema.safeParse({ ...frame, h3ConnectionCount: 7 });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.h3ConnectionCount).toBe(7);
    // Zero is a real value — "the session has completed none" — not an absence.
    const zero = CapabilityReportSchema.safeParse({ ...frame, h3ConnectionCount: 0 });
    expect(zero.success && zero.data.h3ConnectionCount === 0).toBe(true);
    // A count cannot be negative or fractional; those are producer bugs, not data.
    for (const bad of [-1, 1.5]) {
      expect(CapabilityReportSchema.safeParse({ ...frame, h3ConnectionCount: bad }).success).toBe(
        false,
      );
    }
  });

  // ⛔ W-28 STEP 3 — these four arms are one change, and shipping any subset breaks
  // the migration. The peer found the trap before either side deployed: `ok` was
  // REQUIRED, so a node dropping it would have failed every frame and timed out
  // every probe — and making it optional ALONE is worse, because the disagreement
  // check compares against `undefined` and refuses 100% of migrated frames.
  it('CRITICAL a status-only frame (no `ok`) is ACCEPTED — the migrated shape', () => {
    const { ok: _dropped, ...noOk } = DEAD;
    const parsed = ProbeEgressResultSchema.safeParse({ ...noOk, status: 'verdict' });
    expect(parsed.success, 'the whole point of step 3').toBe(true);
    expect(probeReachedVerdict({ status: 'verdict' })).toBe(true);
    expect(probeReachedVerdict({ status: 'could_not_run' })).toBe(false);
  });

  it('CRITICAL a frame with NEITHER `ok` nor `status` is refused', () => {
    // Both optional would otherwise let a frame parse and then answer "did the
    // probe reach a verdict?" with undefined — the silent no-answer this whole
    // migration exists to remove, arriving through the migration itself.
    const { ok: _dropped, ...neither } = DEAD;
    const parsed = ProbeEgressResultSchema.safeParse(neither);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'status')).toBe(true);
    }
  });

  it('CRITICAL the reader never returns undefined while declaring boolean', () => {
    // Unreachable from a parsed frame, and handled anyway: the previous body
    // returned `frame.ok` directly, which the moment `ok` became optional returned
    // undefined under a `boolean` signature — a lie the type system accepted and a
    // caller would read as "did not reach a verdict".
    expect(probeReachedVerdict({})).toBe(false);
    expect(typeof probeReachedVerdict({})).toBe('boolean');
  });

  it('VACUITY CONTROL — an `ok`-only frame still parses, so step 3 did not just widen everything', () => {
    // The un-migrated shape must keep working for the whole window; if this arm
    // ever fails, the CP has stopped accepting nodes that have not moved yet.
    expect(ProbeEgressResultSchema.safeParse(DEAD).success).toBe(true);
    expect(probeReachedVerdict({ ok: true })).toBe(true);
    expect(probeReachedVerdict({ ok: false })).toBe(false);
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

// VPN exit parity — the node now resolves the exit's geo beside `exit_ip`
// (exit_country / exit_timezone / exit_region / exit_city). Each is
// `.nullable().optional()`, BOTH, for the W-28 reason above: nullable so the
// node's explicit "no answer" arrives as null; optional so a node that does not
// yet emit the key still validates — deployable CP-first or node-first with no
// window in which a frame is refused.
describe('VPN exit parity — the four exit geo keys are nullable AND optional', () => {
  const GEO = {
    exit_country: 'DE',
    exit_timezone: 'Europe/Berlin',
    exit_region: 'Hesse',
    exit_city: 'Frankfurt am Main',
  };

  it('CRITICAL a frame WITHOUT the four keys parses — every un-migrated node and every existing fixture', () => {
    // DEAD carries none of the four keys, on purpose: it is the shape a node that
    // predates this change sends.
    expect('exit_country' in DEAD).toBe(false);
    const parsed = ProbeEgressResultSchema.safeParse({ ...DEAD, exit_ip: '203.0.113.7' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Absent stays ABSENT — not coerced to null, so a consumer can tell "the
      // node did not say" from "the node said there is none".
      expect('exit_country' in parsed.data).toBe(false);
      expect('exit_timezone' in parsed.data).toBe(false);
      expect('exit_region' in parsed.data).toBe(false);
      expect('exit_city' in parsed.data).toBe(false);
    }
  });

  it('CRITICAL a frame with all four EXPLICITLY null parses, and the nulls survive', () => {
    const parsed = ProbeEgressResultSchema.safeParse({
      ...DEAD,
      exit_ip: '203.0.113.7',
      exit_country: null,
      exit_timezone: null,
      exit_region: null,
      exit_city: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.exit_country).toBeNull();
      expect(parsed.data.exit_timezone).toBeNull();
      expect(parsed.data.exit_region).toBeNull();
      expect(parsed.data.exit_city).toBeNull();
    }
  });

  it('VACUITY CONTROL — real values round-trip, so the arms above are not passing on a schema that strips the keys', () => {
    const parsed = ProbeEgressResultSchema.safeParse({ ...DEAD, exit_ip: '203.0.113.7', ...GEO });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.exit_country).toBe('DE');
      expect(parsed.data.exit_timezone).toBe('Europe/Berlin');
      expect(parsed.data.exit_region).toBe('Hesse');
      expect(parsed.data.exit_city).toBe('Frankfurt am Main');
    }
  });

  it('CRITICAL a 300-char exit_city is REFUSED — the same bound as exit_ip, at the path that names the field', () => {
    const parsed = ProbeEgressResultSchema.safeParse({
      ...DEAD,
      exit_ip: '203.0.113.7',
      ...GEO,
      exit_city: 'x'.repeat(300),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'exit_city')).toBe(true);
    }
    // Boundary positive control: exactly the bound (256) still parses, so the
    // refusal above is the bound and not a schema that refuses any long string.
    expect(
      ProbeEgressResultSchema.safeParse({
        ...DEAD,
        exit_ip: '203.0.113.7',
        ...GEO,
        exit_city: 'x'.repeat(256),
      }).success,
    ).toBe(true);
    // And each of the other three carries the same bound — one assertion per key,
    // so a key that quietly loses its `.max()` reds on its own name.
    for (const key of ['exit_country', 'exit_timezone', 'exit_region'] as const) {
      expect(
        ProbeEgressResultSchema.safeParse({
          ...DEAD,
          exit_ip: '203.0.113.7',
          ...GEO,
          [key]: 'x'.repeat(300),
        }).success,
        key,
      ).toBe(false);
    }
  });
});
