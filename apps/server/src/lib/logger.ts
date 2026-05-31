import pino, { type Logger as PinoLogger } from 'pino';
import type { Config } from './config.js';
import { redactUrlQueryTokens } from './redact-url.js';

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
        // Arc 7 obs.2 — v2-#8 BYOK per-request header. Customers'
        // Anthropic keys arrive in this header on agent-session
        // message turns; MUST scrub even though the route never
        // logs req.headers explicitly (defense-in-depth: a future
        // refactor that adds a request-trace log would otherwise
        // leak the key).
        'req.headers["x-byok-anthropic-api-key"]',
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
        // Arc 7 obs.2 — v2-#8 BYOK PUT body field. The PUT
        // /v1/account/me/byok-anthropic-key route accepts the key
        // as { api_key: 'sk-ant-...' }. Same defense-in-depth as
        // the header above.
        'body.api_key',
        // Arc 7 obs.2 — v2-#8 sub-slice 8.4 gui_control_key.
        // Auto-minted per pair-mode session; surfaces in the
        // response payload as the plaintext (shown once). If a
        // future route adds the field on a request body too,
        // these glob the camelCase + snake_case variants.
        'gui_control_key',
        'guiControlKey',
        'body.gui_control_key',
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
    // V-494 follow-up — Fastify's built-in request log records `req.url`,
    // which for the SSE/EventSource path includes the bearer token as
    // `?ds_token=` (and the OAuth callback's single-use `?code=`). Header +
    // cookie redaction above doesn't reach values embedded in the URL
    // string, so sanitize the logged URL here. Mirrors Fastify 5's default
    // req serializer shape (method/url/host/remoteAddress/remotePort);
    // verified that Fastify uses the loggerInstance's `req` serializer for
    // its auto request logging. The Sentry side is handled in
    // lib/sentry.ts (event.request.url / query_string).
    serializers: {
      req(req: {
        method?: string;
        url?: string;
        host?: string;
        ip?: string;
        socket?: { remotePort?: number };
      }) {
        return {
          method: req.method,
          url: typeof req.url === 'string' ? redactUrlQueryTokens(req.url) : req.url,
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
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
