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
      label: 'from a fleet Mac',
      title:
        v.nodeId !== undefined
          ? `Measured from the Mac that runs your profiles (${v.nodeId}).`
          : 'Measured from the Mac that runs your profiles.',
    };
  }
  return {
    label: 'from the server',
    title: "No fleet Mac was free — measured from Driftstack's server, not your computer.",
  };
}
