// W440.C — drift guard for apps/server/src/db/client.ts.
// Drizzle Postgres connection factory. Drift here either drops the
// onnotice swallow (Postgres NOTICE messages flood the logger) or
// removes the close-timeout (graceful shutdown stalls on hanging
// queries).
//
//   • postgres-js driver via drizzle/postgres-js.
//   • Default pool size: 10.
//   • onnotice swallow: Postgres NOTICE messages handled by Pino at
//     real-ops level, not driver-level.
//   • Optional slow-query log instrumentation (warn-level when
//     thresholdMs exceeded).
//   • close(): client.end({ timeout: 5 }) — bounded graceful shutdown.
//   • Re-exports schema for downstream typing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/client.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W440.C apps/server/src/db/client.ts content parity', () => {
  const body = read(LIB);

  it("imports: drizzle from 'drizzle-orm/postgres-js' + postgres + instrumentSlowQueryLogging/SlowQueryLogConfig + schema * import", () => {
    expect(body).toMatch(/import \{ drizzle \} from 'drizzle-orm\/postgres-js';/);
    expect(body).toMatch(/import postgres from 'postgres';/);
    expect(body).toMatch(
      /import \{ instrumentSlowQueryLogging, type SlowQueryLogConfig \} from '\.\.\/lib\/slow-query-log\.js';/,
    );
    expect(body).toMatch(/import \* as schema from '\.\/schema\.js';/);
  });

  it('Database type alias = ReturnType<typeof createDb>', () => {
    expect(body).toMatch(/export type Database = ReturnType<typeof createDb>;/);
  });

  it('createDb signature: databaseUrl + opts {max? + slowQueryLog?}; slowQueryLog comment "When set, queries ≥ thresholdMs emit a warn-level slow_query log."', () => {
    expect(body).toMatch(
      /export function createDb\(\s*\n?\s*databaseUrl: string,\s*\n?\s*opts\?: \{\s*\n?\s*max\?: number;\s*\n?\s*\/\*\* When set, queries ≥ thresholdMs emit a warn-level slow_query log\. \*\/\s*\n?\s*slowQueryLog\?: SlowQueryLogConfig;\s*\n?\s*\},\s*\n?\s*\): \{\s*\n?\s*client: ReturnType<typeof postgres>;\s*\n?\s*db: ReturnType<typeof drizzle<typeof schema>>;\s*\n?\s*close: \(\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it('postgres init: default max 10; onnotice swallow rationale (Pino logger handles real ops, not driver NOTICE noise)', () => {
    expect(body).toMatch(
      /let client = postgres\(databaseUrl, \{\s*\n?\s*max: opts\?\.max \?\? 10,\s*\n?\s*onnotice: \(\) => \{\s*\n?\s*\/\* swallow Postgres NOTICE messages — Pino logger handles real ops \*\/\s*\n?\s*\},\s*\n?\s*\}\);/,
    );
  });

  it('slow-query log instrumentation: client = instrumentSlowQueryLogging(client, opts.slowQueryLog) wraps client when configured', () => {
    expect(body).toMatch(
      /if \(opts\?\.slowQueryLog\) \{\s*\n?\s*client = instrumentSlowQueryLogging\(client, opts\.slowQueryLog\);\s*\n?\s*\}/,
    );
  });

  it('drizzle wires postgres client + schema; close() = client.end({timeout:5}) bounded graceful shutdown', () => {
    expect(body).toMatch(/const db = drizzle\(client, \{ schema \}\);/);
    expect(body).toMatch(
      /return \{\s*\n?\s*client,\s*\n?\s*db,\s*\n?\s*close: async \(\) => \{\s*\n?\s*await client\.end\(\{ timeout: 5 \}\);\s*\n?\s*\},\s*\n?\s*\};/,
    );
  });

  it('re-export schema for downstream typing (named export)', () => {
    expect(body).toMatch(/export \{ schema \};/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
