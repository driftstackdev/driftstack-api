// W528.C — drift guard for /drizzle.config.ts.
// Drizzle-Kit config for the apps/server Postgres schema. Drift here
// either changes the schema location (would break `drizzle-kit
// generate` migration discovery) or changes the migrations output
// directory (would orphan generated migrations from the schema) or
// silently disables `strict`/`verbose` (would weaken migration-time
// schema-drift detection).
//
//   • schema: ./apps/server/src/db/schema.ts.
//   • out: ./apps/server/src/db/migrations.
//   • dialect: postgresql.
//   • dbCredentials.url: DATABASE_URL env var fallback to local docker-
//     compose postgres URL (postgres://driftstack:driftstack@localhost:5432/driftstack).
//   • strict: true.
//   • verbose: true.
//   • 'satisfies Config' typecheck.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'drizzle.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W528.C /drizzle.config.ts content parity', () => {
  const body = read(LIB);

  it('DATABASE_URL fallback framing pinned: \'const databaseUrl = process.env.DATABASE_URL ?? "postgres://driftstack:driftstack@localhost:5432/driftstack"\' — pinned so the DATABASE_URL-from-env-with-local-docker-compose-fallback commitment survives (the fallback URL must match the docker-compose service for local dev to work without env setup)', () => {
    expect(body).toMatch(/import type \{ Config \} from 'drizzle-kit';/);
    expect(body).toMatch(
      /const databaseUrl =\s*process\.env\.DATABASE_URL \?\? 'postgres:\/\/driftstack:driftstack@localhost:5432\/driftstack';/,
    );
  });

  it('schema + out + dialect framing pinned: \'schema: "./apps/server/src/db/schema.ts"\' + \'out: "./apps/server/src/db/migrations"\' + \'dialect: "postgresql"\' — pinned so the schema-file location + migrations-output dir + postgresql-dialect commitment survives (drift to a different schema path would break drizzle-kit migration generation; drift to a different dialect would change the SQL grammar generated)', () => {
    expect(body).toMatch(/schema: '\.\/apps\/server\/src\/db\/schema\.ts',/);
    expect(body).toMatch(/out: '\.\/apps\/server\/src\/db\/migrations',/);
    expect(body).toMatch(/dialect: 'postgresql',/);
  });

  it("dbCredentials + strict + verbose + satisfies-Config framing pinned: 'dbCredentials: { url: databaseUrl }' + 'strict: true' + 'verbose: true' + 'satisfies Config' typecheck — pinned so the dbCredentials.url wiring + strict-mode-on (drizzle-kit fails on schema-drift, doesn't silently auto-fix) + verbose-mode-on (drizzle-kit prints what it's about to do before doing it) + satisfies-Config typecheck commitment survives", () => {
    expect(body).toMatch(/dbCredentials: \{\s*url: databaseUrl,\s*\},/);
    expect(body).toMatch(/strict: true,/);
    expect(body).toMatch(/verbose: true,/);
    expect(body).toMatch(/\} satisfies Config;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
