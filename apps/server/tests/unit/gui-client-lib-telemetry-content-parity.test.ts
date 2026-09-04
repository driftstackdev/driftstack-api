// W469.C — drift guard for apps/gui-client/src/lib/telemetry.ts.
// V-242 / D-2026-05-06-02 Sentry crash-only telemetry. Drift here
// either breaks the scrubEvent PII guard (a credential field
// slips through to Sentry — privacy contract violation, customer
// trust hit) or flips the platform-default polarity (cloud
// defaults OFF or self-hosted defaults ON — both betray the
// posture pitched in /trust pages and self-hosted contracts).
//
//   • V-242 / D-2026-05-06-02 framing pinned: 'telemetry: Sentry
//     crash-only, opt-in, gated to cloud customers.'
//   • Posture 3-bullet framing: cloud defaults ON 'Helps Driftstack
//     diagnose crashes affecting paying customers.'; self-hosted
//     defaults OFF 'The whole point of self-hosted is keeping
//     data on premise; telemetry would defeat that pitch unless
//     explicitly chosen.'; privacy contract crash-only with
//     scrubbed-field framing.
//   • Cross-platform framing: '@sentry/browser runs identically
//     on Tauri's WebView across Windows / macOS / Linux. No
//     native-side Sentry yet (the Rust shell is thin; most
//     customer-facing crashes originate in the React layer).'
//   • DSN-via-import.meta.env framing pinned + APP_VERSION
//     default '0.0.1'.
//   • TelemetryConfig 2-field (baseUrl + optIn boolean|null);
//     telemetryEnabled: SENTRY_DSN empty → false short-circuit
//     + optIn===true → true + optIn===false → false + null →
//     isCloud platform default.
//   • isCloudBaseUrl: hostname === 'driftstack.io' OR endsWith
//     '.driftstack.dev'; try/catch → false on malformed URL.
//   • initTelemetry: opt-out close+reset; opt-in idempotent;
//     Sentry.init with release `driftstack-gui@${APP_VERSION}` +
//     tracesSampleRate 0 + sendDefaultPii false + integration-
//     filter (keepSentryIntegration / DROPPED_SENTRY_INTEGRATIONS)
//     excluding BrowserTracing/Replay/BrowserProfiling/Breadcrumbs
//     (Breadcrumbs drop = the crash-only privacy contract — no
//     incidental console/DOM/fetch URL capture).
//   • SENSITIVE_KEY_PATTERNS 6 regexes (api_key + password +
//     secret + token + bearer + authorization); SENSITIVE_QUERY_PARAMS
//     incl. ds_token (the API key in the notification stream URL).
//   • scrubEvent: Authorization-style header scrub + request.url +
//     breadcrumb query-param scrub (scrubUrl) + extra/contexts spread
//     scrub via scrubObject.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/telemetry.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W469.C apps/gui-client/src/lib/telemetry.ts content parity', () => {
  const body = read(LIB);

  it("V-242 / D-2026-05-06-02 framing pinned: 'V-242 / D-2026-05-06-02 — telemetry: Sentry crash-only, opt-in, gated to cloud customers.'", () => {
    expect(body).toMatch(
      /\/\/ V-242 \/ D-2026-05-06-02 — telemetry: Sentry crash-only, opt-in,\s*\/\/ gated to cloud customers\./,
    );
  });

  it("Posture 3-bullet framing pinned: '**Cloud customers** (baseUrl ends in driftstack.io) — telemetry defaults ON; can opt out via Settings toggle. Helps Driftstack diagnose crashes affecting paying customers.' + '**Self-hosted customers** — telemetry defaults OFF; can opt IN explicitly. The whole point of self-hosted is keeping data on premise; telemetry would defeat that pitch unless explicitly chosen.' + '**Privacy contract** — crash-only. Errors + stack traces + anonymous version metadata (app version, OS, platform). NEVER captures: API keys, profile data, customer email/name, request bodies, or anything else PII-shaped. Sentry's `beforeSend` hook scrubs known-sensitive fields as a defense-in-depth.'", () => {
    expect(body).toMatch(
      /\/\/\s+\* \*\*Cloud customers\*\* \(baseUrl ends in driftstack\.io\) — telemetry\s*\/\/\s+defaults ON; can opt out via Settings toggle\. Helps Driftstack\s*\/\/\s+diagnose crashes affecting paying customers\./,
    );
    expect(body).toMatch(
      /\/\/\s+\* \*\*Self-hosted customers\*\* — telemetry defaults OFF; can opt IN\s*\/\/\s+explicitly\. The whole point of self-hosted is keeping data on\s*\/\/\s+premise; telemetry would defeat that pitch unless explicitly\s*\/\/\s+chosen\./,
    );
    expect(body).toMatch(
      /\/\/\s+\* \*\*Privacy contract\*\* — crash-only\. Errors \+ stack traces \+\s*\/\/\s+anonymous version metadata \(app version, OS, platform\)\. NEVER\s*\/\/\s+captures: API keys, profile data, customer email\/name, request\s*\/\/\s+bodies, or anything else PII-shaped\. Sentry's `beforeSend` hook\s*\/\/\s+scrubs known-sensitive fields as a defense-in-depth\./,
    );
  });

  it("Cross-platform framing pinned: '@sentry/browser runs identically on Tauri's WebView across Windows / macOS / Linux. No native-side Sentry yet (the Rust shell is thin; most customer-facing crashes originate in the React layer).'", () => {
    expect(body).toMatch(
      /\/\/ Cross-platform: `@sentry\/browser` runs identically on Tauri's\s*\/\/ WebView across Windows \/ macOS \/ Linux\. No native-side Sentry yet\s*\/\/ \(the Rust shell is thin; most customer-facing crashes originate in\s*\/\/ the React layer\)\./,
    );
  });

  it("DSN-via-import.meta.env framing pinned: 'Sentry DSN for the Driftstack cloud GUI client. Filled in at build time via VITE_SENTRY_DSN env var. Empty string = no DSN configured (telemetry effectively disabled regardless of toggle state).' + 'The DSN is a public identifier; embedding it in the bundle is standard Sentry practice. The DSN identifies WHERE crashes go (Driftstack's Sentry project), not WHO is sending them — Sentry's server-side enforcement on accepted events handles abuse.'", () => {
    expect(body).toMatch(
      /\*\s*Sentry DSN for the Driftstack cloud GUI client\. Filled in at build\s*\*\s*time via VITE_SENTRY_DSN env var\. Empty string = no DSN configured\s*\*\s*\(telemetry effectively disabled regardless of toggle state\)\./,
    );
    expect(body).toMatch(
      /\*\s*The DSN is a public identifier; embedding it in the bundle is\s*\*\s*standard Sentry practice\. The DSN identifies WHERE crashes go\s*\*\s*\(Driftstack's Sentry project\), not WHO is sending them — Sentry's\s*\*\s*server-side enforcement on accepted events handles abuse\./,
    );
    expect(body).toMatch(
      /const SENTRY_DSN: string = \(import\.meta\.env\.VITE_SENTRY_DSN as string \| undefined\) \?\? '';/,
    );
    expect(body).toMatch(
      /const APP_VERSION: string = \(import\.meta\.env\.VITE_APP_VERSION as string \| undefined\) \?\? '0\.0\.1';/,
    );
  });

  it("TelemetryConfig 2-field (baseUrl + optIn boolean|null 'use platform default'); telemetryEnabled: SENTRY_DSN === '' → false short-circuit 'no DSN → never fires' + optIn===true → true + optIn===false → false + null fallthrough → isCloud", () => {
    expect(body).toMatch(
      /export interface TelemetryConfig \{\s*\/\*\* Customer's configured base URL \(cloud detection\)\. \*\/\s*baseUrl: string;\s*\/\*\* Customer's explicit opt-in\/out \(null = "use platform default"\)\. \*\/\s*optIn: boolean \| null;\s*\}/,
    );
    expect(body).toMatch(
      /export function telemetryEnabled\(cfg: TelemetryConfig\): boolean \{\s*if \(SENTRY_DSN === ''\) return false; \/\/ no DSN → never fires\s*const isCloud = isCloudBaseUrl\(cfg\.baseUrl\);\s*if \(cfg\.optIn === true\) return true;\s*if \(cfg\.optIn === false\) return false;\s*\/\/ null = use platform default: ON for cloud, OFF for self-hosted\.\s*return isCloud;\s*\}/,
    );
  });

  it("isCloudBaseUrl: hostname === 'driftstack.io' OR endsWith('.driftstack.dev'); try/catch → false on malformed URL + framing 'Mirrors App.tsx::deploymentLabel logic; not cross-imported to avoid a circular boot path between App + telemetry init.'", () => {
    expect(body).toMatch(
      /\*\s*Extract whether a baseUrl points at the Driftstack cloud surface\.\s*\*\s*Mirrors `App\.tsx::deploymentLabel` logic; not cross-imported to\s*\*\s*avoid a circular boot path between App \+ telemetry init\./,
    );
    expect(body).toMatch(
      /export function isCloudBaseUrl\(baseUrl: string\): boolean \{\s*try \{\s*const host = new URL\(baseUrl\)\.hostname;\s*return host === 'driftstack\.io' \|\| host\.endsWith\('\.driftstack\.dev'\);\s*\} catch \{\s*return false;\s*\}\s*\}/,
    );
  });

  it("initTelemetry: !telemetryEnabled branch closes existing client 'Customer just opted out — close the client to flush + stop.'; idempotent if initialized + telemetry enabled; Sentry.init with release `driftstack-gui@${APP_VERSION}` + tracesSampleRate 0 + sendDefaultPii: false + integration-filter (keepSentryIntegration) dropping BrowserTracing/Replay/BrowserProfilingIntegration/Breadcrumbs", () => {
    expect(body).toMatch(
      /if \(!telemetryEnabled\(cfg\)\) \{\s*if \(initialized\) \{\s*\/\/ Customer just opted out — close the client to flush \+ stop\.\s*void Sentry\.close\(\);\s*initialized = false;\s*\}\s*return;\s*\}\s*if \(initialized\) return; \/\/ already running/,
    );
    expect(body).toMatch(
      /Sentry\.init\(\{\s*dsn: SENTRY_DSN,\s*release: `driftstack-gui@\$\{APP_VERSION\}`,/,
    );
    // Crash-only integration filter via keepSentryIntegration. Breadcrumbs
    // MUST stay in the dropped set — it auto-captures console/DOM/fetch/xhr
    // URLs (incl. the `?ds_token=<apiKey>` stream), which the privacy
    // contract forbids. Re-adding it (or dropping it from the list) is a
    // regression this guard catches.
    expect(body).toMatch(
      /integrations: \(defaults\) => defaults\.filter\(\(i\) => keepSentryIntegration\(i\.name\)\),/,
    );
    expect(body).toMatch(/export const DROPPED_SENTRY_INTEGRATIONS: readonly string\[\] = \[/);
    expect(body).toMatch(/'BrowserTracing',/);
    expect(body).toMatch(/'Replay',/);
    expect(body).toMatch(/'BrowserProfilingIntegration',/);
    expect(body).toMatch(/'Breadcrumbs',/);
    expect(body).toMatch(
      /export function keepSentryIntegration\(name: string\): boolean \{\s*return !DROPPED_SENTRY_INTEGRATIONS\.includes\(name\);\s*\}/,
    );
    expect(body).toMatch(/tracesSampleRate: 0,/);
    expect(body).toMatch(/sendDefaultPii: false,\s*beforeSend: scrubEvent,/);
  });

  it('scrubEvent covers headers and drops request bodies before recursively scrubbing extra/contexts', () => {
    expect(body).toMatch(/k\.toLowerCase\(\) === 'set-cookie' \|\|\s*isSensitiveKey\(k\)/);
    expect(body).toMatch(/const SENSITIVE_KEYS = new Set\(\[/);
    expect(body).toMatch(/function isSensitiveKey\(key: string\): boolean/);
    expect(body).toMatch(/event\.request\.data = '\[scrubbed: request body\]';/);
  });

  it('scrubObject fails closed on depth/cycles and recursively classifies keys', () => {
    expect(body).toMatch(/const MAX_SCRUB_DEPTH = 8;/);
    expect(body).toMatch(/const SCRUBBED_STRUCTURE = '\[scrubbed: structure limit\]';/);
    expect(body).toMatch(
      /if \(depth >= MAX_SCRUB_DEPTH \|\| seen\.has\(value\)\) return SCRUBBED_STRUCTURE;/,
    );
    expect(body).toMatch(/out\[key\] = isSensitiveKey\(key\)/);
    expect(body).toMatch(/new WeakSet<object>\(\)/);
  });

  it("URL + breadcrumb PII hardening: scrubEvent strips credential-shaped query params from request.url (the `?ds_token=<apiKey>` notification-stream vector) + scrubs breadcrumb data; SENSITIVE_QUERY_PARAMS includes 'ds_token'; scrubUrl uses new URL + searchParams.set('[scrubbed]') with try/catch passthrough", () => {
    // request.url query scrub.
    expect(body).toMatch(
      /if \(typeof event\.request\?\.url === 'string'\) \{\s*event\.request\.url = scrubUrl\(event\.request\.url\);\s*\}/,
    );
    // breadcrumb data scrub (field names + nested url query).
    expect(body).toMatch(/if \(event\.breadcrumbs\) \{/);
    expect(body).toMatch(/const data = scrubObject\(b\.data\);/);
    expect(body).toMatch(/if \(typeof data\.url === 'string'\) data\.url = scrubUrl\(data\.url\);/);
    // SENSITIVE_QUERY_PARAMS set — ds_token (the customer API key in the
    // notification stream URL) MUST be present.
    expect(body).toMatch(/const SENSITIVE_QUERY_PARAMS = new Set\(\[/);
    expect(body).toMatch(/'ds_token',/);
    expect(body).toMatch(/'id_token',/);
    expect(body).toMatch(/'client_secret',/);
    expect(body).toMatch(/'signature',/);
    expect(body).toMatch(/'code',/);
    // scrubUrl: base URL supports relative inputs; matching params are replaced.
    expect(body).toMatch(/function scrubUrl\(url: string\): string \{/);
    expect(body).toMatch(/new URL\(url, 'https:\/\/scrub\.invalid'\)/);
    expect(body).toMatch(/u\.searchParams\.set\(key, '\[scrubbed\]'\);/);
    expect(body).toMatch(/\(bearer\\s\+\)\[A-Za-z0-9\._~\+\/-\]\+=\*/);
    expect(body).toMatch(/\(basic\\s\+\)\[A-Za-z0-9\+\/\]\{8,\}=\{0,2\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
