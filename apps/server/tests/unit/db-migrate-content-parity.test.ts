// W441.A — drift guard for apps/server/src/db/migrate.ts.
// CLI entry for `npm run db:migrate`. Drift here either drops the
// max:1 single-connection guard (parallel migration runs race on the
// drizzle_migrations table) or removes the bounded close timeout
// (CI/CD waits forever on hung migrations after they complete).
//
//   • CLI framing pinned: `npm run db:migrate` → `tsx src/db/migrate.ts`.
//   • postgres client max:1 (single connection; migration tooling
//     contract).
//   • migrationsFolder resolved relative to this file's dir, with a
//     src-tree fallback so the compiled prod migrate.js finds the
//     migrations under apps/server/src/db/migrations (deploy-bridge
//     pattern; no migrations copied into dist/).
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

  it('imports: migrate + sql + drizzle + postgres + fs.{existsSync,readFileSync} + fileURLToPath/dirname/resolve + loadConfig', () => {
    expect(body).toMatch(/import \{ migrate \} from 'drizzle-orm\/postgres-js\/migrator';/);
    expect(body).toMatch(/import \{ drizzle \} from 'drizzle-orm\/postgres-js';/);
    expect(body).toMatch(/import \{ sql \} from 'drizzle-orm';/);
    expect(body).toMatch(/import postgres from 'postgres';/);
    expect(body).toMatch(/import \{ existsSync, readFileSync \} from 'node:fs';/);
    expect(body).toMatch(/import \{ fileURLToPath \} from 'node:url';/);
    expect(body).toMatch(/import \{ dirname, resolve \} from 'node:path';/);
    expect(body).toMatch(/import \{ loadConfig \} from '\.\.\/lib\/config\.js';/);
  });

  it('resolveMigrationsFolder helper prefers compiled-neighbour migrations/ when it has meta/_journal.json, falls back to src/db/migrations two dirs up', () => {
    expect(body).toMatch(/function resolveMigrationsFolder\(here: string\): string \{/);
    expect(body).toMatch(/const compiledNeighbour = resolve\(here, 'migrations'\);/);
    expect(body).toMatch(
      /if \(existsSync\(resolve\(compiledNeighbour, 'meta\/_journal\.json'\)\)\) \{\s*\n?\s*return compiledNeighbour;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/return resolve\(here, '\.\.', '\.\.', 'src', 'db', 'migrations'\);/);
  });

  it('main(): loadConfig + migrationsFolder via resolveMigrationsFolder(here)', () => {
    expect(body).toMatch(
      /async function main\(\): Promise<void> \{\s*\n?\s*const config = loadConfig\(\);\s*\n?\s*const here = dirname\(fileURLToPath\(import\.meta\.url\)\);\s*\n?\s*const migrationsFolder = resolveMigrationsFolder\(here\);/,
    );
  });

  it('postgres client max:1 (single connection — migration tooling contract); drizzle wires client', () => {
    // The options object is multi-line now: `onnotice` was added so migration
    // notices arrive as one-line JSON like every other line this script writes,
    // instead of postgres-js's raw ANSI object dump landing between them. Each
    // property is pinned on its own, so adding a third does not break a claim
    // about the first two.
    expect(body).toMatch(/const client = postgres\(config\.databaseUrl, \{/);
    expect(body, 'single connection — migration tooling contract').toMatch(/^\s*max: 1,\s*$/m);
    expect(body).toMatch(/const db = drizzle\(client\);/);
  });

  it("console.warn JSON before+after migrate; 'applying migrations' with folder + expectedCount; 'migrations applied' with appliedCount; post-condition assertion exits 2 on silent-skip drift", () => {
    expect(body).toMatch(
      /console\.warn\(JSON\.stringify\(\{ msg: 'applying migrations', migrationsFolder, expectedCount \}\)\);\s*\n?\s*await migrate\(db, \{ migrationsFolder \}\);/,
    );
    expect(body).toMatch(
      /console\.warn\(JSON\.stringify\(\{ msg: 'migrations applied', appliedCount: actualCount \}\)\);/,
    );
    expect(body).toMatch(/if \(actualCount !== expectedCount\) \{\s*\n?\s*console\.error\(/);
    expect(body).toMatch(/process\.exit\(2\);/);
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
