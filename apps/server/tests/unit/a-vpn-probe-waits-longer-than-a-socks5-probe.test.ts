// (n) N16 — the fleet probe's WAIT is sized per dispatch, because the two schemes
// are not comparable work.
//
// A SOCKS5 probe is a CONNECT and a few fetches; 15 s is generous. A VPN probe
// brings a whole tunnel up first, and the node's budget for that is
// `bringUp(initTimeoutMs: 40_000, listenTimeoutMs: 10_000)` — 40 s of init plus
// 10 s for the local SOCKS listener. For WireGuard with a dead endpoint that is
// the utun wait (≤12 s) plus the handshake poll (≤15 s) before `handshake_failed`
// is thrown at all, then a teardown, then the reply.
//
// At the old flat 15 s the server ALWAYS gave up first. `settle` then dropped the
// node's late frame (`if (p === undefined) return;`), the registry reported a
// timeout, and the route answered `not_run:'no_node'` — "No fleet Mac was free to
// test this VPN tunnel. Try again in a minute." Every WireGuard row with a down,
// wrong-port or UDP-filtered endpoint blamed the fleet, kept its stale exit, and
// said the same thing on every retry.
//
// GUARD REASONING (mutation → which arm reds):
//   * Revert `request(req, timeoutMs?)` in
//     apps/server/src/services/probe-egress-request-correlator.ts to
//     `request(req, timeoutMs = PROBE_EGRESS_REQUEST_TIMEOUT_MS)` and the first two
//     arms red: the wireguard/openvpn dispatch settles `timeout` at 15 s where
//     both assert it is STILL PENDING at 20 s.
//   * Drop the `probe_budget_ms` capture in `onResultFrame` (or the field from
//     ProbeEgressResultSchema) and the "the node's own budget wins" arm reds — the
//     wait falls back to the 60 s constant and the 90 s dispatch settles early.
//   * ⛔ VACUITY CONTROLS, in the direction the real failure goes: the socks5 arm
//     asserts the 15 s default SURVIVES (a change that simply made every probe
//     wait 60 s would pass every critical arm and red this one), and every
//     "still pending" assertion is paired with a later advance that DOES settle —
//     a promise that never settles for an unrelated reason would otherwise read
//     as a pass.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ProbeEgressRequestCorrelator,
  PROBE_EGRESS_REQUEST_TIMEOUT_MS,
  VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS,
  PROBE_EGRESS_BUDGET_SLACK_MS,
  probeEgressConfigIsVpn,
  type ProbeEgressTransport,
} from '../../src/services/probe-egress-request-correlator.js';
import { serializeProbeEgress } from '../../src/services/harness-control-codec.js';
import type { ProbeEgressFrame } from '../../src/schemas/harness-control-protocol.js';

const TARGET = { host: 'api.driftstack.dev', port: 443 };
const RQ = '11111111-1111-4111-8111-111111111111';

const SOCKS5 = {
  host: '203.0.113.9',
  port: 1080,
  udp_associate: true,
  require_remote_dns: true,
};
const WIREGUARD = {
  type: 'wireguard' as const,
  private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
  peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
  endpoint: 'vpn.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
};
const OPENVPN = { type: 'openvpn' as const, config_blob: 'client\nremote vpn.example.com 1194\n' };

/** Build the REAL wire frame the registry dispatches, through the REAL encoder —
 *  a hand-rolled base64 here would test the fixture, not the production path. */
function frameFor(config: Parameters<typeof serializeProbeEgress>[0]['inlineProxyConfig']) {
  return serializeProbeEgress({ requestId: RQ, inlineProxyConfig: config, target: TARGET });
}

function makeCorrelator(): {
  correlator: ProbeEgressRequestCorrelator;
  sent: ProbeEgressFrame[];
} {
  const sent: ProbeEgressFrame[] = [];
  const transport: ProbeEgressTransport = { send: (r) => sent.push(r) };
  return { correlator: new ProbeEgressRequestCorrelator(transport), sent };
}

/** A complete probeEgressResult; `probe_budget_ms` only when an arm asks for it. */
function resultFrame(requestId: string, budget?: number | null): unknown {
  return {
    type: 'probeEgressResult',
    requestId,
    node_id: 'mac-1',
    ok: false,
    status: 'could_not_run',
    reachable: false,
    auth_ok: false,
    udp_associate: false,
    can_route: false,
    latency_ms: null,
    h2_ok: false,
    quic_ok: false,
    quic_detail: null,
    exit_ip: null,
    ...(budget === undefined ? {} : { probe_budget_ms: budget }),
    error: 'endpoint_unreachable',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('(n) N16 the fleet probe wait is sized per dispatch', () => {
  it('CRITICAL a wireguard dispatch is STILL WAITING at 20 s (the old 15 s cut the node off) and settles at the VPN constant', async () => {
    const { correlator } = makeCorrelator();
    let settled: unknown = 'pending';
    const p = correlator.request(frameFor(WIREGUARD)).then((o) => (settled = o));

    // The node has not even thrown `handshake_failed` yet at this point: the utun
    // wait plus the handshake poll run past 20 s before the throw.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled, 'a 20 s wait must NOT have expired for a VPN probe').toBe('pending');
    expect(correlator.inFlight()).toBe(1);

    // ⛔ The paired half: it DOES settle eventually. Without this, a promise that
    // never resolves for an unrelated reason would read as a passing arm.
    await vi.advanceTimersByTimeAsync(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS - 20_000);
    await p;
    expect(settled).toEqual({ status: 'timeout' });
    expect(correlator.inFlight()).toBe(0);
  });

  it('CRITICAL an openvpn dispatch gets the same longer wait (the 40 s init budget is OpenVPN’s)', async () => {
    const { correlator } = makeCorrelator();
    let settled: unknown = 'pending';
    const p = correlator.request(frameFor(OPENVPN)).then((o) => (settled = o));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe('pending');

    await vi.advanceTimersByTimeAsync(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS - 20_000);
    await p;
    expect(settled).toEqual({ status: 'timeout' });
  });

  it('CRITICAL the node’s late frame is HEARD instead of dropped: a handshake_failed at t=20 s resolves an error outcome, never a timeout', async () => {
    const { correlator, sent } = makeCorrelator();
    const p = correlator.request(frameFor(WIREGUARD));

    await vi.advanceTimersByTimeAsync(20_000);
    correlator.onResultFrame(resultFrame(sent[0]?.requestId ?? RQ));

    // ⛔ This is the customer-visible half of N16. A timeout here becomes the
    // route's `not_run:'no_node'` — "No fleet Mac was free" — about a tunnel the
    // node measured and found down.
    expect(await p).toEqual({ status: 'error', message: 'endpoint_unreachable' });
  });

  it('VACUITY CONTROL a socks5 dispatch keeps the 15 s default (the fix must not make every probe slow)', async () => {
    const { correlator } = makeCorrelator();
    let settled: unknown = 'pending';
    const p = correlator.request(frameFor(SOCKS5)).then((o) => (settled = o));

    await vi.advanceTimersByTimeAsync(PROBE_EGRESS_REQUEST_TIMEOUT_MS - 1);
    expect(settled, 'the socks5 wait must not expire early either').toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toEqual({ status: 'timeout' });
  });

  it('an explicit timeoutMs from the caller still wins over the per-dispatch size', async () => {
    const { correlator } = makeCorrelator();
    let settled: unknown = 'pending';
    const p = correlator.request(frameFor(WIREGUARD), 5_000).then((o) => (settled = o));
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(settled).toEqual({ status: 'timeout' });
  });

  it('CRITICAL the node’s own probe_budget_ms wins over the constant, so a retune on the node moves the server’s wait', async () => {
    const { correlator, sent } = makeCorrelator();
    // First dispatch: nothing learned yet, so the static constant applies.
    const first = correlator.request(frameFor(WIREGUARD));
    expect(correlator.timeoutMsFor(frameFor(WIREGUARD))).toBe(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS);

    // The node answers — a could_not_run frame, which is exactly the ~40 s
    // endpoint_unreachable case the budget matters most for — reporting a RETUNED
    // 90 s budget.
    correlator.onResultFrame(resultFrame(sent[0]?.requestId ?? RQ, 90_000));
    expect(await first).toMatchObject({ status: 'error' });

    // The next dispatch to this node waits the node's budget plus the slack.
    expect(correlator.timeoutMsFor(frameFor(WIREGUARD))).toBe(
      90_000 + PROBE_EGRESS_BUDGET_SLACK_MS,
    );
    let settled: unknown = 'pending';
    const second = correlator.request(frameFor(WIREGUARD)).then((o) => (settled = o));
    await vi.advanceTimersByTimeAsync(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS + 1);
    expect(settled, 'the learned 90 s budget must outlast the 60 s constant').toBe('pending');
    await vi.advanceTimersByTimeAsync(90_000 + PROBE_EGRESS_BUDGET_SLACK_MS);
    await second;
    expect(settled).toEqual({ status: 'timeout' });
  });

  it('a socks5 result’s probe_budget_ms:null means "not reported for this scheme" — it never erases a learned budget, and never lengthens the socks5 wait', async () => {
    const { correlator, sent } = makeCorrelator();
    const first = correlator.request(frameFor(WIREGUARD));
    correlator.onResultFrame(resultFrame(sent[0]?.requestId ?? RQ, 90_000));
    await first;

    const second = correlator.request(frameFor(SOCKS5));
    correlator.onResultFrame(resultFrame(sent[1]?.requestId ?? RQ, null));
    await second;

    expect(correlator.timeoutMsFor(frameFor(WIREGUARD))).toBe(
      90_000 + PROBE_EGRESS_BUDGET_SLACK_MS,
    );
    // ⛔ And the learned VPN budget must never leak onto a socks5 dispatch.
    expect(correlator.timeoutMsFor(frameFor(SOCKS5))).toBe(PROBE_EGRESS_REQUEST_TIMEOUT_MS);
  });

  it('probeEgressConfigIsVpn reads the REAL encoded wire: vpn true, socks5 false, garbage "undecodable" (which takes the LONGER wait)', () => {
    expect(probeEgressConfigIsVpn(frameFor(WIREGUARD).inlineProxyConfig)).toBe(true);
    expect(probeEgressConfigIsVpn(frameFor(OPENVPN).inlineProxyConfig)).toBe(true);
    expect(probeEgressConfigIsVpn(frameFor(SOCKS5).inlineProxyConfig)).toBe(false);
    // ⛔ The fallback direction is the whole point: a config we cannot read must
    // NOT be given the short socks5 wait, because a too-short wait produces a
    // WRONG answer ("no Mac was free") while a too-long one is merely slow.
    expect(probeEgressConfigIsVpn('not base64 json at all!!')).toBe('undecodable');
    const { correlator } = makeCorrelator();
    expect(correlator.timeoutMsFor({ inlineProxyConfig: 'not base64 json at all!!' })).toBe(
      VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS,
    );
  });

  it('the VPN wait actually covers the node’s stated budget (40 s init + 10 s listen), with slack', () => {
    // A pin on the NUMBER's rationale, not just the number: if the node's budget
    // is ever raised past this, this arm is where it is noticed.
    expect(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000 + 10_000);
    expect(VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS).toBeGreaterThan(PROBE_EGRESS_REQUEST_TIMEOUT_MS);
  });
});
