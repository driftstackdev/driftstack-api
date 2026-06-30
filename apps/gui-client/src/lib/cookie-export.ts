// Cookie EXPORT for the simulator cookies pane (founder #48: "Cookies export not
// yet working"). Turns the live session's cookie jar — the EXACT SessionCookie
// shape getAgentSessionCookies returns (== the server CookieSchema) — into a
// downloadable file in a widely-importable format.
//
// Two formats ship:
//   - 'netscape' → the Netscape/Mozilla `cookies.txt` format (curl/wget/yt-dlp/
//     most extensions import it). TAB-separated, one cookie per line.
//   - 'json'     → a clean JSON array, EditThisCookie / Playwright-storageState
//     compatible (a round-trip: this exact text re-imports 1:1 via parseCookies).
//
// Pure functions, no React/DOM deps (the caller wires the download + the
// chooser). Defensive on missing optional fields: a session cookie → expiry 0,
// an absent path → '/'.

/** The cookie shape Export accepts == the server CookieSchema / the
 *  `SessionCookie` getAgentSessionCookies returns. `expires` is unix
 *  MILLISECONDS (NSHTTPCookie / the route's unit) or null/omitted for a
 *  session cookie. Re-declared here (not imported) so this lib is
 *  self-contained and testable in isolation; the field names/types match
 *  SessionCookie exactly. */
export interface ExportableCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  /** Unix MILLISECONDS, or null/omitted → session cookie. */
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | null;
}

export type CookieExportFormat = 'netscape' | 'json';

/** A serialized jar ready to hand to a file-save dialog. */
export interface CookieExportResult {
  /** Suggested download filename incl. extension. */
  filename: string;
  /** Content MIME type. */
  mime: string;
  /** The file body. */
  text: string;
}

/** Default path when a cookie omits one — the broadest scope, matching how a
 *  browser stores a path-less Set-Cookie. */
const DEFAULT_PATH = '/';

/** Normalize a cookie's expiry to unix SECONDS for the Netscape format (which is
 *  seconds, unlike the route's milliseconds). A session cookie (null/undefined/
 *  non-finite) → 0, the Netscape "session" sentinel. */
function expiryToNetscapeSeconds(expiresMs: number | null | undefined): number {
  if (expiresMs === null || expiresMs === undefined) return 0;
  if (!Number.isFinite(expiresMs)) return 0;
  // The jar carries ms; cookies.txt wants whole seconds.
  return Math.floor(expiresMs / 1000);
}

/** A leading-dot domain (".example.com") matches subdomains → the Netscape
 *  "include subdomains" flag is TRUE. A host-only domain → FALSE. (curl writes
 *  TRUE for any dot-prefixed domain regardless of leading dot; we follow the
 *  conventional "leading dot → subdomain match" so a round-trip is stable.) */
function netscapeSubdomainFlag(domain: string): boolean {
  return domain.startsWith('.');
}

function tsv(...fields: (string | number | boolean)[]): string {
  return fields
    .map((f) => (typeof f === 'boolean' ? (f ? 'TRUE' : 'FALSE') : String(f)))
    .join('\t');
}

/** Serialize a jar to the Netscape/Mozilla `cookies.txt` format. The header
 *  comment is the de-facto marker importers sniff for. Each line:
 *    domain  includeSubdomains  path  secure  expiry  name  value
 *  A `#HttpOnly_` prefix on the domain marks an httpOnly cookie (curl's
 *  convention) so that bit survives the round-trip. */
function toNetscape(cookies: ExportableCookie[]): string {
  const lines: string[] = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This is a generated file. Do not edit.',
    '',
  ];
  for (const c of cookies) {
    const path = c.path !== undefined && c.path.length > 0 ? c.path : DEFAULT_PATH;
    const domainField = c.httpOnly === true ? `#HttpOnly_${c.domain}` : c.domain;
    lines.push(
      tsv(
        domainField,
        netscapeSubdomainFlag(c.domain),
        path,
        c.secure === true,
        expiryToNetscapeSeconds(c.expires),
        c.name,
        c.value,
      ),
    );
  }
  // Trailing newline — POSIX text file; importers tolerate it.
  return `${lines.join('\n')}\n`;
}

/** Serialize a jar to a clean JSON array. Emits a normalized object per cookie
 *  with stable field presence so the output is predictable and re-imports 1:1
 *  (EditThisCookie / Playwright-storageState `cookies` compatible). `expires`
 *  is preserved in MILLISECONDS (the jar's unit); a session cookie → null. */
function toJson(cookies: ExportableCookie[]): string {
  const out = cookies.map((c) => ({
    domain: c.domain,
    name: c.name,
    value: c.value,
    path: c.path !== undefined && c.path.length > 0 ? c.path : DEFAULT_PATH,
    expires: c.expires === undefined ? null : c.expires,
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    sameSite: c.sameSite ?? null,
  }));
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Export `cookies` in `format`, returning the file body + a suggested filename
 *  and MIME type for the save dialog. Pure — never throws on a well-typed jar
 *  (missing optionals are defaulted). */
export function exportCookies(
  cookies: ExportableCookie[],
  format: CookieExportFormat,
): CookieExportResult {
  if (format === 'json') {
    return {
      filename: 'cookies.json',
      mime: 'application/json',
      text: toJson(cookies),
    };
  }
  return {
    filename: 'cookies.txt',
    mime: 'text/plain',
    text: toNetscape(cookies),
  };
}
