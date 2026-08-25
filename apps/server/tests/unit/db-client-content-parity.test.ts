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

  it('createDb signature: databaseUrl + opts {max? + slowQueryLog? + statementTimeoutMs?}; slowQueryLog comment "When set, queries ≥ thresholdMs emit a warn-level slow_query log." + 3-field return {client, db, close}. Short focused pins (not one long-chain regex) per the no-long-chain-regex rule.', () => {
    expect(body).toMatch(/export function createDb\(/);
    expect(body).toMatch(/databaseUrl: string,/);
    expect(body).toMatch(/opts\?: \{/);
    expect(body).toMatch(/max\?: number;/);
    expect(body).toMatch(
      /\/\*\* When set, queries ≥ thresholdMs emit a warn-level slow_query log\. \*\//,
    );
    expect(body).toMatch(/slowQueryLog\?: SlowQueryLogConfig;/);
    // V-156 follow-up — opt-in statement_timeout opt added after slowQueryLog.
    expect(body).toMatch(/statementTimeoutMs\?: number;/);
    expect(body).toMatch(/client: ReturnType<typeof postgres>;/);
    expect(body).toMatch(/db: ReturnType<typeof drizzle<typeof schema>>;/);
    expect(body).toMatch(/close: \(\) => Promise<void>;/);
  });

  it('postgres init: default max 10; OPT-IN connection.statement_timeout (number ms) when set; onnotice swallow rationale (Pino handles real ops, not driver NOTICE noise). Short focused pins per the no-long-chain-regex rule.', () => {
    expect(body).toMatch(/let client = postgres\(databaseUrl, \{/);
    expect(body).toMatch(/max: opts\?\.max \?\? 10,/);
    // V-156 follow-up — runaway-query cap, off (no key) when unset.
    expect(body).toMatch(/opts\?\.statementTimeoutMs !== undefined/);
    expect(body).toMatch(/connection: \{ statement_timeout: opts\.statementTimeoutMs \}/);
    expect(body).toMatch(
      /\/\* swallow Postgres NOTICE messages — Pino logger handles real ops \*\//,
    );
    expect(body).toMatch(/onnotice: \(\) => \{/);
  });

  it('slow-query log instrumentation: client = instrumentSlowQueryLogging(client, opts.slowQueryLog) wraps client when configured', () => {
    expect(body).toMatch(
      /if \(opts\?\.slowQueryLog\) \{\s*client = instrumentSlowQueryLogging\(client, opts\.slowQueryLog\);\s*\}/,
    );
  });

  it('drizzle wires postgres client + schema; close() = client.end({timeout:5}) bounded graceful shutdown', () => {
    expect(body).toMatch(/const db = drizzle\(client, \{ schema \}\);/);
    expect(body).toMatch(
      /return \{\s*client,\s*db,\s*close: async \(\) => \{\s*await client\.end\(\{ timeout: 5 \}\);\s*\},\s*\};/,
    );
  });

  it('re-export schema for downstream typing (named export)', () => {
    expect(body).toMatch(/export \{ schema \};/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
