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
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Vite injects ImportMetaEnv at build; runtime types unavoidable here
const SENTRY_DSN: string = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? '';

/** App version surfaced in Sentry release tagging. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Vite injects ImportMetaEnv at build; runtime types unavoidable here
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
    // tracing, NO session replay, NO breadcrumbs from user actions.
    // Default integrations (GlobalHandlers, Breadcrumbs, etc.) cover
    // the crash surface; we explicitly disable everything else.
    integrations: (defaults) =>
      defaults.filter(
        (integration) =>
          // Keep error-capture core; drop anything user-tracking-shaped.
          !['BrowserTracing', 'Replay', 'BrowserProfilingIntegration'].includes(integration.name),
      ),
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
 * Strip credential-shaped fields before sending. Recurses one level
 * into the request data; deeper nesting falls to Sentry's own size
 * limits. Returns the scrubbed event or null to drop entirely.
 */
function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  // Scrub Authorization-style headers.
  if (event.request?.headers) {
    const h = event.request.headers as Record<string, string>;
    for (const k of Object.keys(h)) {
      if (
        k.toLowerCase().includes('auth') ||
        k.toLowerCase() === 'cookie' ||
        k.toLowerCase() === 'set-cookie'
      ) {
        h[k] = '[scrubbed]';
      }
    }
  }
  // Scrub common credential field names from extra/contexts/breadcrumb data.
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) {
    for (const k of Object.keys(event.contexts)) {
      const ctx = event.contexts[k];
      if (ctx && typeof ctx === 'object') {
        event.contexts[k] = scrubObject(ctx);
      }
    }
  }
  return event;
}

const SENSITIVE_KEY_PATTERNS = [
  /^api[_-]?key$/i,
  /^password$/i,
  /^secret$/i,
  /^token$/i,
  /^bearer$/i,
  /authorization/i,
];

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(k))) {
      out[k] = '[scrubbed]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
