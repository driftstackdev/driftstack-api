// W391.A — drift guard for apps/server/src/lib/logger.ts.
// V-494 defense-in-depth log redaction. Pino dot-paths cannot
// wildcard-match every nested location, so the redact-paths list is
// the load-bearing artefact. New sensitive fields MUST be added here
// AND mirrored in `lib/sentry.ts::beforeSend` whenever a
// request/response shape gains them. Drift here leaks secrets to
// stdout (and downstream log aggregator).
//
//   • V-494 redact framing pinned ("defense-in-depth" + "new sensitive
//     fields MUST be added here" mirror-with-sentry requirement).
//   • Logger type re-exported as pino's Logger (Fastify-compat note).
//   • base.service = 'driftstack-api' + isoTime timestamp.
//   • Censor placeholder: '[redacted]'.
//   • Redact paths cover auth headers, direct fields, request-body
//     auth+MFA+password, response-body enrolment/mint surfaces.
//   • formatters.level: object form so the level appears as a top-
//     level structured field, not pino's numeric default.
//   • createTestLogger: level=silent (tests don't spam stdout).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/logger.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W391.A apps/server/src/lib/logger.ts content parity', () => {
  const body = read(LIB);

  it('Logger type re-exports pino.Logger (FastifyBaseLogger structurally subset note)', () => {
    expect(body).toMatch(
      /We re-export pino's Logger as our `Logger` type\. Fastify's FastifyBaseLogger\s*\n?\s*\/\/\s*is structurally a subset of pino's Logger, so passing a pino instance to\s*\n?\s*\/\/\s*Fastify's `loggerInstance` works/,
    );
    expect(body).toMatch(/export type Logger = PinoLogger;/);
  });

  it('createLogger: signature picks only logLevel + nodeEnv from Config (loose coupling)', () => {
    expect(body).toMatch(
      /export function createLogger\(config: Pick<Config, 'logLevel' \| 'nodeEnv'>\): Logger/,
    );
  });

  it('pino base config: level + base.service="driftstack-api" + isoTime timestamp', () => {
    expect(body).toMatch(/level: config\.logLevel,/);
    expect(body).toMatch(/base: \{ service: 'driftstack-api' \},/);
    expect(body).toMatch(/timestamp: pino\.stdTimeFunctions\.isoTime,/);
  });

  it('V-494 framing: defense-in-depth + sentry.ts mirror requirement pinned', () => {
    expect(body).toMatch(
      /V-494 — defense-in-depth log redaction\. Pino dot-paths cannot\s*\n?\s*\/\/\s*wildcard-match every nested location, so we list the known\s*\n?\s*\/\/\s*fields\. New sensitive fields MUST be added here whenever a\s*\n?\s*\/\/\s*request\/response shape gains them\. Mirrored in\s*\n?\s*\/\/\s*`lib\/sentry\.ts::beforeSend` so Sentry captures don't carry\s*\n?\s*\/\/\s*secrets even when pino is bypassed/,
    );
  });

  it('redact: censor placeholder = "[redacted]"', () => {
    expect(body).toMatch(/censor: '\[redacted\]',/);
  });

  it('redact paths: auth headers — authorization, cookie, set-cookie, stripe-signature', () => {
    expect(body).toMatch(/'req\.headers\.authorization',/);
    expect(body).toMatch(/'req\.headers\.cookie',/);
    expect(body).toMatch(/'res\.headers\["set-cookie"\]',/);
    expect(body).toMatch(/'req\.headers\["stripe-signature"\]',/);
  });

  it('redact paths: direct fields — apiKey / plaintext / secret / signingSecret / webhookSecret', () => {
    expect(body).toMatch(/'apiKey',/);
    expect(body).toMatch(/'plaintext',/);
    expect(body).toMatch(/'body\.plaintext',/);
    expect(body).toMatch(/'secret',/);
    expect(body).toMatch(/'signingSecret',/);
    expect(body).toMatch(/'webhookSecret',/);
  });

  it('redact paths: request-body auth + MFA + password — includes challenge bearer spellings', () => {
    expect(body).toMatch(/'body\.password',/);
    expect(body).toMatch(/'body\.new_password',/);
    expect(body).toMatch(/'body\.current_password',/);
    expect(body).toMatch(/'body\.code',/);
    expect(body).toMatch(/'body\.recovery_code',/);
    expect(body).toMatch(/'body\.recovery_codes',/);
    expect(body).toMatch(/'body\.challenge_token',/);
    expect(body).toMatch(/'body\.challengeToken',/);
    expect(body).toMatch(/'body\.signing_secret',/);
    expect(body).toMatch(/'body\.secret',/);
  });

  it('redact paths: response-body enrolment/mint surfaces — includes challenge bearer spellings', () => {
    expect(body).toMatch(/'recovery_codes',/);
    expect(body).toMatch(/'recoveryCodes',/);
    expect(body).toMatch(/'challenge_token',/);
    expect(body).toMatch(/'challengeToken',/);
    expect(body).toMatch(/'totpSecret',/);
    expect(body).toMatch(/'totp_secret',/);
    expect(body).toMatch(/'mfaSecret',/);
    expect(body).toMatch(/'client_secret',/);
  });

  it('redact paths: OAuth token fields — body.token (introspect/revoke request) + access_token + refresh_token (token-endpoint response)', () => {
    expect(body).toMatch(/'body\.token',/);
    expect(body).toMatch(/'access_token',/);
    expect(body).toMatch(/'refresh_token',/);
  });

  it('formatters.level: object-form ({ level: label }) so level surfaces as a structured field', () => {
    expect(body).toMatch(
      /formatters: \{\s*\n?\s*level: \(label\) => \(\{ level: label \}\),\s*\n?\s*\},/,
    );
  });

  it('createTestLogger: level="silent" (tests don\'t spam stdout)', () => {
    expect(body).toMatch(
      /export function createTestLogger\(\): Logger \{\s*\n?\s*return pino\(\{ level: 'silent' \}\);\s*\n?\s*\}/,
    );
  });

  it('imports: pino default + type Logger as PinoLogger + Config type + redactText', () => {
    expect(body).toMatch(/import pino, \{ type Logger as PinoLogger \} from 'pino';/);
    expect(body).toMatch(/import type \{ Config \} from '\.\/config\.js';/);
    expect(body).toMatch(
      /import \{ redactUrlQueryTokens, redactText \} from '\.\/redact-url\.js';/,
    );
  });

  it('V-494 err serializer: redactErrSerializer recursively scrubs EVERY string value (message+stack+detail+extensions+nested cause/config) and is WIRED into serializers.err (free-text token leak in a caught error)', () => {
    // The function exists + recursively redacts all string values (not just
    // message+stack — ApiError.detail/extensions + a nested upstream error's
    // cause/config bypassed the old message+stack-only redaction).
    expect(body).toMatch(/export function redactErrSerializer\(/);
    expect(body).toMatch(/return redactErrValue\(base, 0, new WeakSet<object>\(\)\)/);
    // The recursive helper redacts every string + fails closed at its depth/cycle
    // boundary; redactText is a no-op on clean strings.
    expect(body).toMatch(/if \(typeof value === 'string'\) return redactText\(value\)/);
    expect(body).toMatch(
      /if \(depth >= MAX_ERR_REDACT_DEPTH \|\| seen\.has\(value\)\) return REDACTED_ERR_STRUCTURE/,
    );
    expect(body).toMatch(/new WeakSet<object>\(\)/);
    expect(body).toMatch(/const SENSITIVE_ERR_KEYS = new Set\(\[/);
    expect(body).toMatch(
      /out\[k\] = isSensitiveErrKey\(k\) \? '\[redacted\]' : redactErrValue\(v, depth \+ 1, seen\)/,
    );
    // ...AND is actually wired into the pino serializers (else the leak returns
    // even though the function exists — the behavioral test wouldn't catch an
    // un-wiring since it calls the function directly).
    expect(body).toMatch(/err: redactErrSerializer,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
