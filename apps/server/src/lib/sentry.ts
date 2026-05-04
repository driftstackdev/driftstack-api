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

export interface SentryBreadcrumb {
  /** Logical category, e.g. `'http.request'`, `'auth'`, `'billing'`. */
  category: string;
  /** Human-readable message. Keep short — Sentry truncates long messages. */
  message: string;
  /** Optional structured data attached to the breadcrumb. */
  data?: Record<string, unknown>;
  /** Severity level. Defaults to `'info'` if omitted. */
  level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
}

export interface SentryClient {
  captureException(err: unknown, context?: Record<string, unknown>): void;
  /**
   * Append a breadcrumb to the current Sentry scope. When the next
   * exception fires (whether via captureException or an unhandled
   * throw caught by the Fastify error hook), Sentry attaches the
   * recent breadcrumb trail to the event for richer context.
   *
   * No-op when Sentry is not initialized.
   */
  addBreadcrumb(crumb: SentryBreadcrumb): void;
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
      addBreadcrumb: () => {},
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
    addBreadcrumb(crumb) {
      try {
        Sentry.addBreadcrumb({
          category: crumb.category,
          message: crumb.message,
          level: crumb.level ?? 'info',
          ...(crumb.data !== undefined ? { data: crumb.data } : {}),
        });
      } catch (sentryErr) {
        logger.warn(
          {
            component: 'sentry',
            err:
              sentryErr instanceof Error
                ? { name: sentryErr.name, message: sentryErr.message }
                : { value: sentryErr },
          },
          'Sentry addBreadcrumb failed (fire-and-forget)',
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

/**
 * Install Fastify `onRequest` + `onResponse` hooks that record per-request
 * breadcrumbs to Sentry. When an exception fires later in the request
 * lifecycle (caught by `onError`), Sentry attaches the breadcrumb trail —
 * giving the captured event "what happened just before this errored"
 * context (request method, URL, response status, duration).
 *
 * No-op when `sentry.isInitialized` is false — the hooks run but
 * `addBreadcrumb` is a no-op so there's no observable cost.
 */
export function wireSentryRequestBreadcrumbs(app: FastifyInstance, sentry: SentryClient): void {
  // Per-request start timestamp (in ms via performance.now()) — attached
  // to the FastifyRequest as a Symbol-keyed field so we don't pollute
  // the public request shape.
  const startedAtKey = Symbol('sentryRequestStart');

  app.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as Record<symbol, number>)[startedAtKey] = performance.now();
    sentry.addBreadcrumb({
      category: 'http.request',
      message: `${request.method} ${request.url}`,
      level: 'info',
      data: {
        request_id: request.id,
        method: request.method,
        url: request.url,
      },
    });
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const startedAt = (request as unknown as Record<symbol, number | undefined>)[startedAtKey];
    const durationMs =
      typeof startedAt === 'number'
        ? Math.round((performance.now() - startedAt) * 100) / 100
        : undefined;
    sentry.addBreadcrumb({
      category: 'http.response',
      message: `${reply.statusCode} ${request.method} ${request.url}`,
      level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warning' : 'info',
      data: {
        request_id: request.id,
        method: request.method,
        url: request.url,
        status_code: reply.statusCode,
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      },
    });
    done();
  });
}
