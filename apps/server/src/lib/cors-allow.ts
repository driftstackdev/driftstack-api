// W586 — single source of truth for the CORS origin allow-list.
//
// The global @fastify/cors registration (lib/app.ts) sets the ACAO header on
// every NORMAL reply via its onSend hook. SSE routes, however, hijack the
// reply and write headers straight to the raw socket (reply.raw.writeHead),
// which BYPASSES that hook — so a streaming 200 response shipped with no
// Access-Control-Allow-Origin and the browser's EventSource blocked it
// (founder-reported on /v1/account/me/notifications, 2026-06-11). The error
// path still carried ACAO because errors go through the normal reply.
//
// This module exports the allow-list matchers (consumed by both the cors
// registration and the SSE routes) plus resolveCorsOrigin(), which the SSE
// routes call to compute the exact origin to reflect into their raw headers.
// Reflecting (not `*`) is required because the API uses credentials:true.

export interface CorsAllowDeps {
  /** When true, every origin is reflected (dev / explicitly-permissive prod). */
  permissiveCors?: boolean;
  /** The canonical dashboard origin — always allowed when set. */
  dashboardOrigin?: string;
  /** Extra explicit allow-list entries (CORS_ALLOWED_ORIGINS). */
  corsAllowedOrigins?: string[];
}

// localhost (any scheme/port) + the Tauri desktop webview origins. Kept here as
// the single definition; lib/app.ts spreads corsOriginMatchers() into the
// @fastify/cors `origin` array so the two can never drift.
const LOCALHOST_RE = /^https?:\/\/localhost(:\d+)?$/;
const TAURI_LOCALHOST_RE = /^tauri:\/\/localhost$/;
const TAURI_HTTPS_RE = /^https?:\/\/tauri\.localhost$/;

/** The non-permissive allow-list (regex + exact-string matchers), in order. */
export function corsOriginMatchers(deps: CorsAllowDeps): Array<string | RegExp> {
  return [
    LOCALHOST_RE,
    TAURI_LOCALHOST_RE,
    TAURI_HTTPS_RE,
    ...(deps.dashboardOrigin !== undefined ? [deps.dashboardOrigin] : []),
    ...(deps.corsAllowedOrigins ?? []),
  ];
}

/**
 * The value to write into Access-Control-Allow-Origin for a request from
 * `origin`, or null when the origin is not allowed (→ omit the header, the
 * browser blocks it — same outcome as the global cors plugin). Reflects the
 * exact origin (never `*`) so it composes with credentials:true.
 */
export function resolveCorsOrigin(origin: string | undefined, deps: CorsAllowDeps): string | null {
  if (origin === undefined || origin.length === 0) return null;
  if (deps.permissiveCors === true) return origin;
  for (const matcher of corsOriginMatchers(deps)) {
    const ok = typeof matcher === 'string' ? matcher === origin : matcher.test(origin);
    if (ok) return origin;
  }
  return null;
}

/**
 * The CORS headers an SSE (or other reply.raw.writeHead) route must include so
 * the browser doesn't block the stream. Returns an empty object when the
 * origin isn't allowed (or absent) — matching the global plugin's behavior of
 * simply omitting ACAO. `vary: origin` keeps caches correct when the reflected
 * value depends on the request origin.
 */
export function sseCorsHeaders(
  origin: string | undefined,
  deps: CorsAllowDeps,
): Record<string, string> {
  const allow = resolveCorsOrigin(origin, deps);
  if (allow === null) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}
