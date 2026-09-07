// T-26 (owner #12) — the simulator cockpit surfaces a session's LIVE exit
// identity, and a profile can opt to stop the session when the exit IP rotates.
//
// Two units are covered here, both pure and testable without driving a launch:
//
//  1. ExitIpChip — the cockpit chip. Three render arms:
//       • exit IP + a DIFFERENT WebRTC candidate → the warning (leak) treatment,
//       • exit IP + a MATCHING WebRTC candidate → no warning (the vacuity control
//         for the warning arm: the same shape with coherent IPs must NOT warn),
//       • absent fields → the muted "measuring…" state, no crash (the live state
//         today, until the harness/A3 emits the fields).
//
//  2. stopOnExitIpChangeCreateFields — the create-body fragment. The flag is
//     present iff the profile opted in; a default profile yields nothing (the
//     vacuity control). Mutation proof: hardcoding the production helper to `{}`
//     reds the "opted-in" arm; the default-profile arm stays green either way,
//     so it cannot mask that mutation.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ExitIpChip } from '../../src/components/ExitIpChip';
import { stopOnExitIpChangeCreateFields } from '../../src/lib/agent-session-create-fields';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import type { ProfileMeta } from '../../src/lib/profiles-meta';

/** A capability report with the health fields nulled — the caller layers on the
 *  exit-identity fields under test. */
function report(extra: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...extra,
  };
}

function meta(extra: Partial<ProfileMeta>): ProfileMeta {
  return { folder: '', tags: [], note: '', icon: '', ...extra };
}

describe('ExitIpChip', () => {
  it('marks a WebRTC candidate that differs from the exit IP as a leak', () => {
    const { container } = render(
      <ExitIpChip
        report={report({
          exit_ip: '203.0.113.7',
          exit_country: 'US',
          exit_timezone: 'America/New_York',
          webrtc_candidate_ips: ['203.0.113.7', '198.51.100.4'],
        })}
      />,
    );
    const chip = container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('observed');
    expect(chip?.textContent).toContain('203.0.113.7');
    expect(chip?.textContent).toContain('US');
    expect(chip?.textContent).toContain('America/New_York');
    const webrtc = container.querySelector('[data-component="sim-webrtc-candidates"]');
    expect(webrtc?.getAttribute('data-leak')).toBe('true');
    expect(webrtc?.className).toContain('text-status-error');
    expect(webrtc?.textContent).toContain('198.51.100.4');
  });

  it('does NOT warn when every WebRTC candidate matches the exit IP (vacuity)', () => {
    const { container } = render(
      <ExitIpChip
        report={report({
          exit_ip: '203.0.113.7',
          webrtc_candidate_ips: ['203.0.113.7'],
        })}
      />,
    );
    const webrtc = container.querySelector('[data-component="sim-webrtc-candidates"]');
    expect(webrtc?.getAttribute('data-leak')).toBe('false');
    expect(webrtc?.className).not.toContain('text-status-error');
  });

  it('degrades to a muted "measuring…" state when the exit fields are absent (no crash)', () => {
    // null report (control panel not yet loaded)…
    const nullRender = render(<ExitIpChip report={null} />);
    const nullChip = nullRender.container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(nullChip?.getAttribute('data-state')).toBe('measuring');
    expect(nullChip?.textContent).toContain('measuring');

    // …and a live report that simply has not carried exit fields yet (today's
    // real state): still measuring, and NO webrtc line is drawn.
    const { container } = render(<ExitIpChip report={report({ h3_connection_observed: true })} />);
    const chip = container.querySelector('[data-component="sim-exit-ip-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('measuring');
    expect(container.querySelector('[data-component="sim-webrtc-candidates"]')).toBeNull();
  });
});

describe('stopOnExitIpChangeCreateFields', () => {
  it('includes stop_on_exit_ip_change:true iff the profile opted in', () => {
    expect(stopOnExitIpChangeCreateFields(meta({ stopOnExitIpChange: true }))).toEqual({
      stop_on_exit_ip_change: true,
    });
  });

  it('omits the flag for a default profile and for absent meta (vacuity)', () => {
    // A default profile has no flag → the fragment is empty (never stop).
    expect(stopOnExitIpChangeCreateFields(meta({}))).toEqual({});
    // An explicit false is treated as off, not written as false.
    expect(stopOnExitIpChangeCreateFields(meta({ stopOnExitIpChange: false }))).toEqual({});
    // No meta at all (a brand-new profile) → empty.
    expect(stopOnExitIpChangeCreateFields(undefined)).toEqual({});
  });
});
