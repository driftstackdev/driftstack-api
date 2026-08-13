// W390.A — drift guard for apps/server/src/lib/config.ts.
// The env-var → Config zod schema is the single boot-time gate;
// drift here silently mis-wires sub-processors or, worse, lets prod
// boot with a localhost-resolving auth URL. The `DASHBOARD_ORIGIN`
// trailing-slash normalisation (W190 memory) and the prod-localhost
// refusal (V-079) are the two load-bearing safety claims pinned here.
//
//   • DASHBOARD_ORIGIN trailing-slash strip at zod schema (W190).
//   • V-079 production refusal: localhost in DASHBOARD_ORIGIN or any
//     resolved AUTH_*_URL → throw at boot.
//   • V-079 production refusal: DASHBOARD_ORIGIN unset / empty.
//   • V-079.C dashboard route paths (/verify-email, /reset-password,
//     /auth/magic-link).
//   • Sentry EU-region DSN refinement (.de. substring).
//   • V-295c2 bucketPublic optional (status-snapshot writer).
//   • R2 + Postmark fire-and-forget readiness-skip framing.
//   • V-487 NowPayments scaffold: 501-stub until apiKey + ipnSecret set.
//   • V-353b MFA encryption key optional.
//   • V-333b Playwright driver channel + headed defaults.
//   • parseTierPrices accepts legacy flat string or {monthly, annual}.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W390.A apps/server/src/lib/config.ts content parity', () => {
  const body = read(LIB);

  it('V-266 + W190 DASHBOARD_ORIGIN trailing-slash strip at zod schema (single normalisation point)', () => {
    expect(body).toMatch(
      /V-266 — origin of the customer dashboard\. Used to build the\s*\n?\s*\*\s*browser_url returned by \/v1\/auth\/cli-authorize\/initiate/,
    );
    expect(body).toMatch(
      /W190 — strip any trailing slash so consumers can safely do\s*\n?\s*\/\/\s*`\$\{dashboardOrigin\}\/billing` etc\. without producing `https:\/\/…\/\/billing`/,
    );
    expect(body).toMatch(
      /dashboardOrigin: z\s*\n?\s*\.string\(\)\s*\n?\s*\.url\(\)\s*\n?\s*\.default\('http:\/\/localhost:5173'\)\s*\n?\s*\.transform\(\(s\) => s\.replace\(\/\\\/\+\$\/, ''\)\),/,
    );
  });

  it('V-079.B/C dashboard route paths: /verify-email, /reset-password, /auth/magic-link', () => {
    expect(body).toMatch(
      /V-079\.B\/C — dashboard route paths\. The customer-dashboard\s*\n?\s*\/\/\s*\(apps\/customer-dashboard\) serves these at:\s*\n?\s*\/\/\s*\/verify-email, \/reset-password, \/auth\/magic-link/,
    );
    expect(body).toMatch(
      /verifyEmail: env\.AUTH_VERIFY_EMAIL_URL \?\? fromOrigin\('\/verify-email'\),/,
    );
    expect(body).toMatch(
      /magicLink: env\.AUTH_MAGIC_LINK_URL \?\? fromOrigin\('\/auth\/magic-link'\),/,
    );
    expect(body).toMatch(
      /passwordReset: env\.AUTH_PASSWORD_RESET_URL \?\? fromOrigin\('\/reset-password'\),/,
    );
  });

  it('V-079 production refusal: localhost-resolving auth URL → throw at boot', () => {
    expect(body).toMatch(
      /In production, any resolved URL still pointing at localhost is a\s*\n?\s*\*\s*misconfiguration — the boot-time guard at the bottom rejects it\s*\n?\s*\*\s*rather than letting customers receive broken links again/,
    );
    expect(body).toMatch(
      /if \(value !== undefined && \/\\blocalhost\\b\/\.test\(value\)\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`Refusing to boot: \$\{name\} resolves to a localhost URL/,
    );
  });

  it('V-079 production refusal: DASHBOARD_ORIGIN unset or empty → throw at boot', () => {
    expect(body).toMatch(
      /Reject the "no DASHBOARD_ORIGIN at all" case too — the zod\s*\n?\s*\/\/\s*default would otherwise land on the localhost fallback/,
    );
    expect(body).toMatch(
      /if \(env\.DASHBOARD_ORIGIN === undefined \|\| env\.DASHBOARD_ORIGIN\.length === 0\) \{\s*\n?\s*throw new Error\(\s*\n?\s*'Refusing to boot: DASHBOARD_ORIGIN must be set in production/,
    );
  });

  it('deriveAuthFlowUrls: 3-step resolution order (per-URL → DASHBOARD_ORIGIN+path → localhost default)', () => {
    expect(body).toMatch(
      /Resolution order for each URL:\s*\n?\s*\*\s*1\. explicit per-URL env var \(AUTH_VERIFY_EMAIL_URL etc\.\)\s*\n?\s*\*\s*2\. DASHBOARD_ORIGIN \+ the conventional path\s*\n?\s*\*\s*3\. dev-friendly localhost default \(final fallback, dev-only\)/,
    );
  });

  it('Sentry EU-region DSN refinement: .de. or .ingest.de.sentry.io', () => {
    expect(body).toMatch(
      /Sentry — error tracking\. EU region required: DSN must contain\s*\n?\s*\/\/\s*`\.de\.` \(per docs\/deployment\/env-vars\.md validation checklist\)/,
    );
    expect(body).toMatch(
      /\.refine\(\(u\) => u\.includes\('\.de\.'\) \|\| u\.includes\('\.ingest\.de\.sentry\.io'\), \{\s*\n?\s*message: 'SENTRY_DSN must use the EU region \(\.de\.\) per data-residency policy',\s*\n?\s*\}\),/,
    );
  });

  it('V-295c2 bucketPublic: separate public-readable bucket, MUST differ from bucketRecordings', () => {
    expect(body).toMatch(
      /V-295c2 — separate public-readable bucket for the status-page\s*\n?\s*\*\s*snapshot\. MUST be a different bucket from bucketRecordings —\s*\n?\s*\*\s*recordings contain Customer Data and must remain private\. The\s*\n?\s*\*\s*public bucket holds operational JSON only \(incident snapshots\)/,
    );
    expect(body).toMatch(/bucketPublic: z\.string\(\)\.min\(1\)\.nullable\(\),/);
  });

  it('R2 readiness fire-and-forget framing: missing R2 disables R2, readiness skips the R2 check', () => {
    expect(body).toMatch(
      /All\s*\n?\s*\/\/\s*four required to enable R2; if any is missing, R2 is disabled and\s*\n?\s*\/\/\s*the readiness probe skips the R2 check \(logged at boot\)/,
    );
  });

  it('Postmark fire-and-forget framing: readiness does NOT gate on Postmark connectivity', () => {
    expect(body).toMatch(
      /Fire-and-forget; readiness does NOT gate on Postmark connectivity\s*\n?\s*\/\/\s*\(per founder direction V-054 follow-up: SDK init failures logged\s*\n?\s*\/\/\s*clearly at boot, then service operates degraded — no email path\s*\n?\s*\/\/\s*is in the request critical-path\)/,
    );
  });

  it('Sentry fire-and-forget framing: readiness does NOT gate on Sentry connectivity', () => {
    expect(body).toMatch(/Fire-and-forget; readiness does NOT gate on Sentry connectivity/);
  });

  it('V-487 NowPayments scaffold: 501-stub until apiKey + ipnSecret set (launch-day flip)', () => {
    expect(body).toMatch(
      /V-487 — NowPayments crypto-rail scaffold\. Conditional, opt-in\s*\n?\s*\*\s*sub-processor \(Estonia EEA-internal per the V-308a legal\s*\n?\s*\*\s*scaffolding\)\. When `apiKey` \+ `ipnSecret` are unset, the\s*\n?\s*\*\s*`\/v1\/billing\/crypto\/\*` route stubs return 501 Not Implemented/,
    );
    expect(body).toMatch(
      /the code is wired but inactive until the founder creates the\s*\n?\s*\*\s*NowPayments account and SSH-writes the credentials\. This lets\s*\n?\s*\*\s*launch-day flip the rail on without redeploying/,
    );
  });

  it('V-080 / V-082 / V-088 Stripe sub-fields all individually optional', () => {
    expect(body).toMatch(/V-080 \/ V-082 \/ V-088: Stripe configuration\./);
    expect(body).toMatch(
      /Sub-fields are individually optional so dev\s*\n?\s*\/\/\s*can run without any Stripe config \(routes simply don't register\)/,
    );
    expect(body).toMatch(/webhookSecret: z\.string\(\)\.min\(1\)\.optional\(\),/);
    expect(body).toMatch(/secretKey: z\.string\(\)\.min\(1\)\.optional\(\),/);
    expect(body).toMatch(
      /tierPrices: z\s*\n?\s*\.record\(z\.string\(\), z\.object\(\{ monthly: z\.string\(\), annual: z\.string\(\) \}\)\)\s*\n?\s*\.optional\(\),/,
    );
  });

  it('V-353b MFA encryption key: base64-encoded 32-byte AES-256-GCM, optional (when unset MFA disabled); length-validated EAGERLY at config-parse (not just lazily in decodeKey) so a wrong-length key fails the boot rather than the first customer', () => {
    expect(body).toMatch(
      /V-353b — base64-encoded 32-byte AES-256-GCM key used to encrypt\s*\n?\s*\*\s*TOTP secrets at rest\. When unset, \/v1\/account\/mfa\/\* routes are\s*\n?\s*\*\s*not registered \(MFA disabled\)/,
    );
    // Field present (still optional → conditional-feature: unset = MFA disabled,
    // asserted behaviorally in config.test.ts). Short focused pins, not one
    // long-chain regex, per the no-long-chain-regex rule.
    expect(body).toMatch(/mfaEncryptionKey: z/);
    // The hardening: eager length-check at parse-time (base64-decode === 32
    // bytes), mirroring the .min(16) on metricsScrapeToken/fleetInternalToken.
    expect(body).toMatch(/\.refine\(\(v\) => Buffer\.from\(v, 'base64'\)\.length === 32/);
    expect(body).toMatch(/MFA_ENCRYPTION_KEY must base64-decode to exactly 32 bytes \(AES-256\)/);
  });

  it('V-333b Playwright driver channel: webkit default + headed=false default', () => {
    expect(body).toMatch(
      /V-333b — Playwright driver channel\. Consulted only when\s*\n?\s*\/\/\s*driver === 'playwright'\. Defaults to webkit \(closest to iPhone\s*\n?\s*\/\/\s*Safari for non-stealth E2E smoke testing on Mac\)/,
    );
    expect(body).toMatch(
      /playwrightBrowser: z\.enum\(\['webkit', 'chromium', 'firefox'\]\)\.default\('webkit'\),/,
    );
    expect(body).toMatch(
      /\/\/ V-333b — true = visible window \(Mac dev\), false = headless \(CI\)\./,
    );
    // z.boolean() NOT z.coerce.boolean() — the env mapping converts via
    // `=== 'true'` (coerce.boolean would make "false" → true). Pinned so a
    // future "simplify" can't reintroduce the footgun.
    expect(body).toMatch(/playwrightHeaded: z\.boolean\(\)\.default\(false\),/);
  });

  it('V-113 slow-query log threshold: optional, unset = disabled (default for dev/test)', () => {
    expect(body).toMatch(
      /V-113: Slow-query log threshold\. When set, queries at or above this\s*\n?\s*\/\/\s*duration emit a warn-level structured log via postgres-js client\s*\n?\s*\/\/\s*instrumentation\. Unset = disabled \(default for dev\/test\)/,
    );
    expect(body).toMatch(
      /slowQueryLogThresholdMs: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/,
    );
    // V-156 follow-up — opt-in per-connection statement_timeout (off by default,
    // mirrors the slow-query-log opt-in; app-path only, migrations exempt).
    expect(body).toMatch(
      /dbStatementTimeoutMs: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.optional\(\),/,
    );
  });

  it('driver enum: mock | webkit | playwright; default mock', () => {
    expect(body).toMatch(
      /driver: z\.enum\(\['mock', 'webkit', 'playwright'\]\)\.default\('mock'\),/,
    );
  });

  it('parseTierPrices: accepts legacy flat-string shape OR {monthly, annual}; throws on malformed', () => {
    expect(body).toMatch(
      /Accepts either the new nested shape \(monthly \+ annual per tier\) or the\s*\n?\s*\/\/\s*legacy flat shape from the env-vars\.md placeholder \(single price id per\s*\n?\s*\/\/\s*tier — synthesised as monthly only\)\. Throws on malformed input so a\s*\n?\s*\/\/\s*misconfigured deploy fails fast at boot/,
    );
    expect(body).toMatch(/out\[tier\] = \{ monthly: value, annual: value \};/);
    expect(body).toMatch(
      /throw new Error\(`DRIFTSTACK_TIER_PRICE_IDS\.\$\{tier\} must be a string or \{monthly, annual\}`\);/,
    );
  });

  it('exposeDebugToken: dev/test only — production must never leak token via response body', () => {
    expect(body).toMatch(
      /When true, signup \/ magic-link \/ password-reset responses include\s*\n?\s*\*\s*a `debug_token` field containing the plaintext token\. ENABLE ONLY\s*\n?\s*\*\s*in dev \/ test — production must never leak these tokens via the\s*\n?\s*\*\s*response body\. Default false/,
    );
    expect(body).toMatch(/exposeDebugToken: z\.boolean\(\)\.default\(false\),/);
    expect(body).toMatch(/exposeDebugToken: envFlag\(env\.AUTH_EXPOSE_DEBUG_TOKEN\)/);
    expect(body).toMatch(
      /if \(resolved\.exposeDebugToken\) \{\s*throw new Error\(\s*'Refusing to boot: AUTH_EXPOSE_DEBUG_TOKEN=true is development\/test-only and would expose plaintext one-time authentication tokens in production responses\.'/,
    );
  });

  it('fails closed when the staging-only decomposer fallback is enabled in production', () => {
    expect(body).toMatch(
      /env\.NODE_ENV === 'production' &&\s*env\.DRIFTSTACK_DEPLOY_ENV !== 'staging' &&\s*envFlag\(env\.DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK\)/,
    );
    expect(body).toMatch(
      /Refusing to boot: DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK=true is staging-only and would bypass customer BYOK or bundled-LLM consent in production/,
    );
    expect(body).toMatch(/envFlag\(env\.DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK\)/);
  });

  it('exported types: Config + R2Config + PostmarkConfig + SentryConfig (NonNullable shorthand)', () => {
    expect(body).toMatch(/export type Config = z\.infer<typeof ConfigSchema>;/);
    expect(body).toMatch(/export type R2Config = NonNullable<Config\['r2'\]>;/);
    expect(body).toMatch(/export type PostmarkConfig = NonNullable<Config\['postmark'\]>;/);
    expect(body).toMatch(/export type SentryConfig = NonNullable<Config\['sentry'\]>;/);
  });

  it('loadConfig: signature defaults env to process.env', () => {
    expect(body).toMatch(
      /export function loadConfig\(env: NodeJS\.ProcessEnv = process\.env\): Config/,
    );
  });

  it('imports: zod only (no other deps — schema is the source of truth)', () => {
    expect(body).toMatch(/^import \{ z \} from 'zod';$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
