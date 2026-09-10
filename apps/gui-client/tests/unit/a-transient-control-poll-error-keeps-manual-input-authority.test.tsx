// Guard for two CONFIRMED SimulatorWindow egress/control-poll defects, both
// fixed by decoupling a decision from a cosmetic signal:
//
//   MED #3 — the background session-liveness poll's `.catch` used to revoke
//   manual-input authority and blank the egress readouts UNCONDITIONALLY, so a
//   transient 5xx / network blip on a HEALTHY session flipped the cockpit into a
//   degraded state for ~5s. The revocation must fire ONLY on an auth failure
//   (401/403 — the per-session gui_control_key expired). `shouldControlPollErrorRevoke`
//   carries that decision; these arms pin it.
//
//   MED #2 — the Egress card (exit IP / HTTP-3 / OS readouts) was gated on the
//   cosmetic `proxy` query param, so a reopened session whose proxy resolved to
//   '' had its LIVE measured exit identity blanked even though the capabilityReport
//   carried it. `reportHasEgressReadout` decides whether the card renders off the
//   report, independent of the label.
//
// Both are pure exported predicates (the JSX/`.catch` glue is a one-liner over
// each), so this runs without the heavy full-window render harness.

import { describe, expect, it } from 'vitest';

import {
  shouldControlPollErrorRevoke,
  reportHasEgressReadout,
} from '../../src/views/SimulatorWindow';
import {
  AgentSessionControlError,
  type AgentSessionCapabilityReport,
} from '../../src/lib/agent-session-control';

describe('shouldControlPollErrorRevoke (MED #3 — only AUTH failures revoke)', () => {
  it('revokes on 401 and 403 (expired per-session gui_control_key)', () => {
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('unauthorized', 401, 'unknown')),
    ).toBe(true);
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('forbidden', 403, 'forbidden')),
    ).toBe(true);
  });

  it('does NOT revoke on a transient 5xx — the load-bearing arm', () => {
    // If the fix is reverted (revocation becomes unconditional / the status gate
    // widens or is dropped), a 500 would revoke and this flips to true.
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('bad gateway', 502, 'unknown')),
    ).toBe(false);
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('server error', 500, 'unknown')),
    ).toBe(false);
  });

  it('does NOT revoke on a non-auth 4xx (404 / 409) — pins the exact 401||403 gate', () => {
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('missing', 404, 'not-found')),
    ).toBe(false);
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('conflict', 409, 'conflict')),
    ).toBe(false);
  });

  it('does NOT revoke on a network/transport blip (status 0) or a non-control error', () => {
    expect(
      shouldControlPollErrorRevoke(new AgentSessionControlError('network', 0, 'unknown')),
    ).toBe(false);
    expect(shouldControlPollErrorRevoke(new TypeError('Failed to fetch'))).toBe(false);
    // Pins the `instanceof` guard: a look-alike with a 401 status but the wrong
    // type must not revoke (else a bare narrowing revert would slip through).
    expect(shouldControlPollErrorRevoke({ status: 401 })).toBe(false);
  });
});

describe('reportHasEgressReadout (MED #2 — card renders off the report, not the label)', () => {
  const base: AgentSessionCapabilityReport = {
    manual_input_available: true,
    streaming_state: 'live',
    egress_state: 'live',
  };

  it('is true when the report carries a measured exit IP (proxyLabel need not be set)', () => {
    // The bug scenario: a reopened session whose proxy resolved to '' but whose
    // exit identity IS measured. Reverting the card back to a proxyLabel-only gate
    // does not touch this predicate, but the predicate is the carrier of the
    // decision the JSX now consults; this arm proves the report-driven contract.
    expect(reportHasEgressReadout({ ...base, exit_ip: '203.0.113.7' })).toBe(true);
  });

  it('is true for an h3-only or os-only report', () => {
    expect(reportHasEgressReadout({ ...base, h3_connection_observed: true })).toBe(true);
    expect(
      reportHasEgressReadout({ ...base, os_fingerprint: { os: 'iOS', confidence: 'high' } }),
    ).toBe(true);
  });

  it('is false for a null report and for a report with no egress-relevant field', () => {
    expect(reportHasEgressReadout(null)).toBe(false);
    expect(reportHasEgressReadout(base)).toBe(false);
  });
});
