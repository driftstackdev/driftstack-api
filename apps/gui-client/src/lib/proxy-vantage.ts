// T-1 — WHERE a proxy measurement was taken, and the words that say so.
//
// Owner item T-1: "Proxy measurements, latency, ping all this should be measured
// from the Mac that will run the profile, not from local." The control plane can
// now hand the test to a fleet Mac (`?vantage=fleet`) and reports where the
// number came from: 'fleet' when a node measured it, 'control_plane' when no
// node was free and Driftstack's own server measured it instead. That fallback
// is honest on the wire and must stay honest on screen — a control-plane number
// is never shown under a fleet label, and the fallback is VISIBLE, never silent.
//
// This module is the ONE place that (a) admits a vantage off the wire or out of
// the cache — a CLOSED set, so a value we cannot name is dropped rather than
// shown under the wrong words — and (b) turns a vantage into the label a
// customer reads beside the number. Both proxy surfaces render from it, so the
// grid and the profile card cannot disagree about where a latency was measured.
//
// Kept out of lib/account-proxies on purpose: that module is hand-mocked by many
// suites, and a new export there is `undefined` in every hand-listed factory.

export type ProxyVantage = 'fleet' | 'control_plane';

/** Keep only a vantage the label can name. Anything else — a newer server, a
 *  corrupt store, a non-string — is undefined (unlabelled), never mislabelled. */
export function cleanProxyVantage(raw: unknown): ProxyVantage | undefined {
  return raw === 'fleet' || raw === 'control_plane' ? raw : undefined;
}

// 2026-09-21 — the server started sending a second, customer-worded field
// (`measured_by: 'phone' | 'driftstack'`) beside the original `measured_from`
// ('fleet' / 'control_plane'), which stays on the wire unchanged for an
// integration that already reads it. `cleanWireProxyVantage` is the ONE place
// that resolves the two into this module's internal `ProxyVantage` — kept
// SEPARATE from `cleanProxyVantage` above (which only ever knew the original
// pair) rather than widening it to accept both vocabularies, so a value read
// from the on-disk cache (always written in the original pair, see
// proxy-probe-cache.ts) can never be misread as the new one by accident.

/** `measured_by`'s two wire values, and the internal `ProxyVantage` each one
 *  names — `phone` (a real phone session measured it) is the `fleet` vantage,
 *  `driftstack` (Driftstack itself measured it) is the `control_plane` one. */
const MEASURED_BY_VANTAGE: Readonly<Record<string, ProxyVantage>> = {
  phone: 'fleet',
  driftstack: 'control_plane',
};

function cleanMeasuredBy(raw: unknown): ProxyVantage | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(MEASURED_BY_VANTAGE, raw)
    ? MEASURED_BY_VANTAGE[raw]
    : undefined;
}

/**
 * Resolve a vantage straight off the wire: `measuredBy` (the new,
 * customer-worded field) wins when present and recognised; `measuredFrom`
 * (the original field, which every server still sends) is read only when it
 * is not. A server built before `measured_by` existed sends only
 * `measured_from` and is read exactly as before; a server that sends both
 * resolves to the identical vantage either way, so nothing downstream needs
 * to know which field supplied it.
 */
export function cleanWireProxyVantage(
  measuredBy: unknown,
  measuredFrom: unknown,
): ProxyVantage | undefined {
  return cleanMeasuredBy(measuredBy) ?? cleanProxyVantage(measuredFrom);
}

/** A server measurement's provenance: where it ran and, for a fleet Mac, which one. */
export interface ServerVantage {
  measuredFrom: ProxyVantage;
  /** The fleet Mac that ran the test — only ever present with 'fleet'. */
  nodeId?: string;
}

/** Build a provenance record from raw wire/cache fields. The node id is kept
 *  only beside a 'fleet' vantage: a node name next to a control-plane number
 *  would name a Mac that did not measure it. */
export function cleanServerVantage(
  measuredFrom: unknown,
  nodeId: unknown,
): ServerVantage | undefined {
  const v = cleanProxyVantage(measuredFrom);
  if (v === undefined) return undefined;
  return v === 'fleet' && typeof nodeId === 'string' && nodeId.length > 0
    ? { measuredFrom: v, nodeId }
    : { measuredFrom: v };
}

/** The label and hover text shown beside a server-measured latency. Plain
 *  words: the customer needs to know WHICH machine took the number, and when
 *  it was not the one that runs their profiles, why. */
export function vantageLabel(v: ServerVantage): { label: string; title: string } {
  if (v.measuredFrom === 'fleet') {
    return {
      // (l) #11 — "the test Mac", never the internal "fleet Mac".
      label: 'from Driftstack',
      title: 'Measured by Driftstack, from the network your profiles run on.',
    };
  }
  return {
    label: 'from the server',
    title: 'Measured by Driftstack’s server, not your computer.',
  };
}
