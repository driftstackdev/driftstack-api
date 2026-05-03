// Sentry initialization helper.
//
// Init at boot from `config.sentry`. EU-region DSN enforced by Zod
// (docs/deployment/env-vars.md validation checklist) — DSN must
// contain `.de.` so the SDK posts to ingest.de.sentry.io rather than
// the US default. Source-map upload happens at deploy time (handled
// by the GitHub Actions workflow once the build emits maps); this
// module just initialises the runtime client.
//
// Fire-and-forget: Sentry is never on the request critical path.
// `captureException` returns a Promise<void> from the SDK; we don't
// await it. If Sentry is down, errors are dropped — visible only in
// the Pino structured logs (which Sentry would normally bridge from).
//
// Fastify error-handler bridge: `wireSentryErrorHandler(app, sentry)`
// installs an `onError` hook that captures the exception with the
// request context (URL, method, request-id) attached.

import * as Sentry from '@sentry/node';
import type { FastifyInstance } from 'fastify';
import type { SentryConfig } from './config.js';
import type { Logger } from './logger.js';

export interface SentryClient {
  captureException(err: unknown, context?: Record<string, unknown>): void;
  flush(timeoutMs?: number): Promise<boolean>;
  close(timeoutMs?: number): Promise<boolean>;
  readonly isInitialized: boolean;
}

export interface InitSentryArgs {
  config: SentryConfig | null;
  logger: Logger;
}

export function initSentry({ config, logger }: InitSentryArgs): SentryClient {
  if (config === null) {
    logger.warn(
      { component: 'sentry' },
      'Sentry not configured — exception capture disabled. Set SENTRY_DSN + SENTRY_ENVIRONMENT to enable.',
    );
    return {
      isInitialized: false,
      captureException: () => {},
      flush: () => Promise.resolve(true),
      close: () => Promise.resolve(true),
    };
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release !== undefined ? { release: config.release } : {}),
    tracesSampleRate: config.tracesSampleRate,
    // Default integrations include http + console + onUncaughtException +
    // onUnhandledRejection — exactly what we want for a Node service.
  });

  logger.info(
    {
      component: 'sentry',
      environment: config.environment,
      release: config.release ?? null,
      tracesSampleRate: config.tracesSampleRate,
    },
    'Sentry initialized',
  );

  return {
    isInitialized: true,
    captureException(err, context) {
      try {
        Sentry.captureException(err, context !== undefined ? { extra: context } : undefined);
      } catch (sentryErr) {
        logger.warn(
          {
            component: 'sentry',
            err:
              sentryErr instanceof Error
                ? { name: sentryErr.name, message: sentryErr.message }
                : { value: sentryErr },
          },
          'Sentry captureException failed (fire-and-forget)',
        );
      }
    },
    flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
    close: (timeoutMs = 2000) => Sentry.close(timeoutMs),
  };
}

/**
 * Install a Fastify `onError` hook that captures exceptions to Sentry
 * with request context attached. Idempotent if `sentry.isInitialized`
 * is false — the hook runs but does nothing.
 */
export function wireSentryErrorHandler(app: FastifyInstance, sentry: SentryClient): void {
  app.addHook('onError', (request, _reply, error, done) => {
    sentry.captureException(error, {
      request_id: request.id,
      method: request.method,
      url: request.url,
      route: request.routeOptions?.url,
    });
    done();
  });
}
