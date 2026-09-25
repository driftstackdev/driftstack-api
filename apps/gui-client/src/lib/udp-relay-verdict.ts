// Proxy-accuracy audit G1 — what this Mac's UDP check found, and the ONE reader of
// it. A UDP ASSOCIATE grant is not a relay: a proxy can answer "yes" and drop
// every datagram, and that read as "✓ UDP" and "~ QUIC likely" on every surface.
// The native check (src-tauri `socks5_probe.rs`) now sends one datagram through
// the relay and reports what came back.
//
// Import-free on purpose: the Proxies tab, the card, the list and the probe
// cache all read it, and a suite that stands in for `lib/proxies` must not be
// able to take this rule away with it.

/**
 *   • 'relays'  — a datagram went through the relay and its answer came back (✓);
 *   • 'silent'  — the proxy granted UDP, but nothing came back. NOT a verdict:
 *                 the check is one query on one port, and an exit that blocks
 *                 only that port reads the same. "— UDP · not verified";
 *   • 'refused' — the proxy refused UDP: the one measured NO (⤵);
 *   • 'not_run' — the check did not run or could not finish ("— UDP").
 */
export type UdpRelayVerdict = 'relays' | 'silent' | 'refused' | 'not_run';

const UDP_RELAY_VERDICTS: ReadonlySet<string> = new Set(['relays', 'silent', 'refused', 'not_run']);

/** The relay verdict a result carries; anything else — absent on a result from
 *  before the check existed, or a value this build does not know — is
 *  'not_run'. ⛔ Never derived from `udp_associate`: a grant is not a relay. */
export function udpRelayOf(result: { udp_relay?: unknown }): UdpRelayVerdict {
  const v = result.udp_relay;
  return typeof v === 'string' && UDP_RELAY_VERDICTS.has(v) ? (v as UdpRelayVerdict) : 'not_run';
}
