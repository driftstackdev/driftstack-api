// V-113: postgres-js slow-query log instrumentation.
//
// Hooks into `client.unsafe(sql, params)` — the path drizzle-orm uses
// for every parameterized query. Times the resulting Pending and emits
// a structured warn-level log entry whenever duration ≥ threshold.
//
// Tagged-template direct queries (`sql\`SELECT 1\``) are NOT
// instrumented. The control plane uses tagged-template form only at
// boot (`bootstrap.ts` SELECT 1 probe) and during migrations; both are
// outside the request critical path so the gap is acceptable.
//
// Wire via `createDb(url, { slowQueryLog: { thresholdMs, logger } })`.
// `bootstrap.ts` reads `SLOW_QUERY_LOG_THRESHOLD_MS` from env and
// only enables instrumentation when set (i.e. dev/test default off).
//
// Why a Proxy on Pending and not `await`-wrapping unsafe directly:
// postgres-js's Pending<T> is also a chainable cursor object exposing
// `.cursor()`, `.execute()`, `.values()`, etc. drizzle-orm awaits it
// directly today, but the safer wrapping preserves the full Pending
// surface for any future code path (or query type) that uses those
// chained methods.

import type postgres from 'postgres';
import type { Logger } from './logger.js';

export interface SlowQueryLogConfig {
  /** Duration in ms at or above which a query is considered slow. */
  thresholdMs: number;
  logger: Logger;
  /** Truncate logged SQL longer than this many chars (default 500). */
  maxSqlLength?: number;
}

const DEFAULT_MAX_SQL_LENGTH = 500;

/**
 * Mutate `client.unsafe` so postgres-js queries above `thresholdMs`
 * emit a structured warn-level slow_query log. Returns the same client
 * for fluent chaining.
 */
export function instrumentSlowQueryLogging(
  client: postgres.Sql,
  config: SlowQueryLogConfig,
): postgres.Sql {
  const maxSqlLength = config.maxSqlLength ?? DEFAULT_MAX_SQL_LENGTH;
  const originalUnsafe = client.unsafe.bind(client);

  // postgres-js exposes `unsafe` as a property on the Sql callable; we
  // replace it with a wrapper that times the resulting Pending. Cast
  // through `unknown` because the postgres-js type definition for
  // `unsafe` carries generic overloads we can't easily replicate.
  (client as unknown as { unsafe: typeof originalUnsafe }).unsafe = ((
    sql: string,
    params?: unknown[],
    options?: Parameters<typeof originalUnsafe>[2],
  ) => {
    const startedAt = performance.now();
    const pending = originalUnsafe(sql, params as never, options as never);

    return new Proxy(pending as object, {
      get(target, prop, receiver) {
        if (prop === 'then') {
          return (
            onFulfilled?: ((value: unknown) => unknown) | null,
            onRejected?: ((reason: unknown) => unknown) | null,
          ) => {
            return (target as PromiseLike<unknown>).then((value) => {
              const durationMs = performance.now() - startedAt;
              if (durationMs >= config.thresholdMs) {
                config.logger.warn(
                  {
                    component: 'db',
                    event: 'slow_query',
                    durationMs: Math.round(durationMs * 100) / 100,
                    thresholdMs: config.thresholdMs,
                    sql: sql.length > maxSqlLength ? `${sql.slice(0, maxSqlLength)}…` : sql,
                    paramCount: params?.length ?? 0,
                  },
                  'Slow query exceeded threshold',
                );
              }
              return onFulfilled ? onFulfilled(value) : value;
            }, onRejected ?? undefined);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as typeof pending;
  }) as typeof originalUnsafe;

  return client;
}
