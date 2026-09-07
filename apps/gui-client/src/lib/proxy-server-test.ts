// T-27 — the control plane's proxy test, from the FLEET vantage, and how its
// answer lands in the probe cache. ONE implementation for both proxy surfaces.
//
// ⛔ The Proxies grid did all of this inline (ProxiesView.handleTest) and the
// profile card's Test did none of it: it ran the native SOCKS5 probe plus the
// exit-geo probe and stopped, so a card Test could never populate the measured
// QUIC verdict or the fleet relay verdict — the chip stayed `~` no matter how
// many times the customer pressed it (owner #13, drop 1 of 6). Two copies of
// the same twelve-step flow are how the second one came to be missing; the
// flow now lives here and the views only apply the outcome to their state.
//
// The parse of the wire (`testAccountProxy`) and the persistence
// (`saveServerProbeResult`, `saveOsFingerprint`) are unchanged; this module is
// the decision between them, made once.

import {
  testAccountProxy,
  type AccountProxyTestResult,
  type MeasuredQuic,
} from './account-proxies';
import type { OsFingerprint } from './os-fingerprint-verdict';
import { saveOsFingerprint, saveServerProbeResult, type ProbeCacheMap } from './proxy-probe-cache';
import { cleanServerVantage, type ServerVantage } from './proxy-vantage';

export type ServerProbeOutcome =
  | {
      kind: 'ok';
      /** When THIS test ran (local clock) — the stamp for everything except the
       *  QUIC verdict, which carries the server's own time (see below). */
      at: number;
      /** T-1 — `null` is a real fleet answer: reached, no timing. The views clear
       *  the stored number on it rather than leaving a stale one beside a fresh
       *  vantage label. */
      latencyMs: number | null;
      quicMeasured?: MeasuredQuic;
      /** T-27 drop 5 — the server's `quic_measured_at` when it sent one, else `at`. */
      quicMeasuredAt?: number;
      vantage?: ServerVantage;
      quicProbe?: boolean;
      osFingerprint?: OsFingerprint;
    }
  | {
      /** The server says the proxy is NOT usable from where it measured. The
       *  views drop every server-measured value they hold for the row. */
      kind: 'failed';
      at: number;
      reason: string;
      vantage?: ServerVantage;
    }
  | {
      /** No server answer at all (network, auth, malformed) — the views keep
       *  what they have; nothing here is evidence either way. */
      kind: 'unavailable';
    };

/**
 * T-27 drop 5 — the stamp a measured QUIC verdict carries.
 *
 * ⛔ Both surfaces stamped `Date.now()` at the moment the /test reply arrived,
 * while the server's `quic_measured_at` — parsed on the wire since T-6 and read
 * by nothing — says when the live session actually observed HTTP/3. Stamping
 * the reply time made a verdict from a session weeks ago look freshly measured
 * on every Test, and the W-30 expiry then aged a time that never happened. The
 * server's clock wins when it sent a parseable one; the reply time is only the
 * fallback for a server that measured but did not say when.
 */
export function quicVerdictStamp(serverAt: string | null | undefined, now: number): number {
  if (typeof serverAt === 'string') {
    const parsed = Date.parse(serverAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

/** Translate the wire result into the outcome both views apply. Pure. */
export function serverProbeOutcome(
  test: AccountProxyTestResult | null,
  now: number,
): ServerProbeOutcome {
  if (test === null) return { kind: 'unavailable' };
  if (!test.ok) {
    const vantage = cleanServerVantage(test.measured_from, undefined);
    return { kind: 'failed', at: now, reason: test.reason, ...(vantage ? { vantage } : {}) };
  }
  // T-6 — a value outside the closed set is dropped, never rendered green.
  const quic =
    test.quic_measured === 'h3' || test.quic_measured === 'h2-only'
      ? test.quic_measured
      : undefined;
  // T-1 — the vantage is a closed set; the node id survives only beside 'fleet'.
  const vantage = cleanServerVantage(test.measured_from, test.node_id);
  return {
    kind: 'ok',
    at: now,
    latencyMs: test.latency_ms,
    ...(quic !== undefined
      ? { quicMeasured: quic, quicMeasuredAt: quicVerdictStamp(test.quic_measured_at, now) }
      : {}),
    ...(vantage !== undefined ? { vantage } : {}),
    ...(typeof test.quic_probe === 'boolean' ? { quicProbe: test.quic_probe } : {}),
    ...(test.os_fingerprint !== undefined ? { osFingerprint: test.os_fingerprint } : {}),
  };
}

/** Ask the control plane to test the proxy from the Mac that runs the profile
 *  (T-1 — `vantage: 'fleet'`). Never throws: a failed request is `unavailable`. */
export async function testProxyOnServer(
  baseUrl: string,
  apiKey: string,
  serverId: string,
  now: () => number = () => Date.now(),
): Promise<ServerProbeOutcome> {
  const test = await testAccountProxy(baseUrl, apiKey, serverId, { vantage: 'fleet' }).catch(
    () => null,
  );
  return serverProbeOutcome(test, now());
}

/**
 * Persist an `ok` outcome onto the proxy's cache entry. `failed` and
 * `unavailable` write nothing — the native probe's entry stands, and the views
 * decide what to drop from their own state. Returns the cache after the last
 * successful write, or null when nothing was written.
 */
export async function persistServerProbe(
  proxyId: string,
  outcome: ServerProbeOutcome,
): Promise<ProbeCacheMap | null> {
  if (outcome.kind !== 'ok') return null;
  let latest: ProbeCacheMap | null = null;
  if (outcome.osFingerprint !== undefined) {
    latest = await saveOsFingerprint(proxyId, outcome.osFingerprint, outcome.at).catch(() => null);
  }
  const next = await saveServerProbeResult(
    proxyId,
    {
      // null CLEARS the persisted number — without this the card would reload
      // the stale one on next launch, after the in-memory drop.
      latencyMs: outcome.latencyMs,
      quicMeasured: outcome.quicMeasured,
      quicMeasuredAt: outcome.quicMeasuredAt,
      measuredFrom: outcome.vantage?.measuredFrom,
      nodeId: outcome.vantage?.nodeId,
      quicProbe: outcome.quicProbe,
    },
    outcome.at,
  ).catch(() => null);
  return next ?? latest;
}
