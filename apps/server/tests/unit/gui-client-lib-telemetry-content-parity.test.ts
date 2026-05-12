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
//   • isCloudBaseUrl: hostname === 'driftstack.dev' OR endsWith
//     '.driftstack.dev'; try/catch → false on malformed URL.
//   • initTelemetry: opt-out close+reset; opt-in idempotent;
//     Sentry.init with release `driftstack-gui@${APP_VERSION}` +
//     tracesSampleRate 0 + sendDefaultPii false + integration-
//     filter excluding BrowserTracing/Replay/BrowserProfiling.
//   • SENSITIVE_KEY_PATTERNS 6 regexes (api_key + password +
//     secret + token + bearer + authorization).
//   • scrubEvent: Authorization-style header scrub + extra/contexts
//     spread scrub via scrubObject.

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
      /\/\/ V-242 \/ D-2026-05-06-02 — telemetry: Sentry crash-only, opt-in,\s*\n?\s*\/\/ gated to cloud customers\./,
    );
  });

  it("Posture 3-bullet framing pinned: '**Cloud customers** (baseUrl ends in driftstack.dev) — telemetry defaults ON; can opt out via Settings toggle. Helps Driftstack diagnose crashes affecting paying customers.' + '**Self-hosted customers** — telemetry defaults OFF; can opt IN explicitly. The whole point of self-hosted is keeping data on premise; telemetry would defeat that pitch unless explicitly chosen.' + '**Privacy contract** — crash-only. Errors + stack traces + anonymous version metadata (app version, OS, platform). NEVER captures: API keys, profile data, customer email/name, request bodies, or anything else PII-shaped. Sentry's `beforeSend` hook scrubs known-sensitive fields as a defense-in-depth.'", () => {
    expect(body).toMatch(
      /\/\/\s+\* \*\*Cloud customers\*\* \(baseUrl ends in driftstack\.dev\) — telemetry\s*\n?\s*\/\/\s+defaults ON; can opt out via Settings toggle\. Helps Driftstack\s*\n?\s*\/\/\s+diagnose crashes affecting paying customers\./,
    );
    expect(body).toMatch(
      /\/\/\s+\* \*\*Self-hosted customers\*\* — telemetry defaults OFF; can opt IN\s*\n?\s*\/\/\s+explicitly\. The whole point of self-hosted is keeping data on\s*\n?\s*\/\/\s+premise; telemetry would defeat that pitch unless explicitly\s*\n?\s*\/\/\s+chosen\./,
    );
    expect(body).toMatch(
      /\/\/\s+\* \*\*Privacy contract\*\* — crash-only\. Errors \+ stack traces \+\s*\n?\s*\/\/\s+anonymous version metadata \(app version, OS, platform\)\. NEVER\s*\n?\s*\/\/\s+captures: API keys, profile data, customer email\/name, request\s*\n?\s*\/\/\s+bodies, or anything else PII-shaped\. Sentry's `beforeSend` hook\s*\n?\s*\/\/\s+scrubs known-sensitive fields as a defense-in-depth\./,
    );
  });

  it("Cross-platform framing pinned: '@sentry/browser runs identically on Tauri's WebView across Windows / macOS / Linux. No native-side Sentry yet (the Rust shell is thin; most customer-facing crashes originate in the React layer).'", () => {
    expect(body).toMatch(
      /\/\/ Cross-platform: `@sentry\/browser` runs identically on Tauri's\s*\n?\s*\/\/ WebView across Windows \/ macOS \/ Linux\. No native-side Sentry yet\s*\n?\s*\/\/ \(the Rust shell is thin; most customer-facing crashes originate in\s*\n?\s*\/\/ the React layer\)\./,
    );
  });

  it("DSN-via-import.meta.env framing pinned: 'Sentry DSN for the Driftstack cloud GUI client. Filled in at build time via VITE_SENTRY_DSN env var. Empty string = no DSN configured (telemetry effectively disabled regardless of toggle state).' + 'The DSN is a public identifier; embedding it in the bundle is standard Sentry practice. The DSN identifies WHERE crashes go (Driftstack's Sentry project), not WHO is sending them — Sentry's server-side enforcement on accepted events handles abuse.'", () => {
    expect(body).toMatch(
      /\*\s*Sentry DSN for the Driftstack cloud GUI client\. Filled in at build\s*\n?\s*\*\s*time via VITE_SENTRY_DSN env var\. Empty string = no DSN configured\s*\n?\s*\*\s*\(telemetry effectively disabled regardless of toggle state\)\./,
    );
    expect(body).toMatch(
      /\*\s*The DSN is a public identifier; embedding it in the bundle is\s*\n?\s*\*\s*standard Sentry practice\. The DSN identifies WHERE crashes go\s*\n?\s*\*\s*\(Driftstack's Sentry project\), not WHO is sending them — Sentry's\s*\n?\s*\*\s*server-side enforcement on accepted events handles abuse\./,
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
      /export interface TelemetryConfig \{\s*\n?\s*\/\*\* Customer's configured base URL \(cloud detection\)\. \*\/\s*\n?\s*baseUrl: string;\s*\n?\s*\/\*\* Customer's explicit opt-in\/out \(null = "use platform default"\)\. \*\/\s*\n?\s*optIn: boolean \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function telemetryEnabled\(cfg: TelemetryConfig\): boolean \{\s*\n?\s*if \(SENTRY_DSN === ''\) return false; \/\/ no DSN → never fires\s*\n?\s*const isCloud = isCloudBaseUrl\(cfg\.baseUrl\);\s*\n?\s*if \(cfg\.optIn === true\) return true;\s*\n?\s*if \(cfg\.optIn === false\) return false;\s*\n?\s*\/\/ null = use platform default: ON for cloud, OFF for self-hosted\.\s*\n?\s*return isCloud;\s*\n?\s*\}/,
    );
  });

  it("isCloudBaseUrl: hostname === 'driftstack.dev' OR endsWith('.driftstack.dev'); try/catch → false on malformed URL + framing 'Mirrors App.tsx::deploymentLabel logic; not cross-imported to avoid a circular boot path between App + telemetry init.'", () => {
    expect(body).toMatch(
      /\*\s*Extract whether a baseUrl points at the Driftstack cloud surface\.\s*\n?\s*\*\s*Mirrors `App\.tsx::deploymentLabel` logic; not cross-imported to\s*\n?\s*\*\s*avoid a circular boot path between App \+ telemetry init\./,
    );
    expect(body).toMatch(
      /export function isCloudBaseUrl\(baseUrl: string\): boolean \{\s*\n?\s*try \{\s*\n?\s*const host = new URL\(baseUrl\)\.hostname;\s*\n?\s*return host === 'driftstack\.dev' \|\| host\.endsWith\('\.driftstack\.dev'\);\s*\n?\s*\} catch \{\s*\n?\s*return false;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("initTelemetry: !telemetryEnabled branch closes existing client 'Customer just opted out — close the client to flush + stop.'; idempotent if initialized + telemetry enabled; Sentry.init with release `driftstack-gui@${APP_VERSION}` + tracesSampleRate 0 + sendDefaultPii: false + integration-filter dropping BrowserTracing/Replay/BrowserProfilingIntegration", () => {
    expect(body).toMatch(
      /if \(!telemetryEnabled\(cfg\)\) \{\s*\n?\s*if \(initialized\) \{\s*\n?\s*\/\/ Customer just opted out — close the client to flush \+ stop\.\s*\n?\s*void Sentry\.close\(\);\s*\n?\s*initialized = false;\s*\n?\s*\}\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*if \(initialized\) return; \/\/ already running/,
    );
    expect(body).toMatch(
      /Sentry\.init\(\{\s*\n?\s*dsn: SENTRY_DSN,\s*\n?\s*release: `driftstack-gui@\$\{APP_VERSION\}`,/,
    );
    expect(body).toMatch(
      /integrations: \(defaults\) =>\s*\n?\s*defaults\.filter\(\s*\n?\s*\(integration\) =>\s*\n?\s*\/\/ Keep error-capture core; drop anything user-tracking-shaped\.\s*\n?\s*!\['BrowserTracing', 'Replay', 'BrowserProfilingIntegration'\]\.includes\(integration\.name\),\s*\n?\s*\),/,
    );
    expect(body).toMatch(/tracesSampleRate: 0,/);
    expect(body).toMatch(/sendDefaultPii: false,\s*\n?\s*beforeSend: scrubEvent,/);
  });

  it("scrubEvent: Authorization-style headers (toLowerCase().includes('auth') OR cookie OR set-cookie) → '[scrubbed]' + extra/contexts spread scrub via scrubObject; SENSITIVE_KEY_PATTERNS 6 regexes (api_key + password + secret + token + bearer + authorization)", () => {
    expect(body).toMatch(
      /if \(\s*\n?\s*k\.toLowerCase\(\)\.includes\('auth'\) \|\|\s*\n?\s*k\.toLowerCase\(\) === 'cookie' \|\|\s*\n?\s*k\.toLowerCase\(\) === 'set-cookie'\s*\n?\s*\) \{\s*\n?\s*h\[k\] = '\[scrubbed\]';\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const SENSITIVE_KEY_PATTERNS = \[\s*\n?\s*\/\^api\[_-\]\?key\$\/i,\s*\n?\s*\/\^password\$\/i,\s*\n?\s*\/\^secret\$\/i,\s*\n?\s*\/\^token\$\/i,\s*\n?\s*\/\^bearer\$\/i,\s*\n?\s*\/authorization\/i,\s*\n?\s*\];/,
    );
  });

  it("scrubObject: iterates Object.entries; if SENSITIVE_KEY_PATTERNS.some(p.test(k)) → '[scrubbed]' else passes value through unchanged", () => {
    expect(body).toMatch(
      /function scrubObject\(obj: Record<string, unknown>\): Record<string, unknown> \{\s*\n?\s*const out: Record<string, unknown> = \{\};\s*\n?\s*for \(const \[k, v\] of Object\.entries\(obj\)\) \{\s*\n?\s*if \(SENSITIVE_KEY_PATTERNS\.some\(\(p\) => p\.test\(k\)\)\) \{\s*\n?\s*out\[k\] = '\[scrubbed\]';\s*\n?\s*\} else \{\s*\n?\s*out\[k\] = v;\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
