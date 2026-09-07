// TRACK C / BUG 5 — a WebRTC candidate that is the SAME address as the exit IP,
// only spelled differently (IPv6 case/compression, a trailing dot, an embedded
// :port), must NOT be cried as a leak. The old comparison was a raw string
// `!==`, so a coherent exit produced a scary, wrong deanonymization warning.
//
// The guard pins the canonicalization: differently-spelled-but-equal → no leak,
// while a genuinely different address still flags (the vacuity control — without
// it the whole rule could be satisfied by "never report a leak").

import { describe, expect, it } from 'vitest';
import { normalizeIp, webrtcLeakIps } from '../../src/components/ExitIpChip';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';

function report(exit: string | undefined, candidates: string[]): AgentSessionCapabilityReport {
  return {
    manual_input_available: null,
    streaming_state: null,
    egress_state: null,
    ...(exit !== undefined ? { exit_ip: exit } : {}),
    webrtc_candidate_ips: candidates,
  };
}

describe('webrtcLeakIps — canonicalized comparison, not raw string inequality', () => {
  it('does NOT flag an IPv6 candidate that differs only in case/compression', () => {
    // The load-bearing case from the bug report: same address, expanded + upper.
    const r = report('2001:db8::1', ['2001:0DB8:0000:0000:0000:0000:0000:0001']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  it('does NOT flag when the EXIT side is the non-canonical one (both sides normalize)', () => {
    // Pins that the EXIT ip is normalized too, not just the candidate: a mutation
    // that canonicalizes only the candidate leaves this expanded/upper exit unequal
    // to the compact candidate and reds here.
    const r = report('2001:0DB8:0000:0000:0000:0000:0000:0001', ['2001:db8::1']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  it('does NOT flag an IPv4 candidate that carries an embedded :port for the same host', () => {
    const r = report('1.2.3.4', ['1.2.3.4:51234']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  it('does NOT flag a bracketed IPv6 candidate with a port for the same address', () => {
    const r = report('::1', ['[::1]:443']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  it('does NOT flag a candidate that differs only by a trailing dot', () => {
    const r = report('1.2.3.4', ['1.2.3.4.']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  it('does NOT flag an exactly-equal IPv4 candidate', () => {
    const r = report('1.2.3.4', ['1.2.3.4']);
    expect(webrtcLeakIps(r)).toEqual([]);
  });

  // VACUITY CONTROL — a genuinely different address MUST still be reported, so
  // "no leak" above is a real match and not a rule that never fires. If the
  // production comparison were deleted entirely (always []), this arm goes red.
  it('STILL flags a genuinely different candidate IP', () => {
    const r = report('1.2.3.4', ['5.6.7.8']);
    expect(webrtcLeakIps(r)).toEqual(['5.6.7.8']);
  });

  it('reports only the truly-different candidate when mixed with an equal one', () => {
    const r = report('2001:db8::1', ['2001:0DB8::1', '9.9.9.9']);
    expect(webrtcLeakIps(r)).toEqual(['9.9.9.9']);
  });

  it('returns [] when the report has no exit IP (undefined), regardless of candidates', () => {
    expect(webrtcLeakIps(report(undefined, ['1.2.3.4']))).toEqual([]);
  });
});

describe('normalizeIp — pure canonicalizer', () => {
  it('compresses and lowercases an expanded IPv6 literal', () => {
    expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });

  it('strips a bracketed IPv6 port', () => {
    expect(normalizeIp('[2001:db8::1]:8443')).toBe('2001:db8::1');
  });

  it('strips an IPv4 port and a trailing dot', () => {
    expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4.')).toBe('1.2.3.4');
  });

  it('collapses the all-zero address to ::', () => {
    expect(normalizeIp('0:0:0:0:0:0:0:0')).toBe('::');
  });

  it('returns an unparseable value lowercased (still compared, so still flags)', () => {
    expect(normalizeIp('not-an-ip')).toBe('not-an-ip');
    expect(normalizeIp('2001:db8::1::2')).toBe('2001:db8::1::2'); // double `::` is invalid
  });
});
