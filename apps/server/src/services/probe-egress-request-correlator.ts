// Node-scoped egress-probe correlator (T-1). The transport-agnostic CORE of the
// fleet-vantage proxy test: it issues a `probeEgress` over a fleet node's LIVE
// control WSS and awaits the matching `probeEgressResult`, correlated by
// `requestId`. A direct mirror of SetCookiesRequestCorrelator — one-shot
// request/reply keyed by requestId — with one deliberate difference: this op is
// NODE-SCOPED (it measures an exit WITHOUT a live session), so there is no
// `sessionId` and therefore no cross-session spoof guard here. Provenance is
// checked one layer up: the registry asserts the result's `node_id` equals the
// node it dispatched to.
//
// Each FleetControlConnection owns one of these (alongside its dispatch + cookies
// + set-cookies + set-egress + navigate-history + upload + download + trim
// correlators). The registry calls `request(...)` and awaits a uniform
// ProbeEgressOutcome — the call NEVER rejects, so the caller maps each case:
//   ok      → the node measured the exit (reachable or not — an unreachable proxy
//             is a RESULT, carried in `result`, not an error)
//   error   → the node could not run the probe, or the send failed
//   timeout → the node didn't reply in time
// (the route/registry handles "no connected node" before ever calling here).

import { Buffer } from 'node:buffer';
import type { Logger } from '../lib/logger.js';
import {
  ProbeEgressResultSchema,
  type ProbeEgressFrame,
  type ProbeEgressResult,
} from '../schemas/harness-control-protocol.js';

/** The connection's socket send adapts to this (JSON-stringify → ws.send). */
export interface ProbeEgressTransport {
  /** Fire-and-forget send of a probeEgress; the result returns via onResultFrame. */
  send(request: ProbeEgressFrame): void;
}

/** A node-side egress probe dials the proxy, routes to the target, and measures
 *  H2/QUIC — several round-trips through a possibly-slow exit. Generous but
 *  bounded so a silent or wedged node can't hang the awaiting request forever. */
export const PROBE_EGRESS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * (n) N16 — the wait for an openvpn/wireguard probe. 15 s is a SOCKS5 number and
 * it was shorter than the node's own budget for bringing a tunnel up, so the
 * server gave up before the node could answer.
 *
 * ⛔ The node's budget, from the constants its bring-up enforces:
 * `bringUp(initTimeoutMs: 40_000, listenTimeoutMs: 10_000)` — up to 40 s for the
 * tunnel to initialise plus 10 s for the local SOCKS listener to print LISTEN.
 * For WireGuard specifically that is the utun wait (up to 12 s) plus the
 * handshake poll (up to 15 s) before `handshake_failed` is even thrown, then a
 * teardown, and only THEN the reply. 50 s is the floor; the extra 10 s covers
 * teardown, the reply's flight and the two post-tunnel exit fetches.
 *
 * What went wrong at 15 s: the correlator timed out, `settle` then DROPPED the
 * node's late `endpoint_unreachable` frame (`if (p === undefined) return;`), and
 * the route mapped the timeout to `not_run:'no_node'` — "No fleet Mac was free to
 * test this VPN tunnel. Try again in a minute." So every WireGuard row with a
 * down, wrong-port or UDP-filtered endpoint blamed the fleet, kept its stale exit,
 * and said the same thing on every retry.
 */
export const VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS = 60_000;

/** (n) N16 — added to a node-REPORTED `probe_budget_ms` to get the wait. The
 *  budget is what the node spends MEASURING; this covers teardown, the reply's
 *  flight and control-plane scheduling, so a node that answers exactly at its own
 *  budget is still heard. */
export const PROBE_EGRESS_BUDGET_SLACK_MS = 10_000;

/** The `type` discriminator on the inline wire for the two VPN schemes; a socks5
 *  config carries host/port and no `type`. */
const VPN_WIRE_TYPES = new Set(['openvpn', 'wireguard']);

/**
 * (n) N16 — is this dispatch a VPN probe? The frame carries the config as
 * base64(utf8(JSON)) (`encodeInlineProxyConfig`), so the scheme has to be read
 * back out of it: the registry's `probeEgress(args)` takes no timeout and this
 * correlator is the only place that sees every dispatch.
 *
 * ⛔ The fallback direction is deliberate. An undecodable config returns TRUE —
 * the LONGER wait. Waiting 60 s for a socks5 probe that will answer in under one
 * is slow; waiting 15 s for a VPN probe produces a WRONG ANSWER ("no Mac was
 * free" about a tunnel the node was still bringing up), and a wrong answer is the
 * failure this constant exists to remove. The caller logs the decode failure, so
 * it is never silent.
 */
export function probeEgressConfigIsVpn(inlineProxyConfig: string): boolean | 'undecodable' {
  try {
    const json: unknown = JSON.parse(Buffer.from(inlineProxyConfig, 'base64').toString('utf8'));
    if (typeof json !== 'object' || json === null) return 'undecodable';
    const type = (json as { type?: unknown }).type;
    if (typeof type !== 'string') return false; // a socks5 wire carries host/port, no `type`
    return VPN_WIRE_TYPES.has(type);
  } catch {
    return 'undecodable';
  }
}

/** Uniform outcome — never rejects, so the caller maps each case to a response. */
export type ProbeEgressOutcome =
  | { status: 'ok'; result: ProbeEgressResult }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

interface PendingProbeEgress {
  resolve: (outcome: ProbeEgressOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProbeEgressRequestCorrelator {
  private readonly pending = new Map<string, PendingProbeEgress>();

  /** (n) N16 — the last `probe_budget_ms` THIS node reported on a VPN probe, or
   *  null until one arrives. The node derives it from the constants its bring-up
   *  enforces, so a retune on the node moves the server's wait with it instead of
   *  leaving a hardcoded number to drift out from under the fleet. Null (the
   *  value every node sends today — the field has never fired end to end) simply
   *  means the static VPN constant is used. */
  private lastVpnBudgetMs: number | null = null;

  constructor(
    private readonly transport: ProbeEgressTransport,
    private readonly logger: Logger | null = null,
  ) {}

  /**
   * (n) N16 — how long to wait for THIS dispatch, when the caller names no
   * timeout. Sized per dispatch because the schemes are not comparable: a SOCKS5
   * probe is a CONNECT and some fetches, while a VPN probe brings a whole tunnel
   * up first (node budget: 40 s init + 10 s SOCKS listen). Prefers the node's own
   * reported budget over the static constant so the two cannot drift apart.
   */
  timeoutMsFor(req: Pick<ProbeEgressFrame, 'inlineProxyConfig'>): number {
    const isVpn = probeEgressConfigIsVpn(req.inlineProxyConfig);
    if (isVpn === 'undecodable') {
      // Never silent: an inlineProxyConfig that does not decode means
      // serializeProbeEgress produced something this reader cannot parse, which
      // is a real bug — and we deliberately take the SAFE (longer) side of it.
      this.logger?.warn(
        { component: 'probe-egress-request-correlator' },
        'probeEgress inlineProxyConfig did not decode; using the VPN timeout (the safe side)',
      );
      return VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS;
    }
    if (!isVpn) return PROBE_EGRESS_REQUEST_TIMEOUT_MS;
    return this.lastVpnBudgetMs === null
      ? VPN_PROBE_EGRESS_REQUEST_TIMEOUT_MS
      : this.lastVpnBudgetMs + PROBE_EGRESS_BUDGET_SLACK_MS;
  }

  /** Send a probeEgress and resolve when its probeEgressResult arrives or the
   *  timeout elapses. Never rejects. `timeoutMs` omitted → sized per dispatch by
   *  `timeoutMsFor` (N16: a VPN probe outlives the SOCKS5 default several times
   *  over, and a server that gives up first reports "no Mac was free" about a
   *  tunnel the node was still measuring). */
  request(req: ProbeEgressFrame, timeoutMs?: number): Promise<ProbeEgressOutcome> {
    const effectiveTimeoutMs = timeoutMs ?? this.timeoutMsFor(req);
    return new Promise<ProbeEgressOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(req.requestId, { status: 'timeout' });
      }, effectiveTimeoutMs);
      this.pending.set(req.requestId, { resolve, timer });
      try {
        this.transport.send(req);
      } catch (err) {
        // socket.send throws synchronously when the WS isn't OPEN (a request
        // racing a remote close). Settle a uniform failure rather than letting
        // this Promise reject — the caller contract is that request() never
        // rejects — and so the timer + pending entry don't leak (settle clears them).
        this.settle(req.requestId, {
          status: 'error',
          message: `probe-egress request send failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /** Feed an inbound frame expected to be a probeEgressResult. Non-probeEgressResult
   *  frames are ignored; an unknown requestId is a no-op (already settled). */
  onResultFrame(frame: unknown): void {
    const parsed = ProbeEgressResultSchema.safeParse(frame);
    if (!parsed.success) return; // not a probeEgressResult — caller routes other types
    const result = parsed.data;
    // (n) N16 — learn this node's real probe budget from any frame that reports
    // one, INCLUDING a `could_not_run` frame: `endpoint_unreachable` is the ~40 s
    // case, the one that needs the budget most, and A3 fixed the VPN failure path
    // specifically so it carries the field rather than nil. Recorded before the
    // error branch below for exactly that reason. `null` means "not reported for
    // this scheme" (socks5) and must NOT overwrite a budget already learned.
    if (typeof result.probe_budget_ms === 'number') {
      this.lastVpnBudgetMs = result.probe_budget_ms;
    }
    // Foreign-request guard: an unknown/stale requestId is a no-op. Unlike the
    // session correlators there is no sessionId to cross-check — the connection
    // is per-node and the registry re-checks `node_id` provenance on the ok path.
    if (result.error !== null) {
      // The node could not RUN the probe (not a measured "unreachable" — that is a
      // result with error:null). Surface it as an error outcome. Logged once per
      // occurrence: a node that cannot run the probe is the signal an operator
      // wants, and it is far rarer than a routine reachable/unreachable verdict.
      this.logger?.warn(
        { component: 'probe-egress-request-correlator', requestId: result.requestId },
        'probeEgressResult carried an error: the node could not run the probe',
      );
      this.settle(result.requestId, { status: 'error', message: result.error });
      return;
    }
    // A measurement — reachable or not. `ok:false` with `reachable:false` is a
    // valid verdict about a dead proxy, NOT an error, so it resolves ok and the
    // caller reads the fields. Carrying the whole frame lets the registry assert
    // `node_id` provenance and the route return the node-measured shape.
    this.settle(result.requestId, { status: 'ok', result });
  }

  /** Fail every in-flight request (the control connection dropped). */
  failAll(message: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { status: 'error', message });
    }
  }

  /** Number of in-flight requests (test/inspection helper). */
  inFlight(): number {
    return this.pending.size;
  }

  private settle(requestId: string, outcome: ProbeEgressOutcome): void {
    const p = this.pending.get(requestId);
    if (p === undefined) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(outcome);
  }
}
