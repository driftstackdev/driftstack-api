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
  },
): {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
} {
  let client = postgres(databaseUrl, {
    max: opts?.max ?? 10,
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
