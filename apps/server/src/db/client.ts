import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(
  databaseUrl: string,
  opts?: { max?: number },
): {
  client: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
} {
  const client = postgres(databaseUrl, {
    max: opts?.max ?? 10,
    onnotice: () => {
      /* swallow Postgres NOTICE messages — Pino logger handles real ops */
    },
  });
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
