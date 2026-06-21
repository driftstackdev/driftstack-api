// Address-bar input handling shared by the simulator window + the in-dashboard
// live session viewer, so both bars behave identically — "just like our web
// browser" (founder 2026-06-21): a URL navigates, anything else is a web search.

/** Normalize an address-bar entry into an http(s) URL, or null if it can't be
 *  one. Prepends `https://` when no scheme is present (typing "example.com"
 *  navigates to https://example.com). Only http/https pass; anything else
 *  (file:/javascript:/data:/about:) returns null so the GUI never even emits it
 *  — the harness re-validates with the same allowlist + SSRF rejection as a
 *  defense in depth (A3 W2668). */
export function normalizeNavigateUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/** Resolve an address-bar entry the way a real browser's omnibox does: a thing
 *  that looks like a URL navigates; anything else becomes a web search. So
 *  "example.com" → https://example.com/, but "best coffee near me" → a Google
 *  search (the founder asked for the bar to behave "just like our web browser").
 *
 *  URL heuristic (no scheme): single token (no whitespace) that is a dotted host
 *  ("shop.example.com/x"), localhost, or a bare IPv4 — matching omnibox rules.
 *  An EXPLICIT scheme is never search-routed: http/https pass through
 *  normalizeNavigateUrl; a dangerous scheme that carries // (javascript://,
 *  data://, file://, about://) returns null and is dropped (we never search a
 *  scheme payload). A bare-colon pseudo-scheme without // (e.g. "javascript:x")
 *  is just searched as literal text, so the box only ever receives an https URL,
 *  never an executable scheme. Returns null only for empty input or a rejected
 *  explicit scheme. */
export function resolveAddressBarInput(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
  if (hasScheme) {
    // Explicit scheme: only http(s) is allowed; never turn a scheme into a search.
    return normalizeNavigateUrl(t);
  }
  const looksLikeHost =
    !/\s/.test(t) &&
    // Dotted host: the last label is any run of ≥2 non-delimiter chars (Unicode-aware
    // via /u so non-ASCII ccTLDs like .рф/.テスト navigate, not search), with an
    // optional trailing dot (a valid absolute-DNS FQDN "example.com."). normalize
    // punycodes the Unicode labels.
    (/^[^\s/?#]+\.[^\s/?#.]{2,}\.?([/:?#]|$)/u.test(t) ||
      /^localhost([/:?#]|$)/i.test(t) || // localhost[:port][/path]
      /^\d{1,3}(\.\d{1,3}){3}([/:?#]|$)/.test(t) || // bare IPv4
      /^\[[0-9a-f:]+\](:\d+)?([/?#]|$)/i.test(t)); // bracketed IPv6 literal [::1]:8080
  if (looksLikeHost) {
    const url = normalizeNavigateUrl(t);
    if (url !== null) return url;
  }
  // Everything else is a search query — same default engine as iOS Safari.
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}
