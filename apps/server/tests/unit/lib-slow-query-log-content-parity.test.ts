// W392.B — drift guard for apps/server/src/lib/slow-query-log.ts.
// V-113 postgres-js slow-query-log instrumentation. Hooks
// `client.unsafe(sql, params)` (drizzle's only execution path) and
// emits a structured warn-log entry when duration ≥ threshold.
// Tagged-template `sql\`SELECT 1\`` is NOT instrumented — only used at
// boot + migrations, accepted gap per V-113.
//
//   • V-113 framing pinned + drizzle's parameterized-query path note.
//   • Tagged-template gap framing pinned (boot SELECT 1 + migrations).
//   • bootstrap wires only when SLOW_QUERY_LOG_THRESHOLD_MS set
//     (dev/test default off).
//   • Proxy-on-Pending rationale: preserves `.cursor()`, `.execute()`,
//     `.values()` chainable cursor surface for future call paths.
//   • SlowQueryLogConfig: thresholdMs + logger + optional maxSqlLength
//     (default 500).
//   • Wrapper: performance.now() startedAt → durationMs on Pending
//     resolution → conditional warn-log.
//   • slow_query event log payload: component='db' + event +
//     durationMs (2-decimal rounded) + thresholdMs + sql (truncated
//     with "…" suffix) + paramCount.
//   • Returns same client for fluent chaining.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W392.B apps/server/src/lib/slow-query-log.ts content parity', () => {
  const body = read(LIB);

  it('V-113 framing + drizzle parameterized-query unsafe-path note pinned', () => {
    expect(body).toMatch(/V-113: postgres-js slow-query log instrumentation\./);
    expect(body).toMatch(
      /Hooks into `client\.unsafe\(sql, params\)` — the path drizzle-orm uses\s*\n?\s*\/\/\s*for every parameterized query\. Times the resulting Pending and emits\s*\n?\s*\/\/\s*a structured warn-level log entry whenever duration ≥ threshold/,
    );
  });

  it('Tagged-template gap framing pinned: NOT instrumented — boot SELECT 1 + migrations only', () => {
    expect(body).toMatch(
      /Tagged-template direct queries \(`sql\\`SELECT 1\\``\) are NOT\s*\n?\s*\/\/\s*instrumented\. The control plane uses tagged-template form only at\s*\n?\s*\/\/\s*boot \(`bootstrap\.ts` SELECT 1 probe\) and during migrations; both are\s*\n?\s*\/\/\s*outside the request critical path so the gap is acceptable/,
    );
  });

  it('bootstrap-wires-only-when-threshold-set framing pinned', () => {
    expect(body).toMatch(
      /Wire via `createDb\(url, \{ slowQueryLog: \{ thresholdMs, logger \} \}\)`\.\s*\n?\s*\/\/\s*`bootstrap\.ts` reads `SLOW_QUERY_LOG_THRESHOLD_MS` from env and\s*\n?\s*\/\/\s*only enables instrumentation when set \(i\.e\. dev\/test default off\)/,
    );
  });

  it('Proxy-on-Pending rationale framing pinned (preserves .cursor / .execute / .values chainable surface)', () => {
    expect(body).toMatch(
      /Why a Proxy on Pending and not `await`-wrapping unsafe directly:\s*\n?\s*\/\/\s*postgres-js's Pending<T> is also a chainable cursor object exposing\s*\n?\s*\/\/\s*`\.cursor\(\)`, `\.execute\(\)`, `\.values\(\)`, etc\. drizzle-orm awaits it\s*\n?\s*\/\/\s*directly today, but the safer wrapping preserves the full Pending\s*\n?\s*\/\/\s*surface for any future code path \(or query type\) that uses those\s*\n?\s*\/\/\s*chained methods/,
    );
  });

  it('SlowQueryLogConfig: thresholdMs + logger + maxSqlLength? (default 500)', () => {
    expect(body).toMatch(/export interface SlowQueryLogConfig \{/);
    expect(body).toMatch(/Duration in ms at or above which a query is considered slow\./);
    expect(body).toMatch(/thresholdMs: number;/);
    expect(body).toMatch(/logger: Logger;/);
    expect(body).toMatch(/Truncate logged SQL longer than this many chars \(default 500\)\./);
    expect(body).toMatch(/maxSqlLength\?: number;/);
    expect(body).toMatch(/const DEFAULT_MAX_SQL_LENGTH = 500;/);
  });

  it('instrumentSlowQueryLogging: mutates client.unsafe + returns same client for chaining', () => {
    expect(body).toMatch(
      /Mutate `client\.unsafe` so postgres-js queries above `thresholdMs`\s*\n?\s*\*\s*emit a structured warn-level slow_query log\. Returns the same client\s*\n?\s*\*\s*for fluent chaining/,
    );
    expect(body).toMatch(
      /export function instrumentSlowQueryLogging\(\s*\n?\s*client: postgres\.Sql,\s*\n?\s*config: SlowQueryLogConfig,\s*\n?\s*\): postgres\.Sql \{/,
    );
    expect(body).toMatch(/return client;/);
  });

  it('Wrapper: performance.now() startedAt + Proxy.then handler with durationMs measurement', () => {
    expect(body).toMatch(/const startedAt = performance\.now\(\);/);
    expect(body).toMatch(
      /const pending = originalUnsafe\(sql, params as never, options as never\);/,
    );
    expect(body).toMatch(/return new Proxy\(pending as object, \{/);
    expect(body).toMatch(/if \(prop === 'then'\) \{/);
    expect(body).toMatch(/const durationMs = performance\.now\(\) - startedAt;/);
    expect(body).toMatch(/if \(durationMs >= config\.thresholdMs\) \{/);
  });

  it('slow_query warn log: component="db" + event + 2-decimal-rounded durationMs + sql truncate with "…" + paramCount', () => {
    expect(body).toMatch(
      /config\.logger\.warn\(\s*\n?\s*\{\s*\n?\s*component: 'db',\s*\n?\s*event: 'slow_query',\s*\n?\s*durationMs: Math\.round\(durationMs \* 100\) \/ 100,\s*\n?\s*thresholdMs: config\.thresholdMs,\s*\n?\s*sql: sql\.length > maxSqlLength \? `\$\{sql\.slice\(0, maxSqlLength\)\}…` : sql,\s*\n?\s*paramCount: params\?\.length \?\? 0,\s*\n?\s*\},\s*\n?\s*'Slow query exceeded threshold',\s*\n?\s*\);/,
    );
  });

  it('Proxy fallback: Reflect.get(target, prop, receiver) for any prop other than "then"', () => {
    expect(body).toMatch(/return Reflect\.get\(target, prop, receiver\) as unknown;/);
  });

  it('imports: postgres type + Logger type only (no other deps)', () => {
    expect(body).toMatch(/import type postgres from 'postgres';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\/logger\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
