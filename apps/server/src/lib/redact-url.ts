// V-494 follow-up — redact credential-bearing query params from a URL (or
// a bare query string) before it lands in a log line or a Sentry event.
//
// The SSE/EventSource auth path carries the bearer token in `?ds_token=`
// (the browser EventSource API can't set an Authorization header — see
// middleware/auth.ts::requireAuthEventSource). The OAuth callback carries
// the single-use `?code=`. Without this, those secrets reach:
//   - the Fastify auto request log (`req.url` includes the query string),
//   - Sentry events (`event.request.url` / `query_string`),
// in plaintext. Header/cookie redaction (pino redact + the Sentry key
// denylist) does NOT cover values embedded inside the URL string, so this
// is a separate, value-level sanitizer.
//
// Parsing (not regex) so encoding tricks can't slip a token through. The
// redacted value renders URL-encoded (`%5Bredacted%5D`) — still obviously a
// non-secret; the security goal (no live token in logs) is what matters.

const SENSITIVE_QUERY_KEYS = new Set<string>([
  'ds_token',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'client_secret',
  'secret',
  'password',
  'signature',
  // OAuth authorization code (single-use, short-lived, but still a
  // credential that must not sit in logs).
  'code',
]);

/**
 * Redact sensitive params from a bare query string (no leading `?`).
 * Returns the input unchanged when it carries no sensitive key, so benign
 * URLs aren't needlessly re-encoded.
 */
export function redactQueryString(queryStr: string): string {
  if (typeof queryStr !== 'string' || queryStr.length === 0) return queryStr;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(queryStr);
  } catch {
    return '[redacted]';
  }
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, '[redacted]');
      changed = true;
    }
  }
  return changed ? params.toString() : queryStr;
}

// Credentials embedded in URL userinfo — `scheme://user:pass@host`. Customer-
// supplied URLs (webhook targets, navigate, oauth redirect_uri) can carry these,
// and an error/log line echoing such a URL would otherwise leak them past the
// query-param + bearer redaction (those only cover `?key=` and `Bearer …`).
// Anchored on `scheme://`, the userinfo class `[^/?#\s@]+` stops before the
// host's path/query/fragment, so a query-embedded `@` (e.g. `?email=a@b.com`)
// is NOT matched, and a bare `mailto:user@host` (no `//`) is left alone. The
// WHOLE userinfo is redacted (a bare username isn't secret, but over-redaction
// in a log is harmless).
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi;

/** Redact `user:pass@` (or bare `user@`) userinfo from any `scheme://…@…` URL
 *  in the string. No userinfo → unchanged. */
export function redactUrlUserinfo(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s.replace(URL_USERINFO_RE, '$1[redacted]@');
}

/**
 * Return `url` (a path+query string like Fastify's `req.url`, or a full URL)
 * with the value of any credential-bearing query parameter replaced AND any
 * `scheme://user:pass@` userinfo redacted. No credentials → returned unchanged.
 */
export function redactUrlQueryTokens(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  const u = redactUrlUserinfo(url);
  const qIdx = u.indexOf('?');
  if (qIdx === -1) return u;
  const path = u.slice(0, qIdx);
  const redacted = redactQueryString(u.slice(qIdx + 1));
  return redacted.length > 0 ? `${path}?${redacted}` : path;
}

// Surgical credential redaction for FREE TEXT — exception messages, breadcrumb
// messages, captureMessage — where a token rides inside a string, not a
// structured url/query_string field (which redactUrlQueryTokens handles) and
// not a sensitive-keyed value (which scrubInPlace handles). The url-parsers
// above would MANGLE free text (they split on the first `?` and absorb trailing
// prose into the redacted param), so this is a precise per-match regex pass:
// only the credential token is rewritten, surrounding diagnostics stay intact.
//
// Delimiter class is `[?&#]`: a credential rides after `?` (query start), `&`
// (subsequent param), OR `#` (URL fragment) — OAuth implicit/hybrid flows return
// access_token/id_token in the fragment (`…#access_token=…`), and a full
// landing-URL can surface in an error message / stack the logger + Sentry pass
// through redactText. Without `#`, the FIRST fragment param (`#access_token=…`)
// would leak while only the `&`-joined ones got redacted. (req.url itself never
// carries a fragment — the client strips it — so redactUrlQueryTokens above
// correctly omits `#`; this free-text path is the one that sees whole URLs.)
const FREE_TEXT_TOKEN_RE =
  /([?&#](?:ds_token|access_token|refresh_token|id_token|api_key|apikey|client_secret|token|secret|password|signature|code)=)[^&\s"'`]+/gi;
const FREE_TEXT_BEARER_RE = /(bearer\s+)[A-Za-z0-9._-]+/gi;

export function redactText(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s
    .replace(FREE_TEXT_TOKEN_RE, '$1[redacted]')
    .replace(FREE_TEXT_BEARER_RE, '$1[redacted]')
    .replace(URL_USERINFO_RE, '$1[redacted]@');
}
