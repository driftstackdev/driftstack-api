// W988 — db/client cross-source invariant. Three-hundred-fourteenth
// in the drift-guard series. Pins the apps/server/src/db/client.ts
// postgres-js + drizzle-ORM bootstrap primitive:
//
//   createDb factory signature — '(databaseUrl: string, opts?: { max?:
//     number; slowQueryLog?: SlowQueryLogConfig }) => { client, db,
//     close }'.
//
//   Default pool size — opts.max ?? 10.
//
//   onnotice swallow framing — 'swallow Postgres NOTICE messages —
//     Pino logger handles real ops'.
//
//   slowQueryLog hookpoint — 'When set, queries ≥ thresholdMs emit a
//     warn-level slow_query log'. The hookpoint wires
//     instrumentSlowQueryLogging from lib/slow-query-log.ts.
//
//   drizzle(client, { schema }) returns the typed drizzle handle.
//
//   close() helper — 'await client.end({ timeout: 5 })' — 5-second
//     graceful drain timeout.
//
//   Schema re-export — `export { schema }`.
//
//   Database type alias — `ReturnType<typeof createDb>`.
//
// stays in lockstep across apps/server/src/db/client.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W988 db/client cross-source invariant', () => {
  // ─── createDb factory signature ──────────────────────────────

  it("CRITICAL createDb signature — '(databaseUrl: string, opts?: { max?: number; slowQueryLog?: SlowQueryLogConfig })' returning '{client, db, close}'. The 2-arg + 3-field-return shape is the V-156 db-bootstrap contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/export function createDb\(/);
    expect(p).toMatch(/databaseUrl: string,/);
    expect(p).toMatch(/opts\?: \{/);
    expect(p).toMatch(/max\?: number;/);
    expect(p).toMatch(/slowQueryLog\?: SlowQueryLogConfig;/);
    expect(p).toMatch(/statementTimeoutMs\?: number;/);
    expect(p).toMatch(/client: ReturnType<typeof postgres>;/);
    expect(p).toMatch(/db: ReturnType<typeof drizzle<typeof schema>>;/);
    expect(p).toMatch(/close: \(\) => Promise<void>;/);
  });

  // ─── Default pool size ───────────────────────────────────────

  it('CRITICAL default pool size — opts.max ?? 10. The 10-conn default matches the standard small-app Postgres pool sizing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/max: opts\?\.max \?\? 10,/);
  });

  // ─── onnotice swallow ────────────────────────────────────────

  it("CRITICAL onnotice handler swallows Postgres NOTICE — '/* swallow Postgres NOTICE messages — Pino logger handles real ops */'. The Pino-handles-real-ops design separates Postgres NOTICEs from operational logs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/onnotice: \(\) => \{/);
    expect(p).toMatch(/\/\* swallow Postgres NOTICE messages — Pino logger handles real ops \*\//);
  });

  // ─── slowQueryLog hookpoint ──────────────────────────────────

  it("CRITICAL slowQueryLog hookpoint framing — 'When set, queries ≥ thresholdMs emit a warn-level slow_query log'. The opt-in instrumentSlowQueryLogging wire is what makes V-113 production-only-by-default.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(
      /\/\*\* When set, queries ≥ thresholdMs emit a warn-level slow_query log\. \*\//,
    );
    expect(p).toMatch(/if \(opts\?\.slowQueryLog\) \{/);
    expect(p).toMatch(/client = instrumentSlowQueryLogging\(client, opts\.slowQueryLog\);/);
  });

  // ─── opt-in statement_timeout ────────────────────────────────

  it("CRITICAL opt-in statement_timeout — when opts.statementTimeoutMs is set, postgres() receives connection: { statement_timeout: opts.statementTimeoutMs } (number ms, per postgres-js's ConnectionParameters type) — a per-connection cap so a runaway query can't hold a pool slot forever and exhaust the pool; the key is omitted when unset = Postgres default (no timeout). App-path only — migrate.ts uses its own postgres({ max: 1 }) client, so long DDL is never capped.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/opts\?\.statementTimeoutMs !== undefined/);
    expect(p).toMatch(/connection: \{ statement_timeout: opts\.statementTimeoutMs \}/);
  });

  // ─── drizzle handle ──────────────────────────────────────────

  it("CRITICAL drizzle handle — 'drizzle(client, { schema })'. The schema-passed-to-drizzle is what makes drizzle-orm typed against the table definitions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/const db = drizzle\(client, \{ schema \}\);/);
  });

  // ─── close() 5-second timeout ────────────────────────────────

  it("CRITICAL close() helper — 'await client.end({ timeout: 5 })'. The 5-second graceful-drain timeout matches the V-167 graceful-shutdown budget.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/close: async \(\) => \{/);
    expect(p).toMatch(/await client\.end\(\{ timeout: 5 \}\);/);
  });

  // ─── Schema re-export ────────────────────────────────────────

  it("CRITICAL schema re-export — 'export { schema }'. The single-export lets repos consume the typed table-defs from one location.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/export \{ schema \};/);
  });

  // ─── Database type alias ─────────────────────────────────────

  it("CRITICAL Database type alias — 'export type Database = ReturnType<typeof createDb>'. The ReturnType alias keeps the public-Database-type in sync with createDb's actual shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/export type Database = ReturnType<typeof createDb>;/);
  });

  // ─── 3 key imports ───────────────────────────────────────────

  it("CRITICAL 3 imports — drizzle from 'drizzle-orm/postgres-js' + postgres + instrumentSlowQueryLogging from '../lib/slow-query-log.js'. The 3-import set is what wires the db-bootstrap module.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/client.ts'));
    expect(p).toMatch(/import \{ drizzle \} from 'drizzle-orm\/postgres-js';/);
    expect(p).toMatch(/import postgres from 'postgres';/);
    expect(p).toMatch(
      /import \{ instrumentSlowQueryLogging, type SlowQueryLogConfig \} from '\.\.\/lib\/slow-query-log\.js';/,
    );
    expect(p).toMatch(/import \* as schema from '\.\/schema\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/db-client-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
