// W441.A — drift guard for apps/server/src/db/migrate.ts.
// CLI entry for `npm run db:migrate`. Drift here either drops the
// max:1 single-connection guard (parallel migration runs race on the
// drizzle_migrations table) or removes the bounded close timeout
// (CI/CD waits forever on hung migrations after they complete).
//
//   • CLI framing pinned: `npm run db:migrate` → `tsx src/db/migrate.ts`.
//   • postgres client max:1 (single connection; migration tooling
//     contract).
//   • migrationsFolder resolved relative to this file's dir.
//   • main().catch → console.error + process.exit(1) on failure.
//   • Bounded client.end({timeout:5}) — same shutdown contract as
//     production client.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/migrate.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W441.A apps/server/src/db/migrate.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Apply pending Drizzle migrations to the configured Postgres. Run with `npm run db:migrate` (i.e. `tsx src/db/migrate.ts`).'", () => {
    expect(body).toMatch(
      /\/\/ Apply pending Drizzle migrations to the configured Postgres\.\s*\n?\s*\/\/ Run with `npm run db:migrate` \(i\.e\. `tsx src\/db\/migrate\.ts`\)\./,
    );
  });

  it('imports: migrate from drizzle-orm/postgres-js/migrator + drizzle + postgres + fileURLToPath/dirname/resolve + loadConfig', () => {
    expect(body).toMatch(/import \{ migrate \} from 'drizzle-orm\/postgres-js\/migrator';/);
    expect(body).toMatch(/import \{ drizzle \} from 'drizzle-orm\/postgres-js';/);
    expect(body).toMatch(/import postgres from 'postgres';/);
    expect(body).toMatch(/import \{ fileURLToPath \} from 'node:url';/);
    expect(body).toMatch(/import \{ dirname, resolve \} from 'node:path';/);
    expect(body).toMatch(/import \{ loadConfig \} from '\.\.\/lib\/config\.js';/);
  });

  it("main(): loadConfig + migrationsFolder resolved via fileURLToPath(import.meta.url) + 'migrations' relative subdir", () => {
    expect(body).toMatch(
      /async function main\(\): Promise<void> \{\s*\n?\s*const config = loadConfig\(\);\s*\n?\s*const here = dirname\(fileURLToPath\(import\.meta\.url\)\);\s*\n?\s*const migrationsFolder = resolve\(here, 'migrations'\);/,
    );
  });

  it('postgres client max:1 (single connection — migration tooling contract); drizzle wires client', () => {
    expect(body).toMatch(/const client = postgres\(config\.databaseUrl, \{ max: 1 \}\);/);
    expect(body).toMatch(/const db = drizzle\(client\);/);
  });

  it("console.warn JSON before+after migrate; 'applying migrations' with folder + 'migrations applied' completion line", () => {
    expect(body).toMatch(
      /console\.warn\(JSON\.stringify\(\{ msg: 'applying migrations', migrationsFolder \}\)\);\s*\n?\s*await migrate\(db, \{ migrationsFolder \}\);\s*\n?\s*console\.warn\(JSON\.stringify\(\{ msg: 'migrations applied' \}\)\);/,
    );
  });

  it('bounded shutdown: await client.end({timeout:5}) (matches createDb close contract)', () => {
    expect(body).toMatch(/await client\.end\(\{ timeout: 5 \}\);/);
  });

  it('main().catch: console.error(err) + process.exit(1) — CLI failure code', () => {
    expect(body).toMatch(
      /main\(\)\.catch\(\(err: unknown\) => \{\s*\n?\s*console\.error\(err\);\s*\n?\s*process\.exit\(1\);\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
