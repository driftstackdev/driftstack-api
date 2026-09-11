// Item 11 guard — the cockpit HTTP/3 (QUIC) readout.
//
// The load-bearing property (T-27): h3_connection_observed is LATCHED and
// ABSENT-means-unknown, so absence must render as "not observed", NEVER "no
// HTTP/3" — and, since (q) Item 11 residual, never "measuring…" either (nothing
// in this repo can prove the fork build is measuring). A MEASURED count of 0 is
// its own state: "none yet (0 connections)".
//
// Mutations (QuicReadout.tsx / session-h3-observation.ts h3ReadoutState):
//   * render the green verdict on an absent field → the first two arms red;
//   * fold `count === 0` back into the absent branch (delete the 'none-yet'
//     return) → the zero-count arm reds on its data-state and text;
//   * bring back "measuring…" → the absent arms red on the exact text.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuicReadout } from '../../src/components/QuicReadout';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

function report(over: Partial<AgentSessionCapabilityReport>): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...over,
  };
}

describe('QuicReadout', () => {
  it('renders "not observed" when there is no report yet — never "measuring…", never a negative', () => {
    render(<QuicReadout report={null} />);
    const el = screen.getByText('HTTP/3: not observed');
    expect(el.getAttribute('data-state')).toBe('not-observed');
    expect(screen.queryByText(/measuring/i)).toBeNull();
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('renders "not observed" when the report is present but carries neither the flag nor a count — absence is not a negative verdict', () => {
    // The whole point: an absent h3_connection_observed must not read as "no HTTP/3".
    render(<QuicReadout report={report({})} />);
    const el = screen.getByText('HTTP/3: not observed');
    expect(el.getAttribute('data-state')).toBe('not-observed');
    expect(screen.queryByText(/measuring/i)).toBeNull();
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('CRITICAL a MEASURED count of 0 without the flag is "none yet (0 connections)" — a measurement, not "not observed"', () => {
    render(<QuicReadout report={report({ h3_connection_count: 0 })} />);
    const el = screen.getByText('HTTP/3: none yet (0 connections)');
    expect(el.getAttribute('data-state')).toBe('none-yet');
    expect(screen.queryByText(/not observed/)).toBeNull();
    expect(screen.queryByText(/measuring/i)).toBeNull();
    // Still NOT the green verdict: zero connections is not "HTTP/3 carried".
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('renders the green live verdict once an HTTP/3 connection was observed', () => {
    render(<QuicReadout report={report({ h3_connection_observed: true })} />);
    const el = screen.getByText(/HTTP\/3 ✓ live/);
    expect(el.getAttribute('data-state')).toBe('observed');
  });

  it('the latched flag wins over a stale zero count (latched = "ever", the count may lag)', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 0 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live/).getAttribute('data-state')).toBe('observed');
  });

  it('surfaces the connection count when more than one h3 connection was observed', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 3 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live · 3 connections/)).toBeTruthy();
  });

  it('does not tack on a count for a single connection', () => {
    render(
      <QuicReadout report={report({ h3_connection_observed: true, h3_connection_count: 1 })} />,
    );
    expect(screen.getByText(/HTTP\/3 ✓ live$/)).toBeTruthy();
  });
});
