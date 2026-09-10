// Item 11 guard (N-2) — the cockpit exit-OS readout.
//
// The load-bearing property: os_fingerprint is ABSENT-means-unknown, so absence
// must render "measuring…", NEVER a placeholder OS. Only a real, well-typed
// {os, confidence} shows the observed line — and it is a NEUTRAL fact (muted, not
// a status colour), unlike the green HTTP/3 verdict beside it.
// Mutation: rendering an OS on an absent field reds the first two arms.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OsReadout } from '../../src/components/OsReadout';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

function report(over: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...over,
  };
}

describe('OsReadout', () => {
  it('renders "measuring…" when there is no report yet', () => {
    render(<OsReadout report={null} />);
    const el = screen.getByText(/OS: measuring/i);
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-state')).toBe('measuring');
  });

  it('renders "measuring…" when the report is present but os_fingerprint is ABSENT — absence is not a placeholder OS', () => {
    // The whole point: an absent os_fingerprint must not read as a known OS.
    render(<OsReadout report={report({})} />);
    const el = screen.getByText(/OS: measuring/i);
    expect(el.getAttribute('data-state')).toBe('measuring');
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('renders "<os> · <confidence>" once the exit OS fingerprint was observed', () => {
    render(
      <OsReadout report={report({ os_fingerprint: { os: 'windows', confidence: 'medium' } })} />,
    );
    const el = screen.getByText(/OS: windows · medium/);
    expect(el.getAttribute('data-state')).toBe('observed');
    // Neutral, not a status colour (mirrors ExitIpChip's text-white/70).
    expect(el.className).toContain('text-white/70');
  });

  it('shows the observed os + confidence verbatim (no coercion of the confidence label)', () => {
    render(
      <OsReadout report={report({ os_fingerprint: { os: 'macos-or-ios', confidence: 'high' } })} />,
    );
    expect(screen.getByText(/OS: macos-or-ios · high/)).toBeTruthy();
  });
});
