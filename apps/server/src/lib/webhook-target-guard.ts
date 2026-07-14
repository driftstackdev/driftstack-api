// SSRF guard for customer-supplied webhook endpoint URLs (create/update).
//
// The delivery worker runs on our infrastructure and POSTs to whatever URL
// the customer registers, so a URL pointed at a private/loopback/link-local
// address (or `localhost`) lets a customer probe our internal network via
// the (blind) delivery log. The create-time schema already enforces
// `https://`; this is the second layer — reject literal internal-IP targets.
//
// Layer scope: this blocks LITERAL private/reserved IPs + localhost + the
// non-standard numeric IP encodings that slip past `isIP` (decimal / hex /
// octal / inet_aton short-form, e.g. `2130706433`, `0x7f000001`, `127.1`) at
// create/update time. It does NOT defend DNS rebinding (a HOSTNAME that
// resolves public at create and private at delivery) — that needs
// connection-time resolution + IP pinning in the delivery path, tracked in
// docs/internal/2026-05-31-webhook-ssrf-outbound-target.md.
//
// Implemented over Node's `net.BlockList` (vetted range math) rather than
// hand-rolled bit twiddling. Two non-obvious traps (both pinned in tests):
//   - `new URL('https://[::1]/').hostname` keeps the brackets → strip them
//     before `isIP`/`check`, else IPv6 literals read as DNS names.
//   - DON'T add `::ffff:0.0.0.0/96` to the BlockList — it matches EVERY IPv4
//     (Node checks v4 against v4-mapped ranges), blocking all IPv4. Instead
//     reject any `::ffff:`-mapped host outright (no legit webhook uses it).

import { BlockList, isIP } from 'node:net';

const BLOCK = new BlockList();
// IPv4 — internal-reachable / non-public-unicast ranges.
BLOCK.addSubnet('0.0.0.0', 8, 'ipv4'); // "this host"
BLOCK.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918 private
BLOCK.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT (RFC6598)
BLOCK.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
BLOCK.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local / cloud metadata
BLOCK.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918 private
BLOCK.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
BLOCK.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1 documentation
BLOCK.addSubnet('192.88.99.0', 24, 'ipv4'); // deprecated 6to4 relay anycast
BLOCK.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918 private
BLOCK.addSubnet('198.18.0.0', 15, 'ipv4'); // network benchmark / internal labs
BLOCK.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2 documentation
BLOCK.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3 documentation
BLOCK.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
BLOCK.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved
// IPv6 — loopback / unspecified / ULA / link-local / multicast.
BLOCK.addAddress('::1', 'ipv6'); // loopback
BLOCK.addAddress('::', 'ipv6'); // unspecified
BLOCK.addSubnet('fc00::', 7, 'ipv6'); // unique local (ULA)
BLOCK.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCK.addSubnet('ff00::', 8, 'ipv6'); // multicast
// IPv4-embedding transitional prefixes — these wrap an IPv4 address that the OS
// can route to (so the embedded IPv4 could be a private/metadata target). No
// legit webhook/proxy target uses them (NAT64 is client-synthesized; 6to4 is
// deprecated per RFC 7526). Distinct ranges — no all-IPv4 BlockList quirk.
BLOCK.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 well-known prefix (RFC6052)
BLOCK.addSubnet('64:ff9b:1::', 48, 'ipv6'); // NAT64 local-use prefix (RFC8215)
BLOCK.addSubnet('2002::', 16, 'ipv6'); // 6to4 (embeds IPv4 in 2nd/3rd hextets)
// Other IANA non-global/reserved ranges. These are valid address syntax but not
// public webhook destinations; several are deliberately usable only inside an
// administrative domain, so accepting their literals recreates the SSRF class.
BLOCK.addSubnet('100::', 64, 'ipv6'); // discard-only (RFC6666)
BLOCK.addSubnet('100:0:0:1::', 64, 'ipv6'); // dummy prefix (RFC9780)
BLOCK.addSubnet('2001::', 32, 'ipv6'); // Teredo tunnel (RFC4380)
BLOCK.addSubnet('2001:2::', 48, 'ipv6'); // benchmarking (RFC5180)
BLOCK.addSubnet('2001:db8::', 32, 'ipv6'); // documentation (RFC3849)
BLOCK.addSubnet('3fff::', 20, 'ipv6'); // documentation (RFC9637)
BLOCK.addSubnet('5f00::', 16, 'ipv6'); // SRv6 SIDs, non-global (RFC9602)

const PRIVATE_TARGET = 'Webhook URL must not target a private, loopback, or reserved address.';
const URL_CREDENTIALS =
  'Webhook URL must not include username or password credentials; use a signed path or query parameter instead.';
// Length cap — every other customer-write string field is `.max()`-bounded, but
// the create/update webhook `url` is only `z.string().url()` (no length bound),
// so a pathologically long URL could be stored (bounded only by bodyLimit). Cap
// at the de-facto web URL limit (2048): URLs beyond it fail to traverse common
// proxies/CDNs anyway, so this rejects nothing that would actually deliver.
const MAX_WEBHOOK_URL_LENGTH = 2048;
const URL_TOO_LONG = `Webhook URL must be at most ${MAX_WEBHOOK_URL_LENGTH.toString()} characters.`;
const NUMERIC_ENCODING =
  'Webhook URL host must be a domain name or a standard dotted-quad / bracketed-IPv6 literal — numeric, hex, or octal IP encodings are not allowed.';

// Non-standard numeric IP encodings the OS resolver / HTTP client still decodes
// to an address: decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`,
// inet_aton short-form `127.1`. These are NOT valid dotted-quad literals
// (`isIP` returns 0 → they read as DNS names), so without this check they slip
// past the BlockList yet resolve to e.g. 127.0.0.1 — a classic SSRF-smuggling
// bypass. Matches a host whose every dot-separated label is a decimal/hex/octal
// number; only applied when `isIP` already said "not a standard literal", so it
// never touches real dotted-quads (handled by the BlockList) or real hostnames
// (which always carry an alphabetic label / TLD).
const NUMERIC_IP_ENCODING = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i;

/**
 * Classify a bare host (hostname or IP literal) against the internal-reachable
 * block list. Returns the unsafe KIND or null. Shared by the webhook SSRF guard
 * AND the SOCKS5 egress backend (EG-API egress proxy host — a customer-supplied
 * socks5.host pointed at a private/loopback/metadata address would let the fork
 * reach our internal network). Each caller phrases its own message from the kind.
 * Normalises the host (lowercase, strip IPv6 brackets + trailing FQDN dot) so
 * `[::1]`, `localhost.`, `127.0.0.1.` etc. can't slip past.
 */
export function classifyUnsafeHost(
  rawHost: string,
): 'localhost' | 'private' | 'numeric-encoding' | null {
  let host = rawHost.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  // CANONICALISE IPv6 literals FIRST. The `::ffff:` mapped-address check below is
  // a string-prefix test, and the BlockList match is form-sensitive — so a
  // NON-canonical literal (e.g. the fully-expanded IPv4-mapped
  // `0:0:0:0:0:ffff:169.254.169.254`) would slip BOTH yet the OS still routes it
  // to the embedded IPv4 (169.254.169.254 = cloud metadata). The webhook caller
  // URL-parses (which normalises), but the RAW-host callers (SOCKS5 egress proxy
  // host / account-proxies) do NOT — so canonicalise here to close that bypass.
  if (isIP(host) === 6) {
    try {
      const canon = new URL(`http://[${host}]/`).hostname;
      host = (
        canon.startsWith('[') && canon.endsWith(']') ? canon.slice(1, -1) : canon
      ).toLowerCase();
    } catch {
      /* keep the already-normalised host if it isn't bracket-parseable */
    }
  }
  // IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.5) — a private-IPv4 smuggling vector.
  if (host.startsWith('::ffff:')) return 'private';
  // IPv4-COMPATIBLE IPv6 (`::a.b.c.d`, RFC 4291 §2.5.5.1) — the deprecated sibling
  // of the ::ffff: mapped form above. Node canonicalises it WITHOUT the `ffff`
  // hextet (`::169.254.169.254` → `::a9fe:a9fe`), so the prefix check above AND the
  // BlockList below both miss it, yet the OS can route to the embedded IPv4 (here
  // cloud metadata). No legit webhook/proxy target uses the ::/96 block (same
  // rationale as ::ffff:/NAT64/6to4), so reject any ::-prefixed address that embeds
  // an IPv4 in its low 32 bits. (`::` bare doesn't match → handled by the BlockList.)
  if (/^::([0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(host)) return 'private';
  const family = isIP(host); // 0 = DNS name, 4, or 6
  // Numeric/hex/octal encodings read as DNS names to isIP but decode to an
  // address downstream — reject outright.
  if (family === 0 && NUMERIC_IP_ENCODING.test(host)) return 'numeric-encoding';
  if (family === 4 && BLOCK.check(host, 'ipv4')) return 'private';
  if (family === 6 && BLOCK.check(host, 'ipv6')) return 'private';
  return null;
}

/** Strip the `:port` from a `host:port` endpoint, handling bracketed IPv6 (`[::1]:51820`),
 *  UNBRACKETED IPv6 (the WG schema's only-accepted IPv6 form), and bare hosts — returns
 *  the host portion for SSRF classification.
 *
 *  ⚠️ The naive last-colon heuristic is an SSRF bypass: an unbracketed IPv6 whose final
 *  hextet is decimal (`fc00::9999`, `fe80::443`) gets its tail mistaken for a port and
 *  chopped to `fc00:` / `fe80:`, which is not a valid IP literal → classifyUnsafeHost
 *  returns null → the guard PASSES and the internal IPv6 is reachable. The WG endpoint
 *  schema accepts unbracketed IPv6 but rejects the bracketed form, so this mishandled
 *  shape is exactly what a customer can submit. We therefore only strip a `:port` when the
 *  host portion is unambiguous (bracketed IPv6, or a head with no further colons / a valid
 *  bare IPv6); an unbracketed string that IS a valid IPv6 literal is returned whole. */
function vpnEndpointHost(endpoint: string): string {
  const e = endpoint.trim();
  // [ipv6]:port → host
  const bracketed = e.match(/^\[(.+)\]:\d+$/);
  if (bracketed) return bracketed[1]!;
  // [ipv6] (bare bracketed, no port)
  if (e.startsWith('[') && e.endsWith(']')) return e.slice(1, -1);
  // An unbracketed string that is itself a valid IPv6 literal has NO port to strip (an
  // unbracketed IPv6 cannot carry a port unambiguously) — return it whole so the real
  // address is classified. THE SSRF-critical case: `fc00::9999` must not become `fc00:`.
  if (isIP(e) === 6) return e;
  const lastColon = e.lastIndexOf(':');
  if (lastColon > 0 && /^\d+$/.test(e.slice(lastColon + 1))) {
    const head = e.slice(0, lastColon);
    // Only strip the trailing `:digits` as a port when the head is an IPv4/hostname (no
    // further colons) OR a valid bare IPv6 — else the colon belonged to an IPv6 literal,
    // so keep the whole string for classification rather than corrupting it.
    if (!head.includes(':') || isIP(head) === 6) return head;
  }
  return e;
}

/** Hosts of every `remote <host> [port]` directive in an OpenVPN config blob. */
export function openvpnRemoteHosts(configBlob: string): string[] {
  const hosts: string[] = [];
  for (const line of configBlob.split(/\r?\n/)) {
    const m = line.trim().match(/^remote\s+(\S+)/i);
    if (m) hosts.push(m[1]!);
  }
  return hosts;
}

/**
 * Hosts of every `http-proxy <host> <port> [...]` / `socks-proxy <host> [<port>]` directive in
 * an OpenVPN config blob. These are a SECOND, distinct egress target from `remote` (the VPN
 * server itself): they tell the OpenVPN client to route the (cleartext, pre-tunnel) connection
 * to `remote` through this secondary proxy host instead of connecting directly. A config with
 * an entirely benign `remote` can still smuggle an internal/metadata target this way (e.g.
 * `http-proxy 169.254.169.254 80`), which `openvpnRemoteHosts` alone never sees — SSRF.
 */
export function openvpnProxyHosts(configBlob: string): string[] {
  const hosts: string[] = [];
  for (const line of configBlob.split(/\r?\n/)) {
    const m = line.trim().match(/^(?:http-proxy|socks-proxy)\s+(\S+)/i);
    if (m) hosts.push(m[1]!);
  }
  return hosts;
}

/**
 * OpenVPN config directives that invoke an external program when script-security
 * is >=2 — the class the P0 root-RCE (A3 118722821) exploited (a customer
 * `config_blob` with `up /path/script` ran as root on the userspace egress host).
 * The box now forces `--script-security 1` (user scripts disabled), but the CP
 * REJECTS a config carrying any of these at ingress so a weaponized blob is never
 * stored or dispatched — defense-in-depth, not sole line of defense. Lower-cased,
 * matched on the directive keyword at line start.
 */
const DANGEROUS_OPENVPN_DIRECTIVES = new Set([
  'up',
  'down',
  'route-up',
  'route-pre-down',
  'ipchange',
  'tls-verify',
  'learn-address',
  'client-connect',
  'client-disconnect',
  'auth-user-pass-verify',
  'up-restart',
]);

/**
 * True when an OpenVPN `config_blob` contains a script-executing directive
 * (up/down/route-up/…) or raises `script-security` to 2/3 (which is what ENABLES
 * those directives to run programs). Comment (`#`/`;`) and blank lines are
 * skipped; matched case-insensitively on the first whitespace-delimited token.
 */
function hasUnsafeOpenvpnDirective(configBlob: string): boolean {
  for (const raw of configBlob.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const tokens = line.split(/\s+/);
    const keyword = (tokens[0] ?? '').toLowerCase();
    if (DANGEROUS_OPENVPN_DIRECTIVES.has(keyword)) return true;
    // `script-security 2`/`3` is the switch that lets the above run programs;
    // 0/1 are safe (1 = only built-ins; the box floors at 1 regardless).
    if (keyword === 'script-security') {
      const level = Number(tokens[1]);
      if (Number.isFinite(level) && level >= 2) return true;
    }
  }
  return false;
}

/**
 * Returns the unsafe reason for the FIRST private/loopback/metadata VPN egress target
 * OR a script-executing OpenVPN directive, or null when all are safe. Guards the REAL
 * connection destinations the cosmetic display `host` field does NOT cover: a WireGuard
 * `endpoint` host + `dns`, and every OpenVPN `remote` / `http-proxy` / `socks-proxy` host
 * (SSRF to 169.254.169.254 / RFC1918); AND (defense-in-depth for the P0 root-RCE) any
 * OpenVPN up/down/route-up/... script directive or `script-security >=2`.
 */
export function classifyUnsafeVpnTargets(opts: {
  endpoint?: string | null;
  dns?: string | null;
  configBlob?: string | null;
}): 'localhost' | 'private' | 'numeric-encoding' | 'unsafe-directive' | null {
  if (opts.endpoint) {
    const r = classifyUnsafeHost(vpnEndpointHost(opts.endpoint));
    if (r !== null) return r;
  }
  if (opts.dns) {
    for (const d of opts.dns.split(/[,\s]+/).filter(Boolean)) {
      const r = classifyUnsafeHost(d);
      if (r !== null) return r;
    }
  }
  if (opts.configBlob) {
    // Script-executing directives first — a weaponized config is refused outright,
    // before we even bother resolving its target hosts.
    if (hasUnsafeOpenvpnDirective(opts.configBlob)) return 'unsafe-directive';
    const configHosts = [
      ...openvpnRemoteHosts(opts.configBlob),
      ...openvpnProxyHosts(opts.configBlob),
    ];
    for (const h of configHosts) {
      const r = classifyUnsafeHost(h);
      if (r !== null) return r;
    }
  }
  return null;
}

/**
 * Returns a rejection reason when `url` is an unsafe webhook target
 * (over-length, non-https, credential-bearing, localhost, a numeric IP
 * encoding, or a literal private/reserved IP), else null. DNS hostnames are
 * allowed here (rebind is the connection-time layer).
 */
export function unsafeWebhookTargetReason(url: string): string | null {
  // Fail fast on length before parsing — a multi-KB string shouldn't be parsed
  // or stored; the create/update `url` field has no schema-level `.max()`.
  if (url.length > MAX_WEBHOOK_URL_LENGTH) {
    return URL_TOO_LONG;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Webhook URL is not a valid URL.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Webhook URL must use https://.';
  }
  // WHATWG fetch refuses URLs containing credentials instead of sending an
  // Authorization header. Accepting one here therefore both stores plaintext
  // endpoint credentials and creates a webhook that can never deliver.
  if (parsed.username !== '' || parsed.password !== '') {
    return URL_CREDENTIALS;
  }
  // Host-level classification (shared with the SOCKS5 egress backend); map the
  // kind back to the webhook-phrased messages this guard's callers/tests expect.
  const kind = classifyUnsafeHost(parsed.hostname);
  if (kind === 'localhost') return 'Webhook URL must not target localhost.';
  if (kind === 'numeric-encoding') return NUMERIC_ENCODING;
  if (kind === 'private') return PRIVATE_TARGET;
  return null;
}
