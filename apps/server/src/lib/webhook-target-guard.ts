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
BLOCK.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918 private
BLOCK.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
BLOCK.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved
// IPv6 — loopback / unspecified / ULA / link-local / multicast.
BLOCK.addAddress('::1', 'ipv6'); // loopback
BLOCK.addAddress('::', 'ipv6'); // unspecified
BLOCK.addSubnet('fc00::', 7, 'ipv6'); // unique local (ULA)
BLOCK.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCK.addSubnet('ff00::', 8, 'ipv6'); // multicast

const PRIVATE_TARGET = 'Webhook URL must not target a private, loopback, or reserved address.';
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
 * Returns a rejection reason when `url` is an unsafe webhook target
 * (over-length, non-https, localhost, a numeric IP encoding, or a literal
 * private/reserved IP), else null. DNS hostnames are allowed here (rebind is
 * the connection-time layer).
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
  // URL keeps `[...]` around IPv6 literals; strip before isIP/BlockList.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Strip a trailing FQDN-root dot so `localhost.` / `127.0.0.1.` (which
  // resolve identically) can't slip past the localhost / literal-IP checks.
  if (host.endsWith('.')) host = host.slice(0, -1);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'Webhook URL must not target localhost.';
  }
  // IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.5, normalized to ::ffff:a00:5) is
  // never a legitimate webhook target and is a private-IPv4 smuggling vector.
  if (host.startsWith('::ffff:')) {
    return PRIVATE_TARGET;
  }

  const family = isIP(host); // 0 = DNS name, 4, or 6
  // Numeric/hex/octal IP encodings (decimal/short-form/0x.../0NNN) read as DNS
  // names to isIP but decode to an address downstream — reject outright.
  if (family === 0 && NUMERIC_IP_ENCODING.test(host)) return NUMERIC_ENCODING;
  if (family === 4 && BLOCK.check(host, 'ipv4')) return PRIVATE_TARGET;
  if (family === 6 && BLOCK.check(host, 'ipv6')) return PRIVATE_TARGET;
  return null;
}
