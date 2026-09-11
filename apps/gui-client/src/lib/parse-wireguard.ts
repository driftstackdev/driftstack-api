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
//   MTU          = 1280             ← optional → mtu (1280-1500)
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
//
// WireGuard audit batch (n), 2026-09-11 — three more places the parser was
// honest by accident or not at all:
//   N5  an .ovpn pasted into the WireGuard form was refused as a bad PrivateKey
//       (a line the file never had); it is now refused as the wrong file type,
//       the way the OpenVPN side already refuses a wg0.conf.
//   N6  every key from every section landed in ONE map, so a second [Peer]'s
//       PresharedKey or Endpoint was stitched onto the first peer and the
//       chimera saved green, then never handshook. Sections are tracked now:
//       [Interface] keys come from [Interface], the [Peer] block is taken as a
//       UNIT, and a conf with more than one [Peer] is refused with copy that
//       says which peer to keep — the form has no surface to say "peer 2 of 3
//       was used", and a silent pick is the failure this replaces.
//   N17 `MTU` was read by nobody, so a provider conf that needs 1280 ran at
//       the default with a green check. It is parsed here (the API/harness
//       carry it once their schema names the field; until then the server's
//       object rule drops the unknown key — see WG_MTU_NOT_CARRIED_NOTICE).

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
  /** [Interface] MTU, when the conf sets one (WG_MTU_MIN..WG_MTU_MAX). Present
   *  only when the line is; a conf without it runs at the tunnel's default.
   *  Parsed so the value is never lost at THIS layer; the API/harness carry it
   *  once their schema names the field. */
  mtu?: number;
}

/** The detailed parse. `ok: false` names the FIELD that made the paste
 *  unusable so the form can point at the line to fix — one null for four
 *  causes (either key, the Endpoint, or a missing Address) had every one of
 *  them rendered as "missing keys or endpoint", which never mentioned Address. */
export type WireGuardParseResult =
  | { ok: true; value: ParsedWireGuard }
  | { ok: false; reason: string };

/** The refusal an OpenVPN .ovpn gets when it is pasted into the WireGuard form
 *  (N5). Mirrors parse-openvpn's "this is not a client .ovpn" for the reverse
 *  mistake: the customer is told to switch Type, not to hunt for a PrivateKey
 *  line their file never had. */
export const OPENVPN_IN_WIREGUARD_FORM_REASON =
  'This looks like an OpenVPN .ovpn — switch Type to OpenVPN.';

/** The refusal a conf with more than one [Peer] gets (N6). Driftstack brings up
 *  ONE peer — the exit — and cannot tell which of several the customer means,
 *  so it says what to keep rather than stitch keys across peers. */
export function multiplePeersReason(peerCount: number): string {
  return `This conf has ${peerCount.toString()} [Peer] blocks; Driftstack uses one — keep only the peer with the Endpoint and AllowedIPs = 0.0.0.0/0.`;
}

/** wg-quick's MTU bounds as Driftstack accepts them: 1280 is the IPv6 minimum
 *  (a smaller tunnel MTU breaks IPv6 inside it), 1500 is Ethernet. */
export const WG_MTU_MIN = 1280;
export const WG_MTU_MAX = 1500;
export const WG_MTU_REASON = `MTU must be a whole number from ${WG_MTU_MIN.toString()} to ${WG_MTU_MAX.toString()}`;

/** Honest paste-time note for a conf that carries an MTU line while the
 *  API/harness do not yet carry the value (N17). The form appends it to the
 *  hint when `mtu` is present so a provider conf that NEEDS 1280 is not shown a
 *  bare ✓ over a tunnel that will run at the default. Remove the call site once
 *  the wire carries `mtu` end to end. */
export const WG_MTU_NOT_CARRIED_NOTICE =
  'The MTU line is not applied yet — the tunnel runs at the default MTU.';

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
// A whole number, as `MTU = 1280` writes it.
const INTEGER_RE = /^[0-9]+$/;

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

/** The lines of a paste, trimmed, with a leading byte-order mark (a Windows
 *  editor's export) removed and CRLF accepted as a line break. */
function confLines(input: string): string[] {
  return input
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim());
}

/** An OpenVPN client file, by its own signature: a bare `client` directive, a
 *  `remote <host>` line, or an inline `<ca>`/`<cert>`/`<key>`/`<tls-auth>`/
 *  `<tls-crypt>` block — none of which a wg0.conf can contain. Comment trailers
 *  are stripped first so a `# remote …` note in a wg0.conf is not a signature. */
const OPENVPN_LINE_RE = /^(?:client|remote\s+\S.*|<(?:ca|cert|key|tls-auth|tls-crypt)>)$/i;
function looksLikeOpenVpn(lines: readonly string[]): boolean {
  return lines.some((line) => OPENVPN_LINE_RE.test(stripInlineComment(line)));
}

/** A `[Section]` header's name, lower-cased, or null for any other line. */
function sectionHeader(line: string): string | null {
  if (!line.startsWith('[')) return null;
  const close = line.indexOf(']');
  return (close === -1 ? line.slice(1) : line.slice(1, close)).trim().toLowerCase();
}

export function parseWireGuardConfigDetailed(input: string): WireGuardParseResult {
  if (input.trim() === '') return { ok: false, reason: 'Paste your wg0.conf configuration.' };

  const lines = confLines(input);

  // Section-tracked scan. wg(8) reads a conf as one [Interface] plus one
  // [Peer] per peer, so PrivateKey/Address/DNS/MTU are taken from [Interface]
  // and each [Peer]'s PublicKey/PresharedKey/Endpoint/AllowedIPs stay together
  // in that peer's own map — never mixed across peers (N6). Comments (# or ;),
  // blank lines and lines before the first header are skipped; within a
  // section the FIRST occurrence of a key wins (a duplicated `Endpoint` keeps
  // the first, as wg-quick does); the script hooks (PostUp/PreUp/PostDown/
  // PreDown) and every other key are read into the map and never consulted.
  const iface = new Map<string, string>();
  const peers: Map<string, string>[] = [];
  let sawHeader = false;
  let current: Map<string, string> | null = null;
  for (const line of lines) {
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = sectionHeader(line);
    if (header !== null) {
      sawHeader = true;
      if (header === 'interface') {
        current = iface;
      } else if (header === 'peer') {
        current = new Map<string, string>();
        peers.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current === null) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = stripInlineComment(line.slice(eq + 1));
    if (key !== '' && value !== '' && !current.has(key)) current.set(key, value);
  }

  // The wrong file type is named BEFORE any field is: an .ovpn has no
  // PrivateKey line, and "PrivateKey is not a key" sends the customer hunting
  // for a line their file never had (N5). A paste that carries a WireGuard
  // section header is judged as WireGuard whatever else it contains.
  if (!sawHeader && looksLikeOpenVpn(lines)) {
    return { ok: false, reason: OPENVPN_IN_WIREGUARD_FORM_REASON };
  }

  const peer = peers[0] ?? new Map<string, string>();
  const privateKey = iface.get('privatekey') ?? '';
  const peerPublicKey = peer.get('publickey') ?? '';
  const endpoint = peer.get('endpoint') ?? '';
  const allowedIps = splitList(peer.get('allowedips') ?? '0.0.0.0/0');
  const address = splitList(iface.get('address') ?? '');
  const dns = splitList(iface.get('dns') ?? '').filter(isIpLiteral);
  const presharedKey = peer.get('presharedkey') ?? '';
  const mtuLine = iface.get('mtu');

  // Required fields must be present + well-formed, else the paste is unusable —
  // and the reason says which one, in the order a wg0.conf lists them.
  if (!WG_KEY_RE.test(privateKey)) {
    return { ok: false, reason: 'PrivateKey is not a 44-char base64 key' };
  }
  // One exit peer. Two or more cannot be told apart here, and the chimera
  // (peer 1's key + peer 2's Endpoint) is exactly what this refusal replaces.
  if (peers.length > 1) return { ok: false, reason: multiplePeersReason(peers.length) };
  if (!WG_KEY_RE.test(peerPublicKey)) {
    return { ok: false, reason: '[Peer] PublicKey is not a 44-char base64 key' };
  }
  if (!WG_ENDPOINT_RE.test(endpoint)) return { ok: false, reason: 'Endpoint must be host:port' };
  // Address (the interface IP/CIDR) is required — the harness userspace WG
  // ifconfig can't bring up the tunnel without it.
  if (address.length === 0) return { ok: false, reason: '[Interface] Address line is required' };
  // An MTU line is either a number in range or a refusal that names it — the
  // one thing this layer must not do is drop it and show ✓ (N17).
  let mtu: number | undefined;
  if (mtuLine !== undefined) {
    const n = INTEGER_RE.test(mtuLine) ? Number.parseInt(mtuLine, 10) : Number.NaN;
    if (!Number.isInteger(n) || n < WG_MTU_MIN || n > WG_MTU_MAX) {
      return { ok: false, reason: WG_MTU_REASON };
    }
    mtu = n;
  }

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
  if (mtu !== undefined) result.mtu = mtu;
  return { ok: true, value: result };
}

/** The null-on-failure form every existing caller and test uses; the reason is
 *  available from parseWireGuardConfigDetailed. */
export function parseWireGuardConfig(input: string): ParsedWireGuard | null {
  const result = parseWireGuardConfigDetailed(input);
  return result.ok ? result.value : null;
}
