import type { Config } from 'drizzle-kit';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://driftstack:driftstack@localhost:5432/driftstack';

export default {
  schema: './apps/server/src/db/schema.ts',
  out: './apps/server/src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
} satisfies Config;
