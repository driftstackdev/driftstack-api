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
//   PrivateKey   = <44-char base64>
//   Address      = 10.0.0.2/32      ← address (required; a missing mask is written in)
//   DNS          = 1.1.1.1          ← optional → dns (IP literals only)
//   [Peer]
//   PublicKey    = <44-char base64> ← peer_public_key
//   PresharedKey = <44-char base64> ← optional → preshared_key
//   Endpoint     = host:port        ← endpoint
//   AllowedIPs   = 0.0.0.0/0        ← allowed_ips (default 0.0.0.0/0)
//
// parseWireGuardConfigDetailed says WHICH field made the paste unusable;
// parseWireGuardConfig is the null-on-failure wrapper the older callers keep.
// Pure + total (no throws) — safe to call on every paste/change. Field names
// match egress.ts WireGuardProxyConfig 1:1 so the result maps straight to the
// API sub-object with no renaming.
//
// WG parity pass (2026-09-10) — a real-world wg0.conf has to save AND launch
// with the same specific feedback the .ovpn path gives, so the parser now
// closes the gaps where the form showed ✓ and the server (or the tunnel) then
// refused: a mask-less Address is written as the /32 or /128 wg-quick implies,
// a DNS search domain is dropped so only resolver IPs reach the server's
// IP-list rule, a PresharedKey is kept instead of silently discarded, and a
// failure names its field instead of one blanket "missing keys or endpoint".

export interface ParsedWireGuard {
  private_key: string;
  peer_public_key: string;
  endpoint: string;
  allowed_ips: string;
  /** [Interface] Address (e.g. 10.7.0.2/32) — the userspace WG ifconfig needs
   *  it; the harness dispatch parses it (A3 W2109). Required for a usable WG. */
  address: string;
  dns?: string;
  /** [Peer] PresharedKey — the optional symmetric key layered onto the
   *  handshake. A peer configured with one refuses a handshake that omits it,
   *  so a config that carries it has to keep it or the tunnel fails at launch.
   *  Parsed here; the API/harness carry it once their schema names the field
   *  (until then the server's object rule drops the unknown key). */
  preshared_key?: string;
}

/** The detailed parse. `ok: false` names the FIELD that made the paste
 *  unusable so the form can point at the line to fix — one null for four
 *  causes (either key, the Endpoint, or a missing Address) had every one of
 *  them rendered as "missing keys or endpoint", which never mentioned Address. */
export type WireGuardParseResult =
  | { ok: true; value: ParsedWireGuard }
  | { ok: false; reason: string };

// Mirror the egress.ts validation so a parsed result is API-valid (or a reason).
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/; // 44-char base64 curve25519 key
// host:port — `host` accepts a hostname/IPv4 (incl. the dots/hyphens/underscores
// they use) OR a bracketed IPv6 literal `[2001:db8::1]:51820` (standard wg-quick
// syntax). splitEndpoint() downstream already survives a bracketed host; this
// gate just has to allow the brackets through.
const WG_ENDPOINT_RE = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.\-:_]+):[0-9]{1,5}$/;
// A dotted-quad IPv4 literal (each octet 0-255).
const IPV4_LITERAL_RE =
  /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
// An IPv6 literal by SHAPE: at least one `:` and only hex / `:` / `.` (the
// IPv4-mapped tail), which is what the server's per-entry dns rule admits. A
// hostname can never contain `:`, so the colon is what separates `fd00::1`
// from a `corp.local` search domain.
const IPV6_LITERAL_RE = /^[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*$/;

/** Strip a trailing `# …` / `; …` inline comment from a value and trim, mirroring
 *  parse-openvpn's stripComment. wg-quick exports commonly carry these (e.g.
 *  `Endpoint = vpn.example.com:51820 # primary`); none of the WG values we read
 *  (base64 keys, host:port, CIDRs, IPs) legitimately contain `#` or `;`, so this
 *  is safe. */
function stripInlineComment(value: string): string {
  const at = value.search(/[#;]/);
  return (at === -1 ? value : value.slice(0, at)).trim();
}

/** Split a comma-separated wg-quick list (`Address = 10.7.0.2/32, fd00::2/128`)
 *  into its trimmed, non-empty entries. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** wg-quick brings up a mask-less `Address` as a single host — /32 for IPv4,
 *  /128 for IPv6 — and wg(8) reads a mask-less AllowedIPs entry the same way,
 *  but the server's CIDR rule requires the mask to be WRITTEN, so
 *  `Address = 10.7.0.2` showed ✓ on the form and then 400ed on save. Write
 *  the mask wg-quick implies; an entry that already carries one is untouched. */
function withHostMask(entry: string): string {
  if (entry.includes('/')) return entry;
  return `${entry}/${entry.includes(':') ? '128' : '32'}`;
}

/** wg-quick's `DNS` mixes resolver IPs with search domains
 *  (`DNS = 10.64.0.1, corp.local`); the server's dns rule takes IP literals
 *  only, so a search domain has to be dropped here rather than 400 the save. */
function isIpLiteral(entry: string): boolean {
  return IPV4_LITERAL_RE.test(entry) || IPV6_LITERAL_RE.test(entry);
}

export function parseWireGuardConfigDetailed(input: string): WireGuardParseResult {
  if (input.trim() === '') return { ok: false, reason: 'Paste your wg0.conf configuration.' };

  // Collect the keys we care about by name. wg0.conf key names are unique
  // enough across [Interface]/[Peer] that section-tracking isn't needed:
  // PrivateKey + Address + DNS live in [Interface], PublicKey + PresharedKey +
  // Endpoint + AllowedIPs in [Peer]. Comments (# or ;) and blank lines are
  // skipped; the FIRST occurrence of each key wins (a conf has one [Interface]
  // + one [Peer] for our use).
  const values = new Map<string, string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = stripInlineComment(line.slice(eq + 1));
    if (key !== '' && value !== '' && !values.has(key)) values.set(key, value);
  }

  const privateKey = values.get('privatekey') ?? '';
  const peerPublicKey = values.get('publickey') ?? '';
  const endpoint = values.get('endpoint') ?? '';
  const allowedIps = splitList(values.get('allowedips') ?? '0.0.0.0/0');
  const address = splitList(values.get('address') ?? '');
  const dns = splitList(values.get('dns') ?? '').filter(isIpLiteral);
  const presharedKey = values.get('presharedkey') ?? '';

  // Required fields must be present + well-formed, else the paste is unusable —
  // and the reason says which one, in the order a wg0.conf lists them.
  if (!WG_KEY_RE.test(privateKey)) {
    return { ok: false, reason: 'PrivateKey is not a 44-char base64 key' };
  }
  if (!WG_KEY_RE.test(peerPublicKey)) {
    return { ok: false, reason: '[Peer] PublicKey is not a 44-char base64 key' };
  }
  if (!WG_ENDPOINT_RE.test(endpoint)) return { ok: false, reason: 'Endpoint must be host:port' };
  // Address (the interface IP/CIDR) is required — the harness userspace WG
  // ifconfig can't bring up the tunnel without it.
  if (address.length === 0) return { ok: false, reason: '[Interface] Address line is required' };

  const result: ParsedWireGuard = {
    private_key: privateKey,
    peer_public_key: peerPublicKey,
    endpoint,
    allowed_ips: allowedIps.map(withHostMask).join(', '),
    address: address.map(withHostMask).join(', '),
  };
  // A DNS line that held only search domains leaves nothing the server's rule
  // would take, so the field is omitted rather than sent empty.
  if (dns.length > 0) result.dns = dns.join(', ');
  // A PresharedKey that is not a key is not a reason to refuse the paste (the
  // tunnel's required fields are all present); it is simply not carried.
  if (WG_KEY_RE.test(presharedKey)) result.preshared_key = presharedKey;
  return { ok: true, value: result };
}

/** The null-on-failure form every existing caller and test uses; the reason is
 *  available from parseWireGuardConfigDetailed. */
export function parseWireGuardConfig(input: string): ParsedWireGuard | null {
  const result = parseWireGuardConfigDetailed(input);
  return result.ok ? result.value : null;
}
