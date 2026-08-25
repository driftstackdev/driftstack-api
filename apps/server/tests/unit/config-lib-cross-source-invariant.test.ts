// W966 — config lib W190 + V-295c2 + EU-residency cross-source
// invariant. Two-hundred-ninety-second in the drift-guard series.
// Pins the env-driven config schema:
//
//   Zod-schema-driven config — ConfigSchema is the single source of
//   truth for environment-variable validation + transformation.
//
//   W190 DASHBOARD_ORIGIN trailing-slash strip framing — 'strip any
//   trailing slash so consumers can safely do
//   ${dashboardOrigin}/billing etc. without producing https://…//
//   billing. The zod schema is the single normalisation point;
//   cli-authorize.ts and the other call sites no longer need to
//   re-strip'.
//
//   V-266 DASHBOARD_ORIGIN purpose — 'origin of the customer
//   dashboard. Used to build the browser_url returned by
//   /v1/auth/cli-authorize/initiate so the GUI's deep link points
//   at the right host (dev / staging / prod)'.
//
//   V-295c2 R2.bucketPublic framing — 'separate public-readable
//   bucket for the status-page snapshot. MUST be a different bucket
//   from bucketRecordings — recordings contain Customer Data and
//   must remain private. The public bucket holds operational JSON
//   only (incident snapshots). Optional: when null, status-snapshot
//   writer is disabled'.
//
//   Sentry EU-residency .de. validation — 'EU region required: DSN
//   must contain .de. (per docs/deployment/env-vars.md validation
//   checklist)'.
//
//   Postmark 3-field framing — apiToken + from + replyTo all
//   required to enable. Fire-and-forget; readiness does NOT gate
//   on Postmark connectivity (per V-054 follow-up).
//
//   V-353b mfaEncryptionKey framing — 'base64-encoded 32-byte
//   AES-256-GCM key used to encrypt TOTP secrets at rest. When
//   unset, /v1/account/mfa/* routes are not registered (MFA
//   disabled)'.
//
//   V-487 nowpayments framing — 'When apiKey + ipnSecret are unset,
//   the /v1/billing/crypto-* routes are not registered at all (V-839:
//   this line said they were stubs returning 501; there is no 501 in
//   this server and an unregistered route is a bare 404);
//   the code is wired but inactive until the account is created and
//   the credentials are SSH-written. This lets
//   launch-day flip the rail on without redeploying'.
//
//   V-113 slow-query log framing — 'Slow-query log threshold. When
//   set, queries at or above this duration emit a warn-level
//   structured log via postgres-js client instrumentation. Unset =
//   disabled (default for dev/test)'.
//
//   V-333b Playwright driver framing — playwrightBrowser default
//   'webkit' (closest to iPhone Safari for non-stealth E2E smoke
//   testing on Mac) + playwrightHeaded default false (true = visible
//   window for Mac dev, false = headless for CI).
//
//   Driver enum — 'mock' | 'webkit' | 'playwright' (default 'mock').
//
//   nodeEnv 3-value union: 'development' | 'test' | 'production'.
//
//   logLevel 6-value union: 'fatal' | 'error' | 'warn' | 'info' |
//     'debug' | 'trace'.
//
// stays in lockstep across apps/server/src/lib/config.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W966 config lib cross-source invariant', () => {
  // ─── W190 DASHBOARD_ORIGIN trailing-slash strip framing ──────

  it("CRITICAL W190 DASHBOARD_ORIGIN strip framing — 'W190 — strip any trailing slash so consumers can safely do ${dashboardOrigin}/billing etc. without producing https://…//billing. The zod schema is the single normalisation point; cli-authorize.ts and the other call sites no longer need to re-strip'. The schema-level normalisation is the W190 single-point-of-truth invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/W190 — strip any trailing slash so consumers can safely do/);
    expect(p).toMatch(
      /`\$\{dashboardOrigin\}\/billing` etc\. without producing `https:\/\/…\/\/billing`\./,
    );
    expect(p).toMatch(/The zod schema is the single normalisation point; cli-authorize\.ts/);
    expect(p).toMatch(/and the other call sites no longer need to re-strip\./);
  });

  it("CRITICAL dashboardOrigin schema applies .transform((s) => s.replace(/\\/+$/, '')) — strips trailing slashes at schema level. The transform makes ${dashboardOrigin}/path template-literal joins safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/dashboardOrigin: z/);
    expect(p).toMatch(/\.transform\(\(s\) => s\.replace\(\/\\\/\+\$\/, ''\)\)/);
  });

  // ─── V-266 DASHBOARD_ORIGIN purpose framing ──────────────────

  it("CRITICAL V-266 DASHBOARD_ORIGIN framing — 'V-266 — origin of the customer dashboard. Used to build the browser_url returned by /v1/auth/cli-authorize/initiate so the GUI's deep link points at the right host (dev / staging / prod)'. The V-266 + cli-authorize wiring matches W934 cli-authorize cross-source invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-266 — origin of the customer dashboard\. Used to build the/);
    expect(p).toMatch(/browser_url returned by \/v1\/auth\/cli-authorize\/initiate so the/);
    expect(p).toMatch(/GUI's deep link points at the right host \(dev \/ staging \/ prod\)\./);
  });

  it("CRITICAL dashboardOrigin defaults to 'http://localhost:5173' (Vite dev-server default port). The dev-default lets local-dev work without env wiring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/\.default\('http:\/\/localhost:5173'\)/);
  });

  // ─── V-295c2 R2 dual-bucket framing ──────────────────────────

  // V-1134 — this pinned the bucketPublic comment verbatim, including the sentence
  // restricting that bucket to operational JSON, and its own title concluded that the
  // two-bucket split "defends against Customer-Data → public leak". The conclusion was
  // false: V-352b writes customer avatars to this very bucket via r2Public.putObject.
  // The separation defends RECORDINGS, which is narrower and true. Anchors are split
  // from the volatile claim so a corrected comment no longer has to fight a regex that
  // spanned both.
  it('CRITICAL V-295c2 R2.bucketPublic framing. The two-bucket split keeps RECORDINGS off the public bucket — narrower than the leak-proof reading this pin used to assert in its own title, because customer avatars are written to the public bucket too.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-295c2 — separate public-readable bucket for the status-page/);
    expect(p).toMatch(/snapshot\. MUST be a different bucket from bucketRecordings —/);
    expect(p).toMatch(/recordings contain Customer Data and must remain private/);

    // V-1134 negative — the retired restriction, quoted so it cannot come back.
    expect(p, 'the public bucket is described as operational-JSON-only again').not.toMatch(
      /holds operational JSON only/,
    );

    expect(p).toMatch(/customer-uploaded AVATARS/);
    expect(p).toMatch(/avatar endpoints return 503/);
  });

  it('CRITICAL R2 has 6-field shape: accountId + accessKeyId + secretAccessKey + bucketRecordings + bucketPublic (nullable) + endpointUrl. The nullable bucketPublic is the V-295c2 disabled-when-unset toggle.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/accountId: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/accessKeyId: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/secretAccessKey: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/bucketRecordings: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/bucketPublic: z\.string\(\)\.min\(1\)\.nullable\(\),/);
    expect(p).toMatch(/endpointUrl: z\.string\(\)\.url\(\),/);
  });

  // ─── Sentry EU .de. residency validation framing ─────────────

  it("CRITICAL Sentry .de. EU-residency framing — 'EU region required: DSN must contain .de. (per docs/deployment/env-vars.md validation checklist)'. The .de.-substring check enforces data-residency policy at config-validation time.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/EU region required: DSN must contain/);
    expect(p).toMatch(/`\.de\.` \(per docs\/deployment\/env-vars\.md validation checklist\)\./);
    expect(p).toMatch(
      /\.refine\(\(u\) => u\.includes\('\.de\.'\) \|\| u\.includes\('\.ingest\.de\.sentry\.io'\), \{/,
    );
    expect(p).toMatch(
      /message: 'SENTRY_DSN must use the EU region \(\.de\.\) per data-residency policy',/,
    );
  });

  it('CRITICAL Sentry config 4-field shape — dsn (with .de. refinement) + environment + release? + tracesSampleRate (0-1, default 0). The tracesSampleRate=0 default disables tracing in dev/test.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/dsn: z/);
    expect(p).toMatch(/environment: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/release: z\.string\(\)\.min\(1\)\.optional\(\),/);
    expect(p).toMatch(/tracesSampleRate: z\.coerce\.number\(\)\.min\(0\)\.max\(1\)\.default\(0\),/);
  });

  // ─── Postmark 3-field + V-054 fire-and-forget framing ───────

  it('CRITICAL Postmark 3-field framing — apiToken + from + replyTo all required to enable. The 3-field-all-required design + fire-and-forget framing matches W914 email-transport V-057 invariant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/postmark: z/);
    expect(p).toMatch(/apiToken: z\.string\(\)\.min\(1\),/);
    expect(p).toMatch(/from: z\.string\(\)\.email\(\),/);
    expect(p).toMatch(/replyTo: z\.string\(\)\.email\(\),/);
  });

  it("CRITICAL Postmark fire-and-forget framing — 'Postmark — transactional email. All three required to enable. Fire-and-forget; readiness does NOT gate on Postmark connectivity (per founder direction V-054 follow-up: SDK init failures logged clearly at boot, then service operates degraded — no email path is in the request critical-path)'. The V-054 + readiness-doesnt-gate is the API-uptime-decoupled design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/Postmark — transactional email\. All three required to enable\./);
    expect(p).toMatch(/Fire-and-forget; readiness does NOT gate on Postmark connectivity/);
    expect(p).toMatch(/\(per founder direction V-054 follow-up: SDK init failures logged/);
    expect(p).toMatch(/clearly at boot, then service operates degraded — no email path/);
    expect(p).toMatch(/is in the request critical-path\)\./);
  });

  // ─── V-353b mfaEncryptionKey + V-487 nowpayments opt-in ──────

  it("CRITICAL V-353b mfaEncryptionKey framing — 'V-353b — base64-encoded 32-byte AES-256-GCM key used to encrypt TOTP secrets at rest. When unset, /v1/account/mfa/* routes are not registered (MFA disabled)'. The unset → routes-not-registered design is the conditional-feature pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-353b — base64-encoded 32-byte AES-256-GCM key used to encrypt/);
    expect(p).toMatch(/TOTP secrets at rest\. When unset, \/v1\/account\/mfa\/\* routes are/);
    expect(p).toMatch(/not registered \(MFA disabled\)\./);
    // V-353b hardening: the key is length-validated EAGERLY at config-parse
    // (was a bare z.string().optional() — a wrong-length key booted fine then
    // 500-ed the first customer to enroll MFA / save a BYOK key / mint a
    // LiveKit token; one key backs all four AES-256-GCM surfaces).
    expect(p).toMatch(/Validated eagerly here \(length-checked at config-parse\)/);
    expect(p).toMatch(/mfaEncryptionKey: z/);
    expect(p).toMatch(/\.refine\(\(v\) => Buffer\.from\(v, 'base64'\)\.length === 32/);
  });

  it('CRITICAL V-487 nowpayments framing — the opt-in sub-processor scaffold, the Estonia EEA-internal V-308a anchor, and the launch-day-flip-without-redeploy property. The opt-in design lets V-487 ship dark. V-839 corrected the mechanism this case quoted: unset credentials mean the routes are never registered, not that stubs answer 501.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-487 — NowPayments crypto-rail scaffold\. Conditional, opt-in/);
    expect(p).toMatch(/sub-processor \(Estonia EEA-internal per the V-308a legal/);
    expect(p).toMatch(/scaffolding\)\. When `ipnSecret` is unset, `cryptoOrdersService` is/);
    expect(p).toMatch(
      /`\/v1\/billing\/crypto-\*` routes are NOT\s*\*\s*REGISTERED and a request gets a bare 404\./,
    );
    // V-839 SENTINEL — no 501 exists in this server; the routes are absent,
    // not stubbed, and the paths use a hyphen.
    expect(p, 'there are no 501 crypto stubs').not.toMatch(/route stubs return 501/);
    expect(p).toMatch(/inactive until the account is created and the credentials are/);
    expect(p).toMatch(/SSH-written\. This lets launch-day flip the rail on without/);
    expect(p).toMatch(/launch-day flip the rail on without\s*\*\s*redeploying\./);
  });

  // ─── V-531.B LiveKit SFU framing ─────────────────────────────

  it("CRITICAL V-531.B livekit framing — 'LiveKit SFU credentials for the real-WebRTC swap. apiKey + apiSecret mint short-lived JWT access tokens via livekit-server-sdk. wsUrl must use wss://. All three fields required together: the route-gate at app.ts mirrors the nowpayments pattern (route stays unregistered unless every field is present)'. The all-or-nothing wire-up posture matches V-487's launch-day flip-on design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-531\.B — LiveKit SFU credentials for the real-WebRTC swap\./);
    expect(p).toMatch(/`apiKey` \+ `apiSecret` are issued in the LiveKit Cloud dashboard/);
    expect(p).toMatch(/short-lived/);
    expect(p).toMatch(/JWT access tokens via `livekit-server-sdk`\./);
    expect(p).toMatch(/`wsUrl` must use the `wss:\/\/` scheme — LiveKit refuses plain ws/);
    expect(p).toMatch(/outside dev\. All three fields are required together: the/);
    expect(p).toMatch(/route-gate at `app\.ts` mirrors the nowpayments pattern \(route/);
    expect(p).toMatch(/stays unregistered unless every field is present\)\./);
    expect(p).toMatch(/livekit: z/);
    expect(p).toMatch(/export type LivekitConfig = NonNullable<Config\['livekit'\]>;/);
  });

  // ─── V-113 slow-query log framing ────────────────────────────

  it("CRITICAL V-113 slow-query log framing — 'V-113: Slow-query log threshold. When set, queries at or above this duration emit a warn-level structured log via postgres-js client instrumentation. Unset = disabled (default for dev/test)'. The opt-in-via-set design keeps dev/test logs clean.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-113: Slow-query log threshold\. When set, queries at or above this/);
    expect(p).toMatch(/duration emit a warn-level structured log via postgres-js client/);
    expect(p).toMatch(/instrumentation\. Unset = disabled \(default for dev\/test\)\./);
    expect(p).toMatch(
      /slowQueryLogThresholdMs: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/,
    );
    // V-156 follow-up — opt-in per-connection statement_timeout field (off by
    // default; app-path only via DB_STATEMENT_TIMEOUT_MS; migrations exempt).
    expect(p).toMatch(
      /dbStatementTimeoutMs: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/,
    );
  });

  // ─── V-333b Playwright driver framing ────────────────────────

  it("CRITICAL V-333b Playwright framing — 'V-333b — Playwright driver channel. Consulted only when driver === playwright. Defaults to webkit (closest to iPhone Safari for non-stealth E2E smoke testing on Mac)'. The webkit-default rationale is the V-333b iPhone-Safari-mirror policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-333b — Playwright driver channel\. Consulted only when/);
    expect(p).toMatch(/driver === 'playwright'\. Defaults to webkit \(closest to iPhone/);
    expect(p).toMatch(/Safari for non-stealth E2E smoke testing on Mac\)\./);
    expect(p).toMatch(
      /playwrightBrowser: z\.enum\(\['webkit', 'chromium', 'firefox'\]\)\.default\('webkit'\),/,
    );
  });

  it("CRITICAL playwrightHeaded framing — 'V-333b — true = visible window (Mac dev), false = headless (CI)'. The visible-vs-headless toggle is the Mac-dev-vs-CI distinction.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/V-333b — true = visible window \(Mac dev\), false = headless \(CI\)\./);
    expect(p).toMatch(/playwrightHeaded: z\.boolean\(\)\.default\(false\),/);
  });

  // ─── Driver enum 3-value ──────────────────────────────────────

  it("CRITICAL driver enum — 'mock' | 'webkit' | 'playwright' (default 'mock'). The 3-value driver discriminator selects substrate; default mock keeps tests substrate-free.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/driver: z\.enum\(\['mock', 'webkit', 'playwright'\]\)\.default\('mock'\),/);
  });

  it('CRITICAL docs/deployment/env-vars.md DRIVER row lists EVERY config.ts driver enum value. Drift (config gains a driver, doc omits it — as happened with `playwright`) leaves operators unaware a substrate is selectable.', () => {
    const cfg = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    const enumMatch = cfg.match(/driver: z\.enum\(\[([^\]]+)\]\)/);
    expect(enumMatch, 'config.ts driver enum not found').not.toBeNull();
    const enumBody = enumMatch?.[1] ?? '';
    const values = [...enumBody.matchAll(/'([a-z]+)'/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined);
    expect(values.length).toBeGreaterThanOrEqual(3);
    const envVarsDoc = read(resolve(REPO_ROOT, 'docs/deployment/env-vars.md'));
    const driverRow = envVarsDoc.split('\n').find((l) => /^\|\s*`DRIVER`/.test(l)) ?? '';
    for (const v of values) {
      expect(driverRow, `env-vars.md DRIVER row must list driver value '${v}'`).toContain(v);
    }
  });

  // ─── nodeEnv + logLevel enums ────────────────────────────────

  it("CRITICAL nodeEnv 3-value enum — 'development' | 'test' | 'production' (default 'development'). Matches the standard Node.js NODE_ENV vocabulary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(
      /nodeEnv: z\.enum\(\['development', 'test', 'production'\]\)\.default\('development'\),/,
    );
  });

  it("CRITICAL logLevel 6-value enum — 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' (default 'info'). Matches pino log-level vocabulary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(
      /logLevel: z\.enum\(\['fatal', 'error', 'warn', 'info', 'debug', 'trace'\]\)\.default\('info'\),/,
    );
  });

  // ─── databaseUrl + redisUrl required ─────────────────────────

  it('CRITICAL databaseUrl + redisUrl are required (z.string().url() without .optional() or .default()). The hard-required pair is what makes config-parse fail fast on misconfigured envs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/databaseUrl: z\.string\(\)\.url\(\),/);
    expect(p).toMatch(/redisUrl: z\.string\(\)\.url\(\),/);
  });

  // ─── Config + named-config-type exports ──────────────────────

  it('CRITICAL exports Config (z.infer) + R2Config + PostmarkConfig + SentryConfig (NonNullable). The NonNullable-derived per-feature types let downstream services accept only the populated-shape (not the nullable raw).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/export type Config = z\.infer<typeof ConfigSchema>;/);
    expect(p).toMatch(/export type R2Config = NonNullable<Config\['r2'\]>;/);
    expect(p).toMatch(/export type PostmarkConfig = NonNullable<Config\['postmark'\]>;/);
    expect(p).toMatch(/export type SentryConfig = NonNullable<Config\['sentry'\]>;/);
  });

  // ─── port + host defaults ────────────────────────────────────

  it("CRITICAL port default = 3000 + host default = '0.0.0.0'. The 3000 + 0.0.0.0 defaults are the local-dev + container-friendly start config.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    expect(p).toMatch(/port: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(3000\),/);
    expect(p).toMatch(/host: z\.string\(\)\.default\('0\.0\.0\.0'\),/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/config-lib-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
