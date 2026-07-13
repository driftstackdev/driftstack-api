// V-242 / D-2026-05-06-02 — telemetry: Sentry crash-only, opt-in,
// gated to cloud customers.
//
// Posture:
//   * **Cloud customers** (baseUrl ends in driftstack.dev) — telemetry
//     defaults ON; can opt out via Settings toggle. Helps Driftstack
//     diagnose crashes affecting paying customers.
//   * **Self-hosted customers** — telemetry defaults OFF; can opt IN
//     explicitly. The whole point of self-hosted is keeping data on
//     premise; telemetry would defeat that pitch unless explicitly
//     chosen.
//   * **Privacy contract** — crash-only. Errors + stack traces +
//     anonymous version metadata (app version, OS, platform). NEVER
//     captures: API keys, profile data, customer email/name, request
//     bodies, or anything else PII-shaped. Sentry's `beforeSend` hook
//     scrubs known-sensitive fields as a defense-in-depth.
//
// Cross-platform: `@sentry/browser` runs identically on Tauri's
// WebView across Windows / macOS / Linux. No native-side Sentry yet
// (the Rust shell is thin; most customer-facing crashes originate in
// the React layer).

import * as Sentry from '@sentry/browser';
import type { ErrorEvent, EventHint } from '@sentry/browser';

/**
 * Sentry DSN for the Driftstack cloud GUI client. Filled in at build
 * time via VITE_SENTRY_DSN env var. Empty string = no DSN configured
 * (telemetry effectively disabled regardless of toggle state).
 *
 * The DSN is a public identifier; embedding it in the bundle is
 * standard Sentry practice. The DSN identifies WHERE crashes go
 * (Driftstack's Sentry project), not WHO is sending them — Sentry's
 * server-side enforcement on accepted events handles abuse.
 */
const SENTRY_DSN: string = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? '';

/** App version surfaced in Sentry release tagging. */
const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.0.1';

export interface TelemetryConfig {
  /** Customer's configured base URL (cloud detection). */
  baseUrl: string;
  /** Customer's explicit opt-in/out (null = "use platform default"). */
  optIn: boolean | null;
}

/**
 * Decide whether telemetry should fire given the customer's config.
 * Pure function — testable without Sentry SDK side effects.
 */
export function telemetryEnabled(cfg: TelemetryConfig): boolean {
  if (SENTRY_DSN === '') return false; // no DSN → never fires
  const isCloud = isCloudBaseUrl(cfg.baseUrl);
  if (cfg.optIn === true) return true;
  if (cfg.optIn === false) return false;
  // null = use platform default: ON for cloud, OFF for self-hosted.
  return isCloud;
}

/**
 * Extract whether a baseUrl points at the Driftstack cloud surface.
 * Mirrors `App.tsx::deploymentLabel` logic; not cross-imported to
 * avoid a circular boot path between App + telemetry init.
 */
export function isCloudBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'driftstack.dev' || host.endsWith('.driftstack.dev');
  } catch {
    return false;
  }
}

let initialized = false;

/**
 * Initialize Sentry once per process. Subsequent calls reconfigure
 * the existing client. Safe to call from boot OR from a settings-
 * changed hook — the SDK supports late init + per-call sample-rate
 * adjustment.
 */
export function initTelemetry(cfg: TelemetryConfig): void {
  if (!telemetryEnabled(cfg)) {
    if (initialized) {
      // Customer just opted out — close the client to flush + stop.
      void Sentry.close();
      initialized = false;
    }
    return;
  }

  if (initialized) return; // already running

  Sentry.init({
    dsn: SENTRY_DSN,
    release: `driftstack-gui@${APP_VERSION}`,
    // Crash-only: errors + unhandled rejections. NO performance
    // tracing, NO session replay, NO profiling, and — per the privacy
    // contract above — NO breadcrumbs. Sentry's default `Breadcrumbs`
    // integration auto-captures console / DOM / fetch / xhr / history,
    // any of which can incidentally carry a URL query token (e.g. the
    // notification stream's `?ds_token=<apiKey>`) or other PII, so we
    // drop it too and keep only the error-capture core (GlobalHandlers,
    // LinkedErrors, Dedupe, …). See DROPPED_SENTRY_INTEGRATIONS.
    integrations: (defaults) => defaults.filter((i) => keepSentryIntegration(i.name)),
    // No transaction sampling — crash-only, no perf data.
    tracesSampleRate: 0,
    // PII scrubber: defense-in-depth even though we never intentionally
    // send PII. Removes Authorization headers, common credential field
    // names, and any field starting with `api_key` / `apiKey` /
    // `password`. Sentry's built-in `sendDefaultPii` is also off.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
  initialized = true;
}

/**
 * Strip credential-shaped fields before sending. Recurses through request
 * data, extras, contexts, and breadcrumbs with a fail-closed depth/cycle cap;
 * Sentry size limits are not a confidentiality boundary.
 *
 * Exported for unit testing — `Sentry.init` wires it as `beforeSend`.
 */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  // Scrub Authorization-style headers.
  if (event.request?.headers) {
    const h = event.request.headers as Record<string, string>;
    for (const k of Object.keys(h)) {
      if (
        k.toLowerCase().includes('auth') ||
        k.toLowerCase() === 'cookie' ||
        k.toLowerCase() === 'set-cookie' ||
        isSensitiveKey(k)
      ) {
        h[k] = '[scrubbed]';
      }
    }
  }
  // Scrub credential-shaped query params from any captured request URL
  // (e.g. the notification stream's `?ds_token=<apiKey>`).
  if (typeof event.request?.url === 'string') {
    event.request.url = scrubUrl(event.request.url);
  }
  // Privacy contract is stronger than field-level filtering: request bodies are
  // never telemetry. Drop the entire payload regardless of scalar/object shape.
  if (event.request?.data !== undefined) {
    event.request.data = '[scrubbed: request body]';
  }
  // Scrub common credential field names from extra/contexts data.
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) {
    for (const k of Object.keys(event.contexts)) {
      const ctx = event.contexts[k];
      if (ctx && typeof ctx === 'object') {
        event.contexts[k] = scrubObject(ctx);
      }
    }
  }
  // Defense-in-depth: the Breadcrumbs integration is dropped (see
  // DROPPED_SENTRY_INTEGRATIONS), but a manually-recorded or
  // future-integration breadcrumb could still attach a URL / data
  // object — scrub credential-shaped query params + field names.
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => {
      const message = typeof b.message === 'string' ? scrubText(b.message) : b.message;
      if (!b.data || typeof b.data !== 'object') return { ...b, message };
      const data = scrubObject(b.data);
      if (typeof data.url === 'string') data.url = scrubUrl(data.url);
      return { ...b, message, data };
    });
  }
  // Scrub credential-bearing URLs / bearer tokens that string-interpolated into
  // a thrown error's message or a captureMessage. `request.url` is scrubbed
  // above, but the SAME token rides in the exception text when a fetch /
  // EventSource error cites the notification stream's `...?ds_token=<apiKey>`
  // URL — without this it would reach Sentry in the error message verbatim.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') ex.value = scrubText(ex.value);
    }
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  return event;
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'newpassword',
  'currentpassword',
  'recoverycode',
  'recoverycodes',
  'apikey',
  'xapikey',
  'xbyokanthropicapikey',
  'xdriftstackguicontrolkey',
  'stripesignature',
  'plaintext',
  'secret',
  'signingsecret',
  'webhooksecret',
  'totpsecret',
  'mfasecret',
  'clientsecret',
  'configblob',
  'privatekey',
  'guicontrolkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'credential',
  'credentials',
  'bearer',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll(/[^a-z0-9]/g, ''));
}

const MAX_SCRUB_DEPTH = 8;
const SCRUBBED_STRUCTURE = '[scrubbed: structure limit]';

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SCRUB_DEPTH || seen.has(value)) return SCRUBBED_STRUCTURE;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => scrubValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[scrubbed]' : scrubValue(nested, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(obj, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/** Credential-shaped query-param names whose VALUES must never leave the host. */
const SENSITIVE_QUERY_PARAMS = new Set([
  'ds_token',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'client_secret',
  'password',
  'secret',
  'signature',
  'code',
]);

/**
 * Strip credential-shaped query-param VALUES from a URL string. Returns
 * the input unchanged if it doesn't parse as a URL (best-effort). Keeps
 * non-sensitive params intact so the URL stays diagnostically useful.
 */
function scrubUrl(url: string): string {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const protocolRelative = url.startsWith('//');
    const u = new URL(url, 'https://scrub.invalid');
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) || isSensitiveKey(key)) {
        u.searchParams.set(key, '[scrubbed]');
        changed = true;
      }
    }
    if (!changed) return url;
    if (absolute) return u.toString();
    const path = `${u.pathname}${u.search}${u.hash}`;
    if (protocolRelative) return `//${u.host}${path}`;
    return url.startsWith('/') ? path : path.replace(/^\//, '');
  } catch {
    return url;
  }
}

/**
 * Redact credential-shaped substrings from FREE TEXT (exception messages,
 * captureMessage, breadcrumb messages) — where a token rides inside a string,
 * not a structured URL/field that scrubUrl/scrubObject would catch. Covers
 * credential query-params embedded in a cited URL (`...?ds_token=<key>`) and
 * `Bearer <token>` fragments. Conservative: only rewrites the matched
 * credential token, leaving the rest of the message diagnostically intact.
 */
function scrubText(s: string): string {
  return s
    .replace(
      /([?&#](?:ds_token|access_token|refresh_token|id_token|api_key|apikey|client_secret|token|password|secret|signature|code)=)[^&\s"'`]+/gi,
      '$1[scrubbed]',
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[scrubbed]')
    .replace(/(basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, '$1[scrubbed]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi, '$1[scrubbed]@');
}

/**
 * Sentry default integrations we explicitly DROP for the crash-only
 * privacy posture: performance tracing, session replay, profiling, and
 * `Breadcrumbs` (which auto-captures console / DOM / fetch / xhr /
 * history — an incidental URL/PII vector the privacy contract above
 * forbids). Everything else (GlobalHandlers, LinkedErrors, Dedupe, …)
 * is the error-capture core we keep.
 */
export const DROPPED_SENTRY_INTEGRATIONS: readonly string[] = [
  'BrowserTracing',
  'Replay',
  'BrowserProfilingIntegration',
  'Breadcrumbs',
];

/** True if a Sentry default integration should be KEPT (crash-only filter). */
export function keepSentryIntegration(name: string): boolean {
  return !DROPPED_SENTRY_INTEGRATIONS.includes(name);
}
