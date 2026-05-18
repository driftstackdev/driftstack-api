// LK.6.e — formatRtt() pure-function tests.
//
// useLatencyPing is hooked into the LiveKit DataChannel and is hard
// to exercise without a full Room mock; the pure formatter that
// renders the RTT value is testable in isolation. Pins:
//
//   - null RTT → '— ms' (em-dash placeholder when no fresh sample)
//   - integer RTT → '<n> ms' format (no thousands separator, no
//     decimal — the harness echoes back at ms precision, sub-ms
//     resolution doesn't add anything for a dev-mode display)

import { describe, expect, it } from 'vitest';
import { formatRtt } from '../../src/lib/livekit-latency-ping';

describe('LK.6.e formatRtt', () => {
  it("renders '— ms' when rttMs is null (no fresh sample)", () => {
    expect(formatRtt({ rttMs: null, lastSeenAt: null })).toBe('— ms');
  });

  it("renders '<n> ms' for a fresh sample", () => {
    expect(formatRtt({ rttMs: 42, lastSeenAt: Date.now() })).toBe('42 ms');
  });

  it('uses bare digits — no thousands separator, no decimals', () => {
    expect(formatRtt({ rttMs: 1234, lastSeenAt: Date.now() })).toBe('1234 ms');
  });

  it('handles rttMs=0 (instant echo edge case) without emitting empty string', () => {
    expect(formatRtt({ rttMs: 0, lastSeenAt: Date.now() })).toBe('0 ms');
  });

  it('formatter is pure — same input yields same output across invocations', () => {
    const state = { rttMs: 87, lastSeenAt: 1700000000 };
    const first = formatRtt(state);
    const second = formatRtt(state);
    expect(first).toBe(second);
  });
});
