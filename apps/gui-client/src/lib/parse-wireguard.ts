// parseWireGuardConfig (2026-06-17) — paste a wg-quick(8) `wg0.conf` and get the
// structured WireGuard fields back, so the (forthcoming) add-proxy WireGuard
// editor can auto-fill from a single paste instead of five manual fields. This
// is the client-side parser the OVPN/WG storage design (docs/internal/
// 2026-06-17-account-proxies-vpn-storage-design.md §5) calls for — keeping the
// wg0.conf → structured-fields mapping entirely GUI-side so the API/harness
// schema stays the structured `WireGuardProxyConfig` (packages/api-types egress.ts),
// no verbatim-blob round-trip.
//
// A wg0.conf is INI-style:
//   [Interface]
//   PrivateKey = <44-char base64>
//   Address    = 10.0.0.2/32        ← ignored (the harness assigns addressing)
//   DNS        = 1.1.1.1            ← optional → dns
//   [Peer]
//   PublicKey  = <44-char base64>   ← peer_public_key
//   Endpoint   = host:port          ← endpoint
//   AllowedIPs = 0.0.0.0/0          ← allowed_ips (default 0.0.0.0/0)
//
// Returns null when a REQUIRED field (private_key / peer_public_key / endpoint)
// is missing or malformed, so the form can tell the user the paste was unusable
// (mirrors parseProxyString). Pure + total (no throws) — safe to call on every
// paste/change. Field names match egress.ts WireGuardProxyConfig 1:1 so the
// result maps straight to the API sub-object with no renaming.

export interface ParsedWireGuard {
  private_key: string;
  peer_public_key: string;
  endpoint: string;
  allowed_ips: string;
  /** [Interface] Address (e.g. 10.7.0.2/32) — the userspace WG ifconfig needs
   *  it; the harness dispatch parses it (A3 W2109). Required for a usable WG. */
  address: string;
  dns?: string;
}

// Mirror the egress.ts validation so a parsed result is API-valid (or null).
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/; // 44-char base64 curve25519 key
const WG_ENDPOINT_RE = /^[A-Za-z0-9.\-:_]+:[0-9]{1,5}$/; // host:port

export function parseWireGuardConfig(input: string): ParsedWireGuard | null {
  if (input.trim() === '') return null;

  // Collect the keys we care about by name. wg0.conf key names are unique
  // enough across [Interface]/[Peer] that section-tracking isn't needed:
  // PrivateKey + DNS live in [Interface], PublicKey + Endpoint + AllowedIPs in
  // [Peer]. Comments (# or ;) and blank lines are skipped; the FIRST occurrence
  // of each key wins (a conf has one [Interface] + one [Peer] for our use).
  const values = new Map<string, string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key !== '' && value !== '' && !values.has(key)) values.set(key, value);
  }

  const privateKey = values.get('privatekey') ?? '';
  const peerPublicKey = values.get('publickey') ?? '';
  const endpoint = values.get('endpoint') ?? '';
  const allowedIps = values.get('allowedips') ?? '0.0.0.0/0';
  const address = values.get('address') ?? '';
  const dns = values.get('dns');

  // Required fields must be present + well-formed, else the paste is unusable.
  if (!WG_KEY_RE.test(privateKey)) return null;
  if (!WG_KEY_RE.test(peerPublicKey)) return null;
  if (!WG_ENDPOINT_RE.test(endpoint)) return null;
  // Address (the interface IP/CIDR) is required — the harness userspace WG
  // ifconfig can't bring up the tunnel without it.
  if (address === '') return null;

  const result: ParsedWireGuard = {
    private_key: privateKey,
    peer_public_key: peerPublicKey,
    endpoint,
    allowed_ips: allowedIps,
    address,
  };
  if (dns !== undefined && dns !== '') result.dns = dns;
  return result;
}
