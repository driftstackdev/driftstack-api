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
import { redactUrlQueryTokens, redactQueryString, redactText } from './redact-url.js';

// V-494 — sensitive-key denylist for Sentry event scrubbing. Keep in
// sync with `lib/logger.ts::redact.paths`. Match is case-insensitive
// on the bare key name (no path prefix); Sentry events have many
// envelope shapes (request.data, breadcrumbs[*].data, extra,
// contexts.*) so substring/key matching is more robust than dot-paths.
// All entries lowercase — comparison is `key.toLowerCase()` so storing
// non-lowercase variants here is dead weight (and a bug if the comparison
// ever drifts). Tests pin both case-sensitive and case-insensitive paths.
const SENTRY_SENSITIVE_KEYS = new Set<string>([
  'authorization',
  'cookie',
  'set-cookie',
  'stripe-signature',
  'password',
  'new_password',
  'current_password',
  'newpassword',
  'currentpassword',
  'code',
  'recovery_code',
  'recovery_codes',
  'recoverycode',
  'recoverycodes',
  // Five-minute, single-use MFA challenge bearer. Keep both spellings because
  // isSensitiveKey lowercases but intentionally does not strip separators.
  'challenge_token',
  'challengetoken',
  'debug_token',
  'debugtoken',
  'session_token',
  'sessiontoken',
  'apikey',
  'api_key',
  'plaintext',
  'secret',
  'signing_secret',
  'signingsecret',
  'webhooksecret',
  'webhook_secret',
  'totp_secret',
  'totpsecret',
  'mfasecret',
  'otpauth_uri',
  'otpauthuri',
  'secret_base32',
  'secretbase32',
  'client_secret',
  'clientsecret',
  // Account-proxy VPN secrets (ARC A) — mirror of the lib/logger.ts
  // body.openvpn.config_blob / body.wireguard.private_key redaction.
  // The OpenVPN config_blob embeds certs + private keys; the WireGuard
  // private_key is the tunnel key. Bare-key match scrubs them wherever
  // a captured request body surfaces them (request.data / breadcrumbs).
  // (The nested openvpn.password is already covered by 'password'.)
  'config_blob',
  'configblob',
  'private_key',
  'privatekey',
  // Arc 7 obs.2.b — v2-#8 BYOK + gui_control_key Sentry mirror of
  // the lib/logger.ts redact-paths extension. Match keys are
  // lowercase + hyphen/underscore variants (the
  // SENTRY_SENSITIVE_KEYS Set is compared via key.toLowerCase()).
  'x-byok-anthropic-api-key',
  'byokanthropicapikey',
  'gui_control_key',
  'guicontrolkey',
  // gui_control_key per-session control header (mirror of the
  // lib/logger.ts req.headers redaction). The separate simulator app
  // presents the live control key here; scrub it from any captured
  // request headers / breadcrumbs.
  'x-driftstack-gui-control-key',
  // OAuth token fields — mirror of the lib/logger.ts token redaction.
  // OAuth introspect/revoke take `{ token }` in the request body; the
  // token endpoint returns `{ access_token, refresh_token }`. Bare
  // exact-key match (the `?ds_token=`/`?code=` URL form is handled
  // separately by redactUrlQueryTokens in scrubSentryEvent).
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'idtoken',
  'code_verifier',
  'codeverifier',
  // OAuth start URL embeds the signed state handshake token.
  'authorize_url',
  'authorizeurl',
]);

function isSensitiveKey(key: string): boolean {
  return SENTRY_SENSITIVE_KEYS.has(key.toLowerCase());
}

/**
 * V-494 — recursively walk a Sentry event-shaped value and replace
 * sensitive field values with `'[redacted]'`. Mutates in place to
 * avoid allocating a parallel object tree on every event. Over-depth
 * and cyclic subtrees are replaced with a fixed sentinel; merely stopping
 * traversal would leave deeper credentials attached for Sentry to serialize.
 */
const MAX_SENTRY_SCRUB_DEPTH = 8;
const REDACTED_SENTRY_STRUCTURE = '[redacted: structure limit]';
function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_SENTRY_SCRUB_DEPTH || seen.has(value)) return REDACTED_SENTRY_STRUCTURE;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubValue(value[index], depth + 1, seen);
    }
    seen.delete(value);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (isSensitiveKey(key)) {
      obj[key] = '[redacted]';
    } else {
      obj[key] = scrubValue(obj[key], depth + 1, seen);
    }
  }
  seen.delete(value);
  return value;
}
function scrubInPlace(value: unknown): void {
  scrubValue(value, 0, new WeakSet<object>());
}

function scrubSentryEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // V-494 follow-up — strip credential-bearing query params (the SSE
  // `?ds_token=`, the OAuth `?code=`, …) from the request URL string.
  // scrubInPlace only redacts VALUES by sensitive KEY name; a token
  // embedded inside the url/query_string STRING isn't caught by that, so
  // sanitize those two fields explicitly. See lib/redact-url.ts.
  if (event.request) {
    if (typeof event.request.url === 'string') {
      event.request.url = redactUrlQueryTokens(event.request.url);
    }
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = redactQueryString(event.request.query_string);
    }
  }
  scrubInPlace(event.request);
  scrubInPlace(event.extra);
  scrubInPlace(event.contexts);
  scrubInPlace(event.breadcrumbs);
  // A token can also ride inside the EXCEPTION MESSAGE / captureMessage as free
  // text (e.g. a thrown error citing an upstream URL `...?ds_token=` /
  // `?code=`, or a `Bearer <token>` fragment). scrubInPlace only redacts VALUES
  // by sensitive KEY name, and the url-parsers only touch request.url /
  // query_string — neither catches a credential embedded in the message string.
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') ex.value = redactText(ex.value);
    }
  }
  if (typeof event.message === 'string') event.message = redactText(event.message);
  return event;
}

function scrubSentryBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  scrubInPlace(crumb.data);
  // The breadcrumb message is free text — redact any embedded credential token
  // (same vector as the exception message; scrubInPlace only redacts data
  // values by key name).
  if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message);
  return crumb;
}

// V-494 — exposed under a `__test_*` name so the unit test in
// tests/unit/sentry-scrub.test.ts can pin the redaction matrix.
// Not part of the public sentry-helper surface.
export { scrubInPlace as __test_scrubInPlace };
export { scrubSentryEvent as __test_scrubSentryEvent };

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
    // V-494 — secret-stripping filter mirrored from
    // `lib/logger.ts::redact`. Sentry events carry request data,
    // breadcrumb data, and `extra` context — any of those can leak
    // a password / TOTP code / webhook secret if upstream code logs
    // the wrong field. beforeSend walks the event recursively and
    // redacts known-sensitive keys.
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
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
      url: redactUrlQueryTokens(request.url),
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
      message: `${request.method} ${redactUrlQueryTokens(request.url)}`,
      level: 'info',
      data: {
        request_id: request.id,
        method: request.method,
        url: redactUrlQueryTokens(request.url),
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
      message: `${reply.statusCode} ${request.method} ${redactUrlQueryTokens(request.url)}`,
      level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warning' : 'info',
      data: {
        request_id: request.id,
        method: request.method,
        url: redactUrlQueryTokens(request.url),
        status_code: reply.statusCode,
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      },
    });
    done();
  });
}
