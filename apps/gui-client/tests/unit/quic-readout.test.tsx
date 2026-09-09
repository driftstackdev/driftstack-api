// Item 11 guard — the cockpit HTTP/3 (QUIC) readout.
//
// The load-bearing property (T-27): h3_connection_observed is LATCHED and
// ABSENT-means-unknown, so absence must render "measuring…", NEVER "no HTTP/3".
// Mutation: rendering the green verdict on an absent field reds the first two arms.
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
  it('renders "measuring…" when there is no report yet', () => {
    render(<QuicReadout report={null} />);
    const el = screen.getByText(/HTTP\/3: measuring/i);
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-state')).toBe('measuring');
  });

  it('renders "measuring…" when the report is present but h3 is NOT observed — absence is not a negative verdict', () => {
    // The whole point: an absent h3_connection_observed must not read as "no HTTP/3".
    render(<QuicReadout report={report({})} />);
    const el = screen.getByText(/HTTP\/3: measuring/i);
    expect(el.getAttribute('data-state')).toBe('measuring');
    expect(screen.queryByText(/HTTP\/3 ✓/)).toBeNull();
  });

  it('renders the green live verdict once an HTTP/3 connection was observed', () => {
    render(<QuicReadout report={report({ h3_connection_observed: true })} />);
    const el = screen.getByText(/HTTP\/3 ✓ live/);
    expect(el.getAttribute('data-state')).toBe('observed');
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
