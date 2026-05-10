import pino, { type Logger as PinoLogger } from 'pino';
import type { Config } from './config.js';

// We re-export pino's Logger as our `Logger` type. Fastify's FastifyBaseLogger
// is structurally a subset of pino's Logger, so passing a pino instance to
// Fastify's `loggerInstance` works; we cast at the boundary in app.ts to
// satisfy Fastify's narrower expected type.
export type Logger = PinoLogger;

export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>): Logger {
  const isDev = config.nodeEnv !== 'production';

  return pino({
    level: config.logLevel,
    base: { service: 'driftstack-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // V-494 — defense-in-depth log redaction. Pino dot-paths cannot
    // wildcard-match every nested location, so we list the known
    // fields. New sensitive fields MUST be added here whenever a
    // request/response shape gains them. Mirrored in
    // `lib/sentry.ts::beforeSend` so Sentry captures don't carry
    // secrets even when pino is bypassed.
    redact: {
      paths: [
        // Auth headers
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.headers["stripe-signature"]',
        // Direct fields seen on objects logged inline
        'apiKey',
        'plaintext',
        'body.plaintext',
        'secret',
        'signingSecret',
        'webhookSecret',
        // Request-body fields on auth + MFA + password flows
        'body.password',
        'body.new_password',
        'body.current_password',
        'body.code',
        'body.recovery_code',
        'body.recovery_codes',
        'body.signing_secret',
        'body.secret',
        // Response-body fields surfaced on enrolment / mint paths
        'recovery_codes',
        'recoveryCodes',
        'totpSecret',
        'totp_secret',
        'mfaSecret',
        'client_secret',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(isDev
      ? {
          // Pretty output in dev iff pino-pretty is installed; otherwise plain JSON.
          // We don't add the dep yet — JSON is fine for inspecting via jq.
        }
      : {}),
  });
}

export function createTestLogger(): Logger {
  return pino({ level: 'silent' });
}
