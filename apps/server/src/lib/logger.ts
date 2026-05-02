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
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'apiKey',
        'plaintext',
        'body.plaintext',
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
