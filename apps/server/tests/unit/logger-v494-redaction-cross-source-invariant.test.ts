// W968 — V-494 logger redaction cross-source invariant. Two-hundred-
// ninety-fourth in the drift-guard series. Pins the logger
// redaction-paths primitive:
//
//   Logger type alias — 'We re-export pino's Logger as our Logger
//   type. Fastify's FastifyBaseLogger is structurally a subset of
//   pino's Logger, so passing a pino instance to Fastify's
//   loggerInstance works; we cast at the boundary in app.ts to
//   satisfy Fastify's narrower expected type'.
//
//   V-494 framing — 'V-494 — defense-in-depth log redaction. Pino
//   dot-paths cannot wildcard-match every nested location, so we
//   list the known fields. New sensitive fields MUST be added here
//   whenever a request/response shape gains them. Mirrored in
//   lib/sentry.ts::beforeSend so Sentry captures don't carry
//   secrets even when pino is bypassed'.
//
//   Redaction paths (4 categories):
//     1. Auth headers — authorization + cookie + set-cookie +
//        stripe-signature.
//     2. Direct fields on inline-logged objects — apiKey +
//        plaintext + body.plaintext + secret + signingSecret +
//        webhookSecret.
//     3. Request-body auth/MFA/password fields — body.password +
//        body.new_password + body.current_password + body.code +
//        body.recovery_code + body.recovery_codes +
//        body.signing_secret + body.secret.
//     4. Response-body enrolment/mint fields — recovery_codes +
//        recoveryCodes + totpSecret + totp_secret + mfaSecret +
//        client_secret.
//
//   censor: '[redacted]' (matches Sentry sanitizer convention).
//
//   pino config:
//     - level from config.logLevel.
//     - base { service: 'driftstack-api' }.
//     - timestamp: pino.stdTimeFunctions.isoTime.
//     - formatters.level returns { level: label }.
//
//   createLogger(config) signature — Pick<Config, 'logLevel' |
//     'nodeEnv'>.
//
//   createTestLogger() — pino({ level: 'silent' }).
//
// stays in lockstep across apps/server/src/lib/logger.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W968 V-494 logger redaction cross-source invariant', () => {
  // ─── Pino re-export + Fastify-subset framing ─────────────────

  it("CRITICAL apps/server/src/lib/logger.ts header pins surface — 'We re-export pino's Logger as our Logger type. Fastify's FastifyBaseLogger is structurally a subset of pino's Logger, so passing a pino instance to Fastify's loggerInstance works; we cast at the boundary in app.ts to satisfy Fastify's narrower expected type'. The cast-at-boundary design avoids leaking pino across the service contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(
      /We re-export pino's Logger as our `Logger` type\. Fastify's FastifyBaseLogger/,
    );
    expect(p).toMatch(/is structurally a subset of pino's Logger, so passing a pino instance to/);
    expect(p).toMatch(/Fastify's `loggerInstance` works; we cast at the boundary in app\.ts to/);
    expect(p).toMatch(/satisfy Fastify's narrower expected type\./);
  });

  // ─── Logger type alias ───────────────────────────────────────

  it('CRITICAL Logger = PinoLogger re-export — `export type Logger = PinoLogger;`. The single-symbol-name lets services type-annotate without pino import.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/import pino, \{ type Logger as PinoLogger \} from 'pino';/);
    expect(p).toMatch(/export type Logger = PinoLogger;/);
  });

  // ─── V-494 redaction framing ─────────────────────────────────

  it("CRITICAL V-494 framing — 'V-494 — defense-in-depth log redaction. Pino dot-paths cannot wildcard-match every nested location, so we list the known fields. New sensitive fields MUST be added here whenever a request/response shape gains them. Mirrored in lib/sentry.ts::beforeSend so Sentry captures don't carry secrets even when pino is bypassed'. The MUST-add-on-new-fields + Sentry-mirror is the V-494 policy contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/V-494 — defense-in-depth log redaction\. Pino dot-paths cannot/);
    expect(p).toMatch(/wildcard-match every nested location, so we list the known/);
    expect(p).toMatch(/fields\. New sensitive fields MUST be added here whenever a/);
    expect(p).toMatch(/request\/response shape gains them\. Mirrored in/);
    expect(p).toMatch(/`lib\/sentry\.ts::beforeSend` so Sentry captures don't carry/);
    expect(p).toMatch(/secrets even when pino is bypassed\./);
  });

  // ─── 4 auth-header redaction paths ───────────────────────────

  it("CRITICAL 4 auth-header redaction paths — 'req.headers.authorization' + 'req.headers.cookie' + 'res.headers[\"set-cookie\"]' + 'req.headers[\"stripe-signature\"]'. The 4-header set covers Bearer + Cookie + Set-Cookie + Stripe IPN headers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'req\.headers\.authorization',/);
    expect(p).toMatch(/'req\.headers\.cookie',/);
    expect(p).toMatch(/'res\.headers\["set-cookie"\]',/);
    expect(p).toMatch(/'req\.headers\["stripe-signature"\]',/);
  });

  // ─── 6 direct-field redaction paths ──────────────────────────

  it("CRITICAL 6 direct-field redaction paths on inline-logged objects — 'apiKey' + 'plaintext' + 'body.plaintext' + 'secret' + 'signingSecret' + 'webhookSecret'. The direct-fields set covers ad-hoc inline logs of credential-bearing objects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'apiKey',/);
    expect(p).toMatch(/'plaintext',/);
    expect(p).toMatch(/'body\.plaintext',/);
    expect(p).toMatch(/'secret',/);
    expect(p).toMatch(/'signingSecret',/);
    expect(p).toMatch(/'webhookSecret',/);
  });

  // ─── 8 request-body redaction paths ──────────────────────────

  it('CRITICAL 8 request-body redaction paths for auth/MFA/password flows — body.password + body.new_password + body.current_password + body.code + body.recovery_code + body.recovery_codes + body.signing_secret + body.secret. The body.* paths cover sign-up + login + MFA + webhook + reset request-shapes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'body\.password',/);
    expect(p).toMatch(/'body\.new_password',/);
    expect(p).toMatch(/'body\.current_password',/);
    expect(p).toMatch(/'body\.code',/);
    expect(p).toMatch(/'body\.recovery_code',/);
    expect(p).toMatch(/'body\.recovery_codes',/);
    expect(p).toMatch(/'body\.signing_secret',/);
    expect(p).toMatch(/'body\.secret',/);
  });

  // ─── 6 response-body redaction paths ─────────────────────────

  it("CRITICAL 6 response-body redaction paths surfaced on enrolment/mint paths — 'recovery_codes' + 'recoveryCodes' + 'totpSecret' + 'totp_secret' + 'mfaSecret' + 'client_secret'. The snake-case + camelCase doubles cover both API + DB-mapped response shapes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'recovery_codes',/);
    expect(p).toMatch(/'recoveryCodes',/);
    expect(p).toMatch(/'totpSecret',/);
    expect(p).toMatch(/'totp_secret',/);
    expect(p).toMatch(/'mfaSecret',/);
    expect(p).toMatch(/'client_secret',/);
  });

  // ─── OAuth token redaction paths ─────────────────────────────

  it("CRITICAL OAuth token redaction paths — 'body.token' (introspect/revoke request body) + 'access_token' + 'refresh_token' (token-endpoint response). Without these a live OAuth token in a request body / response object could reach Pino logs (and, via the mirror invariant, Sentry) unredacted.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'body\.token',/);
    expect(p).toMatch(/'access_token',/);
    expect(p).toMatch(/'refresh_token',/);
  });

  it('CRITICAL MFA challenge bearer is redacted in request, response, and nested-error spellings', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'body\.challenge_token',/);
    expect(p).toMatch(/'body\.challengeToken',/);
    expect(p).toMatch(/'challenge_token',/);
    expect(p).toMatch(/'challengeToken',/);
    expect(p).toMatch(/'challengetoken',/);
  });

  // ─── '[redacted]' censor token ───────────────────────────────

  it("CRITICAL censor token = '[redacted]'. The bracket-redacted convention matches the Sentry sanitizer + customer-facing log expectations.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/censor: '\[redacted\]',/);
  });

  // ─── Arc 7 obs.2 — v2-#8 BYOK + gui_control_key redact paths ─

  it('CRITICAL Arc 7 obs.2 — BYOK per-request header redacted at req.headers["x-byok-anthropic-api-key"]. Drift to dropping would leak customer Anthropic keys in any future request-trace log.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'req\.headers\["x-byok-anthropic-api-key"\]',/);
  });

  it("CRITICAL Arc 7 obs.2 — BYOK PUT body field redacted at body.api_key. Drift to dropping would leak the customer's key in any request-body log line.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'body\.api_key',/);
  });

  it('CRITICAL Arc 7 obs.2 — v2-#8 sub-slice 8.4 gui_control_key plaintext redacted in snake_case + camelCase + body.* variants.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/'gui_control_key',/);
    expect(p).toMatch(/'guiControlKey',/);
    expect(p).toMatch(/'body\.gui_control_key',/);
  });

  // ─── pino config: base + timestamp + formatter ───────────────

  it("CRITICAL pino base config — { service: 'driftstack-api' } + timestamp pino.stdTimeFunctions.isoTime + formatters.level returns { level: label }. The service-base + ISO-timestamp + label-level shape is the structured-log canonical format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/base: \{ service: 'driftstack-api' \},/);
    expect(p).toMatch(/timestamp: pino\.stdTimeFunctions\.isoTime,/);
    expect(p).toMatch(/level: \(label\) => \(\{ level: label \}\),/);
  });

  // ─── createLogger signature ──────────────────────────────────

  it("CRITICAL createLogger signature — 'createLogger(config: Pick<Config, logLevel | nodeEnv>): Logger'. The Pick<Config, ...> argument is what makes createLogger boot-time-safe (no full Config required before logger is wired).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(
      /export function createLogger\(config: Pick<Config, 'logLevel' \| 'nodeEnv'>\): Logger \{/,
    );
  });

  // ─── createLogger isDev check ────────────────────────────────

  it("CRITICAL isDev = config.nodeEnv !== 'production'. The 2-value check distinguishes prod from non-prod for future pino-pretty wiring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/const isDev = config\.nodeEnv !== 'production';/);
  });

  it("CRITICAL pino-pretty isDev framing — 'Pretty output in dev iff pino-pretty is installed; otherwise plain JSON. We don't add the dep yet — JSON is fine for inspecting via jq'. The opt-in-via-installed + jq-default-acceptable framing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/Pretty output in dev iff pino-pretty is installed; otherwise plain JSON\./);
    expect(p).toMatch(/We don't add the dep yet — JSON is fine for inspecting via jq\./);
  });

  // ─── createTestLogger silent framing ─────────────────────────

  it("CRITICAL createTestLogger returns pino({ level: 'silent' }). The silent-level test logger keeps vitest output clean — no log output from services-under-test.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    expect(p).toMatch(/export function createTestLogger\(\): Logger \{/);
    expect(p).toMatch(/return pino\(\{ level: 'silent' \}\);/);
  });

  // ─── createTestLogger runtime ────────────────────────────────

  it('CRITICAL createTestLogger runtime — returns Pino-shaped Logger with info / warn / error / debug methods. The pino-API shape is what test services consume.', () => {
    const logger = createTestLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  // ─── Total redaction-path count check ────────────────────────

  it('CRITICAL total redaction paths = 4 (auth headers) + 6 (direct fields) + 8 (body) + 6 (response) = 24 paths. Mechanically counted via comma-separated entries in paths: [...].', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts'));
    const pathsBlock = p.match(/paths: \[([\s\S]+?)\n\s+\],/)?.[1] ?? '';
    // Match string entries (quoted singletons).
    const entries = pathsBlock.match(/'[^']+'/g) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(24);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/logger-v494-redaction-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
