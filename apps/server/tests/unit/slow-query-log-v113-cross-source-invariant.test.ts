// W974 — V-113 slow-query-log cross-source invariant. Three-
// hundredth in the drift-guard series. Pins the apps/server/src/lib/
// slow-query-log.ts postgres-js instrumentation primitive:
//
//   V-113 anchor — 'V-113: postgres-js slow-query log instrumentation'.
//
//   Hook-site framing — 'Hooks into client.unsafe(sql, params) — the
//   path drizzle-orm uses for every parameterized query. Times the
//   resulting Pending and emits a structured warn-level log entry
//   whenever duration ≥ threshold'.
//
//   Tagged-template-not-instrumented framing — 'Tagged-template
//   direct queries (sql`SELECT 1`) are NOT instrumented. The control
//   plane uses tagged-template form only at boot (bootstrap.ts
//   SELECT 1 probe) and during migrations; both are outside the
//   request critical path so the gap is acceptable'.
//
//   Wire-via framing — 'Wire via createDb(url, { slowQueryLog: {
//   thresholdMs, logger } }). bootstrap.ts reads
//   SLOW_QUERY_LOG_THRESHOLD_MS from env and only enables
//   instrumentation when set (i.e. dev/test default off)'.
//
//   Proxy-on-Pending framing — 'Why a Proxy on Pending and not
//   await-wrapping unsafe directly: postgres-js's Pending<T> is also
//   a chainable cursor object exposing .cursor(), .execute(),
//   .values(), etc. drizzle-orm awaits it directly today, but the
//   safer wrapping preserves the full Pending surface for any
//   future code path (or query type) that uses those chained
//   methods'.
//
//   DEFAULT_MAX_SQL_LENGTH = 500.
//
//   SlowQueryLogConfig shape: thresholdMs + logger + maxSqlLength?.
//
//   Slow-query log payload 6 fields:
//     - component: 'db'.
//     - event: 'slow_query'.
//     - durationMs (2-decimal rounded via Math.round(x*100)/100).
//     - thresholdMs.
//     - sql (truncated at maxSqlLength with '…' ellipsis suffix).
//     - paramCount (params?.length ?? 0).
//   + log message 'Slow query exceeded threshold'.
//
//   threshold check is >= (durationMs ≥ thresholdMs).
//
// stays in lockstep across apps/server/src/lib/slow-query-log.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W974 V-113 slow-query-log cross-source invariant', () => {
  // ─── V-113 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/slow-query-log.ts header pins V-113 anchor — 'V-113: postgres-js slow-query log instrumentation'. The V-113 anchor is the policy provenance for the slow-query-log primitive.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/V-113: postgres-js slow-query log instrumentation\./);
  });

  // ─── Hook-site + threshold framing ───────────────────────────

  it("CRITICAL hook-site framing — 'Hooks into client.unsafe(sql, params) — the path drizzle-orm uses for every parameterized query. Times the resulting Pending and emits a structured warn-level log entry whenever duration ≥ threshold'. The unsafe-only + Pending-timed + warn-level design is the V-113 hook-point contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/Hooks into `client\.unsafe\(sql, params\)` — the path drizzle-orm uses/);
    expect(p).toMatch(/for every parameterized query\. Times the resulting Pending and emits/);
    expect(p).toMatch(/a structured warn-level log entry whenever duration ≥ threshold\./);
  });

  // ─── Tagged-template-not-instrumented framing ────────────────

  it("CRITICAL tagged-template-not-instrumented framing — 'Tagged-template direct queries (sql`SELECT 1`) are NOT instrumented. The control plane uses tagged-template form only at boot (bootstrap.ts SELECT 1 probe) and during migrations; both are outside the request critical path so the gap is acceptable'. The off-critical-path-acceptable-gap design is the V-113 limit-of-scope contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/Tagged-template direct queries/);
    expect(p).toMatch(/are NOT/);
    expect(p).toMatch(/instrumented\. The control plane uses tagged-template form only at/);
    expect(p).toMatch(/boot \(`bootstrap\.ts` SELECT 1 probe\) and during migrations; both are/);
    expect(p).toMatch(/outside the request critical path so the gap is acceptable\./);
  });

  // ─── Wire-via + env-gated framing ────────────────────────────

  it("CRITICAL wire-via framing — 'Wire via createDb(url, { slowQueryLog: { thresholdMs, logger } }). bootstrap.ts reads SLOW_QUERY_LOG_THRESHOLD_MS from env and only enables instrumentation when set (i.e. dev/test default off)'. The bootstrap-env-gated + dev-test-default-off design is the V-113 production-only-by-default contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(
      /Wire via `createDb\(url, \{ slowQueryLog: \{ thresholdMs, logger \} \}\)`\./,
    );
    expect(p).toMatch(/`bootstrap\.ts` reads `SLOW_QUERY_LOG_THRESHOLD_MS` from env and/);
    expect(p).toMatch(/only enables instrumentation when set \(i\.e\. dev\/test default off\)\./);
  });

  // ─── Proxy-on-Pending framing ────────────────────────────────

  it("CRITICAL Proxy-on-Pending framing — 'Why a Proxy on Pending and not await-wrapping unsafe directly: postgres-js's Pending<T> is also a chainable cursor object exposing .cursor(), .execute(), .values(), etc. drizzle-orm awaits it directly today, but the safer wrapping preserves the full Pending surface for any future code path (or query type) that uses those chained methods'. The Proxy-preserves-full-surface design is the V-113 safety rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/Why a Proxy on Pending and not `await`-wrapping unsafe directly:/);
    expect(p).toMatch(/postgres-js's Pending<T> is also a chainable cursor object exposing/);
    expect(p).toMatch(
      /`\.cursor\(\)`, `\.execute\(\)`, `\.values\(\)`, etc\. drizzle-orm awaits it/,
    );
    expect(p).toMatch(/directly today, but the safer wrapping preserves the full Pending/);
    expect(p).toMatch(/surface for any future code path \(or query type\) that uses those/);
    expect(p).toMatch(/chained methods\./);
  });

  // ─── DEFAULT_MAX_SQL_LENGTH constant ─────────────────────────

  it('CRITICAL DEFAULT_MAX_SQL_LENGTH = 500. The 500-char truncation default keeps log lines readable while still capturing enough SQL for human debugging.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/const DEFAULT_MAX_SQL_LENGTH = 500;/);
  });

  // ─── SlowQueryLogConfig 3-field shape ────────────────────────

  it('CRITICAL SlowQueryLogConfig 3-field shape — thresholdMs + logger + maxSqlLength?. The required-2 + optional-1 design lets the caller pick truncation length per environment.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/export interface SlowQueryLogConfig \{/);
    expect(p).toMatch(/thresholdMs: number;/);
    expect(p).toMatch(/logger: Logger;/);
    expect(p).toMatch(/maxSqlLength\?: number;/);
  });

  // ─── instrumentSlowQueryLogging signature ────────────────────

  it("CRITICAL instrumentSlowQueryLogging signature — '(client: postgres.Sql, config: SlowQueryLogConfig): postgres.Sql'. The return-same-client-for-fluent-chaining matches the V-113 mutation-API design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/export function instrumentSlowQueryLogging\(/);
    expect(p).toMatch(/client: postgres\.Sql,/);
    expect(p).toMatch(/config: SlowQueryLogConfig,/);
    expect(p).toMatch(/\): postgres\.Sql \{/);
  });

  // ─── Threshold check uses >= ─────────────────────────────────

  it("CRITICAL threshold check uses >= — 'if (durationMs >= config.thresholdMs)'. The ≥-not-> design matches the V-113 'duration ≥ threshold' framing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/if \(durationMs >= config\.thresholdMs\) \{/);
  });

  // ─── Duration 2-decimal rounding ─────────────────────────────

  it("CRITICAL durationMs is rounded to 2 decimal places — 'Math.round(durationMs * 100) / 100'. The 2-decimal precision matches the V-494 sentry breadcrumb duration_ms convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/durationMs: Math\.round\(durationMs \* 100\) \/ 100,/);
  });

  // ─── Slow-query log payload 6 fields + message ───────────────

  it("CRITICAL slow-query log payload has 6 fields — component:'db' + event:'slow_query' + durationMs + thresholdMs + sql (truncated) + paramCount. The 6-field structured payload is what dashboards filter on.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/component: 'db',/);
    expect(p).toMatch(/event: 'slow_query',/);
    expect(p).toMatch(/durationMs: Math\.round\(/);
    expect(p).toMatch(/thresholdMs: config\.thresholdMs,/);
    expect(p).toMatch(
      /sql: sql\.length > maxSqlLength \? `\$\{sql\.slice\(0, maxSqlLength\)\}…` : sql,/,
    );
    expect(p).toMatch(/paramCount: params\?\.length \?\? 0,/);
    expect(p).toMatch(/'Slow query exceeded threshold',/);
  });

  // ─── SQL truncation ellipsis ─────────────────────────────────

  it("CRITICAL SQL truncation appends '…' (U+2026 horizontal ellipsis), not '...' (3 ASCII dots). The single-char ellipsis preserves character-count parity with the truncation length.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/`\$\{sql\.slice\(0, maxSqlLength\)\}…`/);
  });

  // ─── Then-property routing on Proxy ──────────────────────────

  it("CRITICAL Proxy intercepts 'then' to wrap the await chain — 'if (prop === then) return (onFulfilled?, onRejected?) => target.then(...)'. The then-only-intercept lets every other Pending method (.cursor / .execute / .values) pass through to the underlying object via Reflect.get fallback.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/if \(prop === 'then'\) \{/);
    expect(p).toMatch(/return \(target as PromiseLike<unknown>\)\.then\(\(value\) => \{/);
    expect(p).toMatch(/return Reflect\.get\(target, prop, receiver\) as unknown;/);
  });

  // ─── Bind on original unsafe ─────────────────────────────────

  it("CRITICAL originalUnsafe = client.unsafe.bind(client). The .bind(client) preserves 'this' context so the wrapped delegate can be called without method-detachment quirks.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/const originalUnsafe = client\.unsafe\.bind\(client\);/);
  });

  // ─── performance.now() timing ────────────────────────────────

  it("CRITICAL timing uses performance.now() — 'const startedAt = performance.now();' + 'durationMs = performance.now() - startedAt'. The performance.now()-not-Date.now() choice gives sub-millisecond precision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/slow-query-log.ts'));
    expect(p).toMatch(/const startedAt = performance\.now\(\);/);
    expect(p).toMatch(/const durationMs = performance\.now\(\) - startedAt;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/slow-query-log-v113-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
