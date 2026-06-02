import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { instrumentSlowQueryLogging, type SlowQueryLogConfig } from '../lib/slow-query-log.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(
  databaseUrl: string,
  opts?: {
    max?: number;
    /** When set, queries ≥ thresholdMs emit a warn-level slow_query log. */
    slowQueryLog?: SlowQueryLogConfig;
    /**
     * When set, applies a per-connection Postgres `statement_timeout` (ms) so a
     * single runaway query is cancelled rather than holding a pool slot
     * forever (which would exhaust the pool). Off when undefined. Wired from
     * DB_STATEMENT_TIMEOUT_MS on the app path only — migrate.ts uses its own
     * postgres({ max: 1 }) client, so long DDL is never capped.
     */
    statementTimeoutMs?: number;
  },
): {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
} {
  let client = postgres(databaseUrl, {
    max: opts?.max ?? 10,
    // Per-connection statement_timeout (ms) when the app opts in via
    // DB_STATEMENT_TIMEOUT_MS — bounds runaway queries so they can't exhaust
    // the pool. Omitted (no key) when unset = Postgres default (no timeout).
    // postgres-js types this connection param as a number (ms).
    ...(opts?.statementTimeoutMs !== undefined
      ? { connection: { statement_timeout: opts.statementTimeoutMs } }
      : {}),
    onnotice: () => {
      /* swallow Postgres NOTICE messages — Pino logger handles real ops */
    },
  });
  if (opts?.slowQueryLog) {
    client = instrumentSlowQueryLogging(client, opts.slowQueryLog);
  }
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

export { schema };
