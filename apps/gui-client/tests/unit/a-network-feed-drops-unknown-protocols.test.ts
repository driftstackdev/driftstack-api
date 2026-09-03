// OWNER ITEM T-9 (GUI half) — a devtools-style Network panel showing per-request
// protocol (HTTP/2 vs HTTP/3). The one hard rule the panel rests on (N-2): the
// protocol is a CLOSED set { h1, h2, h3 }; anything else is rendered neutral,
// NEVER a green HTTP/3 badge.
//
// MEASURED mechanism: lib/network-log-feed.cleanMeasuredProtocol is the closed-set
// gate. It returns the value ONLY when it is exactly h1 / h2 / h3, and maps every
// other input to null (the neutral marker). It must NEVER upgrade an unrecognised
// value to h3 — an unknown protocol earning the green badge is the exact failure
// the N-2 rule exists to prevent.
//
// Pure function → node environment (.test.ts, no jsdom).

import { describe, expect, it } from 'vitest';
import { cleanMeasuredProtocol, MEASURED_PROTOCOLS } from '../../src/lib/network-log-feed';

describe('cleanMeasuredProtocol — the protocol closed-set gate', () => {
  // One property per assertion: each member of the closed set is kept verbatim.
  it('keeps h1 unchanged', () => {
    expect(cleanMeasuredProtocol('h1')).toBe('h1');
  });

  it('keeps h2 unchanged', () => {
    expect(cleanMeasuredProtocol('h2')).toBe('h2');
  });

  it('keeps h3 unchanged', () => {
    expect(cleanMeasuredProtocol('h3')).toBe('h3');
  });

  // The core rule: an unknown protocol string maps to the neutral marker (null),
  // and CRUCIALLY not to h3. Mutation (b) — "accept an arbitrary protocol string
  // as h3" — makes this return 'h3' (or the raw value); either fails here.
  it('maps an unknown protocol string to the neutral marker, never h3', () => {
    const verdict = cleanMeasuredProtocol('h9');
    expect(verdict).toBeNull();
    // Explicit second property: whatever it returns, it is NOT h3.
    expect(verdict).not.toBe('h3');
  });

  it('maps a plausible-but-unmeasured value ("spdy") to neutral, never h3', () => {
    expect(cleanMeasuredProtocol('spdy')).toBeNull();
  });

  it('maps a near-miss ("h3-29" draft) to neutral, never h3', () => {
    // A value that a naive prefix/startsWith check would wrongly green.
    expect(cleanMeasuredProtocol('h3-29')).toBeNull();
  });

  // Non-string inputs (an object/number/null the wire might send for `protocol`)
  // are neutral too — no type-confusion path to a green badge.
  it('maps non-string inputs to neutral', () => {
    expect(cleanMeasuredProtocol(3)).toBeNull();
    expect(cleanMeasuredProtocol(null)).toBeNull();
    expect(cleanMeasuredProtocol(undefined)).toBeNull();
    expect(cleanMeasuredProtocol({ protocol: 'h3' })).toBeNull();
  });

  // VACUITY CONTROL — proves the assertions above have teeth. If the validator
  // were mutated to reject EVERYTHING (return null always), the "keeps h1/h2/h3"
  // tests would fail; if it were mutated to ACCEPT everything, the "unknown → null"
  // tests would fail. This arm pins BOTH sides in one place: exactly the three
  // closed-set members validate, and a value outside it does not — so neither a
  // reject-all nor an accept-all mutant can pass the suite vacuously.
  it('vacuity control — exactly the closed set validates, nothing outside it', () => {
    const accepted = ['h1', 'h2', 'h3', 'h0', 'h4', 'http2', 'quic', 'tls', ''].filter(
      (p) => cleanMeasuredProtocol(p) !== null,
    );
    expect(accepted).toEqual(['h1', 'h2', 'h3']);
    // And the closed set the validator advertises is exactly those three.
    expect([...MEASURED_PROTOCOLS]).toEqual(['h1', 'h2', 'h3']);
  });
});
