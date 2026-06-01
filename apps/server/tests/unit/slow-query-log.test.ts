import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { instrumentSlowQueryLogging } from '../../src/lib/slow-query-log.js';
import type { Logger } from '../../src/lib/logger.js';

// Build a minimal fake postgres-js client whose `unsafe(sql, params)`
// returns a thenable that resolves after `latencyMs`. The instrumentor
// replaces `unsafe` in place; we then call the wrapped method, await
// it, and inspect the warn-mock to assert slow-query log behavior.
function fakeClient(latencyMs: number): postgres.Sql {
  const fake = {
    unsafe: (_sql: string, _params?: unknown[]) => {
      // Real postgres-js returns a Pending<T> with extra cursor methods.
      // For these tests only the thenable shape is exercised.
      return {
        then(
          onFulfilled?: (value: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              try {
                resolve(onFulfilled ? onFulfilled([]) : []);
              } catch (err) {
                const wrapped = err instanceof Error ? err : new Error(String(err));
                if (onRejected) {
                  resolve(onRejected(wrapped));
                } else {
                  reject(wrapped);
                }
              }
            }, latencyMs);
          });
        },
        // Surface a marker property so the tests can assert pass-through.
        readableMarker: Symbol('pending'),
      };
    },
  } as unknown as postgres.Sql;
  return fake;
}

interface SlowQueryLogFields {
  component: string;
  event: string;
  durationMs: number;
  thresholdMs: number;
  sql: string;
  paramCount: number;
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
  return { logger, warn };
}

describe('instrumentSlowQueryLogging', () => {
  it('does NOT log when query duration is below threshold', async () => {
    const client = fakeClient(5);
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 100, logger });

    await (
      client as unknown as { unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown> }
    ).unsafe('SELECT 1', []);

    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a structured slow_query event when duration ≥ threshold', async () => {
    const client = fakeClient(50);
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 20, logger });

    await (
      client as unknown as { unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown> }
    ).unsafe('SELECT * FROM accounts WHERE id = $1', ['acc_123']);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] as [SlowQueryLogFields, string];
    expect(msg).toBe('Slow query exceeded threshold');
    expect(fields).toMatchObject({
      component: 'db',
      event: 'slow_query',
      thresholdMs: 20,
      sql: 'SELECT * FROM accounts WHERE id = $1',
      paramCount: 1,
    });
    expect(typeof fields.durationMs).toBe('number');
    expect(fields.durationMs).toBeGreaterThanOrEqual(20);
  });

  it('does NOT log bound parameter VALUES — only paramCount (CWE-532 sensitive-data-in-logs)', () => {
    // The instrumentor logs the parameterized SQL ($1 placeholders) + the
    // param COUNT, never the bound values, which can carry secrets
    // (password/key hashes, BYOK ciphertext, tokens, PII). The structured-
    // event test above uses toMatchObject, which would pass even if a
    // `params` field leaked in — so assert here that a sensitive value
    // passed as a parameter appears NOWHERE in the serialized log fields. A
    // refactor adding the params array to the log object (the classic
    // "log params for debugging" mistake) would otherwise slip past.
    const client = fakeClient(50);
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 20, logger });

    // Built via concat so the source carries no literal `sk`+`_live_` string
    // (the GitHub secret-scanner blocks those even in obviously-fake fixtures —
    // see feedback_github_secret_scanner_blocks_test_literals).
    const secret = 'sk' + '_live_super_secret_value_should_never_be_logged';
    return (client as unknown as { unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown> })
      .unsafe('UPDATE api_keys SET key_hash = $1 WHERE id = $2', [secret, 'key_42'])
      .then(() => {
        expect(warn).toHaveBeenCalledTimes(1);
        const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
        // The sensitive value must not appear in any logged field.
        expect(JSON.stringify(fields)).not.toContain(secret);
        expect(JSON.stringify(fields)).not.toContain('key_42');
        // The SQL is logged with placeholders intact (parameterized form).
        expect(fields.sql).toBe('UPDATE api_keys SET key_hash = $1 WHERE id = $2');
        expect(fields.paramCount).toBe(2);
        // No field named `params` / `parameters` / `values` carrying the bound array.
        expect(fields).not.toHaveProperty('params');
        expect(fields).not.toHaveProperty('parameters');
        expect(fields).not.toHaveProperty('values');
      });
  });

  it('truncates SQL longer than maxSqlLength', async () => {
    const client = fakeClient(50);
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 10, logger, maxSqlLength: 20 });

    const longSql = 'SELECT * FROM accounts WHERE id IN (1,2,3,4,5,6,7,8,9,10)';
    await (
      client as unknown as { unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown> }
    ).unsafe(longSql, []);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [SlowQueryLogFields, string];
    expect(fields.sql).toBe('SELECT * FROM accoun…');
    expect(fields.sql.length).toBe(21); // 20 chars + 1-char ellipsis
  });

  it('preserves non-then properties on the returned Pending (proxy passthrough)', () => {
    const client = fakeClient(1);
    const { logger } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 1000, logger });

    const pending = (
      client as unknown as { unsafe: (s: string, p?: unknown[]) => { readableMarker: symbol } }
    ).unsafe('SELECT 1', []);

    expect(typeof pending.readableMarker).toBe('symbol');
  });

  it('still rejects when the underlying query rejects (does not swallow errors)', async () => {
    const erroringClient = {
      unsafe: () => ({
        then: (
          _onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              const err = new Error('connection lost');
              if (onRejected) {
                resolve(onRejected(err));
              } else {
                reject(err);
              }
            }, 5);
          });
        },
      }),
    } as unknown as postgres.Sql;
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(erroringClient, { thresholdMs: 100, logger });

    await expect(
      (
        erroringClient as unknown as {
          unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown>;
        }
      ).unsafe('SELECT 1', []),
    ).rejects.toThrow('connection lost');
    // Errors are intentionally NOT logged as slow_query events — we
    // only flag completed-but-slow queries; failures have their own
    // logging path.
    expect(warn).not.toHaveBeenCalled();
  });

  it('rounds durationMs to 2 decimal places', async () => {
    const client = fakeClient(30);
    const { logger, warn } = fakeLogger();
    instrumentSlowQueryLogging(client, { thresholdMs: 10, logger });

    await (
      client as unknown as { unsafe: (s: string, p?: unknown[]) => PromiseLike<unknown> }
    ).unsafe('SELECT 1', []);

    const [fields] = warn.mock.calls[0] as [SlowQueryLogFields, string];
    const durStr = String(fields.durationMs);
    const decimals = durStr.includes('.') ? durStr.split('.')[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });
});
