// parseProxyString (2026-06-15) — paste a proxy in any common format and get
// structured host/port/username/password back, so the add-proxy form can
// auto-fill from a single paste instead of four manual fields.
//
// Supported shapes (scheme optional: socks5://, socks5h://, http(s):// are
// stripped):
//   host:port
//   host:port:user:pass        ← the colon-delimited vendor form (e.g. NodeMaven
//                                 gateways, whose user blob carries -country-…
//                                 -sid-… params and only hyphens, no colons)
//   host:port:user             ← username-only auth
//   user:pass@host:port        ← URL-authority form
//   socks5://user:pass@host:port
//
// Returns null when it can't find a host + a valid 1–65535 port. Pure + total
// (no throws) so the form can call it on every paste/change.

export interface ParsedProxy {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export function parseProxyString(input: string): ParsedProxy | null {
  let s = input.trim();
  if (s === '') return null;
  // Strip a leading scheme — we only do SOCKS5 today, but accept the common
  // prefixes a user might copy so the paste still resolves.
  s = s.replace(/^(socks5h?|https?):\/\//i, '');

  // Authority form: user:pass@host:port. Use the LAST '@' so a '@' inside the
  // password (rare but legal) doesn't split the host off early.
  let creds: string | null = null;
  let hostport = s;
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    creds = s.slice(0, at);
    hostport = s.slice(at + 1);
  }

  let username: string | null = null;
  let password: string | null = null;

  // Bracketed IPv6 authority — [2001:db8::1]:1080. The address's own colons
  // mean only the bracket form is unambiguous; any credentials must arrive via
  // the user:pass@ prefix (the colon-delimited host:port:user:pass form can't
  // represent an IPv6 host). `hp` stays null in this branch so the colon-
  // delimited credential parse below is skipped.
  let host: string;
  let port: number;
  let hp: string[] | null = null;
  const v6 = hostport.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6 !== null) {
    host = (v6[1] ?? '').trim();
    port = Number.parseInt(v6[2] ?? '', 10);
  } else {
    hp = hostport.split(':');
    if (hp.length < 2) return null;
    host = (hp[0] ?? '').trim();
    port = Number.parseInt((hp[1] ?? '').trim(), 10);
  }

  if (creds !== null) {
    // creds = user[:pass] — first colon splits (passwords may contain ':').
    const ci = creds.indexOf(':');
    if (ci === -1) {
      username = creds.length > 0 ? creds : null;
    } else {
      username = creds.slice(0, ci) || null;
      password = creds.slice(ci + 1) || null;
    }
  } else if (hp !== null) {
    // Colon-delimited: host:port[:user[:pass]]. The password is everything
    // after the 3rd colon (rejoined) so a ':' inside it survives.
    const u = hp[2];
    if (u !== undefined && u.length > 0) username = u;
    if (hp.length >= 4) password = hp.slice(3).join(':') || null;
  }

  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, username, password };
}
