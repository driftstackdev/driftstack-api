// validateOpenVpnConfig (2026-06-17) — a client-side .ovpn well-formedness check
// for the (forthcoming) add-proxy OpenVPN editor, so the form gives INSTANT
// feedback (and can show the resolved endpoint) before the customer submits and
// the server's egress.ts refines reject it. The OVPN/WG storage design
// (docs/internal/2026-06-17-account-proxies-vpn-storage-design.md §4/§5) keeps
// the .ovpn a verbatim blob; this util does NOT introspect beyond a shape check
// + extracting the `remote` endpoint.
//
// Mirrors the server-side checks in packages/api-types egress.ts
// (OpenVpnProxyConfigSchema): a real client .ovpn declares `client` and at least
// one `remote <host> [port]`, and the blob is ≤256 KB. The NET-NEW bit over the
// server schema (which only checks directive PRESENCE) is EXTRACTING the remote
// host + port — useful for the editor to display the endpoint and for the
// design's SSRF-on-customer-host note (the remote host lives inside the blob).
//
// Pure + total (no throws) — safe to call on every paste/change.

const MAX_OVPN_BYTES = 256 * 1024;
const OVPN_DEFAULT_PORT = 1194; // OpenVPN's default when `remote` omits the port

export type OpenVpnValidation =
  | { ok: true; remoteHost: string; remotePort: number }
  | { ok: false; reason: string };

/**
 * Strip a trailing `# ...` / `; ...` inline comment and trim. OpenVPN treats
 * both as comment markers; they may follow a directive on the same line.
 */
function stripComment(line: string): string {
  const hashAt = line.search(/[#;]/);
  return (hashAt === -1 ? line : line.slice(0, hashAt)).trim();
}

export function validateOpenVpnConfig(input: string): OpenVpnValidation {
  if (input.trim() === '') return { ok: false, reason: 'Paste your .ovpn configuration.' };
  // Byte length (UTF-8), matching the server's 256 KB cap.
  if (new TextEncoder().encode(input).length > MAX_OVPN_BYTES) {
    return { ok: false, reason: 'Config is too large (max 256 KB).' };
  }

  let hasClient = false;
  let remoteHost: string | null = null;
  let remotePortFromRemote: number | null = null;
  let portDirective: number | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === '') continue;
    const tokens = line.split(/\s+/);
    const directive = (tokens[0] ?? '').toLowerCase();

    if (directive === 'client') {
      hasClient = true;
    } else if (directive === 'remote' && remoteHost === null && tokens[1] !== undefined) {
      // `remote <host> [port] [proto]` — take the FIRST remote (others are
      // failover). Port is optional on the line (may come from `port` or default).
      remoteHost = tokens[1];
      if (tokens[2] !== undefined) {
        const p = Number.parseInt(tokens[2], 10);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) remotePortFromRemote = p;
      }
    } else if (directive === 'port' && tokens[1] !== undefined && portDirective === null) {
      const p = Number.parseInt(tokens[1], 10);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) portDirective = p;
    }
  }

  if (!hasClient) {
    return { ok: false, reason: 'Missing a `client` directive (this is not a client .ovpn).' };
  }
  if (remoteHost === null) {
    return { ok: false, reason: 'Missing a `remote <host> <port>` directive.' };
  }
  const remotePort = remotePortFromRemote ?? portDirective ?? OVPN_DEFAULT_PORT;
  return { ok: true, remoteHost, remotePort };
}
