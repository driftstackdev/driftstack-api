// W586.A — drift guard for packages/sdk-python/src/driftstack/retry.py.
// Exponential-backoff retry policy with full jitter. Drift here
// either breaks Retry-After honouring (server's hint wins), loses
// the default-on TransportError+RateLimitError retryable set, or
// flips the mutating-method default (NOT retried unless caller
// opts in).
//
//   • RetryConfig dataclass: max_retries=3 + initial_delay_ms=200 +
//     max_delay_ms=10_000 + backoff_multiplier=2.0 + enabled=True +
//     retryable_errors=(TransportError, RateLimitError).
//   • _backoff_delay_ms: Retry-After wins (in ms), capped at max;
//     otherwise full-jitter random.uniform(0, capped).
//   • with_retry / with_retry_async: sleep + time.sleep / asyncio.sleep.
//   • TS SDK parity: packages/sdk-typescript/src/retry.ts mirror.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/retry.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W586.A packages/sdk-python/src/driftstack/retry.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + TS SDK retry.ts mirror + Retry-After honoured + read-shaped retried + mutating-no-retry-unless-opt-in framing pinned', () => {
    expect(body).toMatch(/^"""Exponential-backoff retry policy with full jitter\.\n/);
    expect(body).toMatch(
      /Mirrors `packages\/sdk-typescript\/src\/retry\.ts`\. Honours `Retry-After`/,
    );
    expect(body).toMatch(/when the server set one \(the SDK's HTTP layer maps it onto the/);
    expect(body).toMatch(/RateLimitError before retry decides\)\. Idempotent or read-shaped/);
    expect(body).toMatch(/methods are retried; mutating methods that lack server-side idempotency/);
    expect(body).toMatch(/keys are NOT retried by default — callers can opt in via the/);
    expect(body).toMatch(/``retry`` argument on the HTTP client\./);
  });

  it('RetryConfig dataclass: max_retries=3 + initial_delay_ms=200 + max_delay_ms=10_000 + backoff_multiplier=2.0 + enabled=True + retryable_errors default-factory (TransportError, RateLimitError)', () => {
    expect(body).toMatch(/^@dataclass$/m);
    expect(body).toMatch(/^class RetryConfig:$/m);
    expect(body).toMatch(
      /"""Tuning knobs for the retry loop\. Defaults match the TypeScript SDK\."""/,
    );
    expect(body).toMatch(/^\s*max_retries: int = 3$/m);
    expect(body).toMatch(/^\s*initial_delay_ms: int = 200$/m);
    expect(body).toMatch(/^\s*max_delay_ms: int = 10_000$/m);
    expect(body).toMatch(/^\s*backoff_multiplier: float = 2\.0$/m);
    // Field docstrings must sit directly BELOW the field they describe
    // (Python attributes a bare string literal to the preceding assignment).
    // `enabled` documents the on/off switch; `retryable_errors` documents the set.
    expect(body).toMatch(
      /enabled: bool = True\n\s*"""If True, retry on TransportError \+ InternalError \(5xx\) \+ RateLimitError\.\s*\n?\s*If False, never retry\."""/,
    );
    expect(body).toMatch(
      /retryable_errors: tuple\[type\[BaseException\], \.\.\.\] = field\(\s*\n\s*default_factory=lambda: \(TransportError, RateLimitError, InternalError\)\s*\n\s*\)\n\s*"""Errors that ARE retryable when retries are enabled\."""/,
    );
  });

  it('_backoff_delay_ms: Retry-After (seconds * 1000) wins capped at max_delay_ms; otherwise initial * multiplier^attempt capped + full-jitter random.uniform(0, capped)', () => {
    expect(body).toMatch(
      /^def _backoff_delay_ms\(attempt: int, cfg: RetryConfig, retry_after_seconds: int \| None\) -> int:$/m,
    );
    expect(body).toMatch(/"""Compute the next sleep with full jitter; cap at ``max_delay_ms``\./);
    expect(body).toMatch(/If the server set a POSITIVE ``Retry-After`` \(rate-limit case\), it/);
    expect(body).toMatch(/wins — we never retry sooner than the server asks\. Otherwise, and/);
    // Wrap-tolerant: the phrase spans a line break in the docstring.
    expect(body).toMatch(/exponential-backoff with full jitter\s*\n?\s*\(random uniform between 0/);
    expect(body).toMatch(/and the next exponential value\)\./);
    // Gated on a strictly-positive hint. A non-positive value carries no
    // information and the hint path has no jitter, so returning it produced a
    // fixed 0 ms sleep — a tight, lockstep retry loop. Cross-SDK parity for
    // this boundary is held in cross-sdk-retry-policy-parity.
    expect(body).toMatch(
      /if retry_after_seconds is not None and retry_after_seconds > 0:\s*\n\s*return min\(retry_after_seconds \* 1000, cfg\.max_delay_ms\)/,
    );
    expect(body).toMatch(
      /capped = min\(cfg\.initial_delay_ms \* \(cfg\.backoff_multiplier\*\*attempt\), cfg\.max_delay_ms\)\s*\n\s*return int\(random\.uniform\(0, capped\)\)/,
    );
  });

  it('with_retry sync: enabled-False fast path + attempt loop catches retryable_errors + delegates Retry-After only on RateLimitError + time.sleep(ms/1000) + DriftstackError propagates immediately', () => {
    expect(body).toMatch(
      /^def with_retry\(fn: Callable\[\[\], T\], cfg: RetryConfig \| None = None\) -> T:\s*\n\s*"""Run ``fn`` with retries per ``cfg``\. Synchronous variant\."""\s*\n\s*config = cfg or RetryConfig\(\)\s*\n\s*if not config\.enabled:\s*\n\s*return fn\(\)/m,
    );
    expect(body).toMatch(
      /attempt = 0\s*\n\s*while True:\s*\n\s*try:\s*\n\s*return fn\(\)\s*\n\s*except config\.retryable_errors as err:/,
    );
    expect(body).toMatch(/if attempt >= config\.max_retries:\s*\n\s*raise/);
    expect(body).toMatch(
      /retry_after = err\.retry_after_seconds if isinstance\(err, RateLimitError\) else None\s*\n\s*time\.sleep\(_backoff_delay_ms\(attempt, config, retry_after\) \/ 1000\)/,
    );
    expect(body).toMatch(
      /except DriftstackError:\s*\n\s*# Non-retryable typed error — propagate immediately\.\s*\n\s*raise/,
    );
  });

  it('with_retry_async: same surface but await fn + asyncio.sleep(ms/1000) + lazy import asyncio inside the function + _Awaitable type-import forward-declared at module bottom (noqa: E402)', () => {
    expect(body).toMatch(
      /^async def with_retry_async\(\s*\n\s*fn: Callable\[\[\], _Awaitable\[T\]\],\s*\n\s*cfg: RetryConfig \| None = None,\s*\n\) -> T:\s*\n\s*"""Run an async ``fn`` with retries\. Mirrors :func:`with_retry`\."""\s*\n\s*import asyncio/m,
    );
    expect(body).toMatch(
      /await asyncio\.sleep\(_backoff_delay_ms\(attempt, config, retry_after\) \/ 1000\)/,
    );
    expect(body).toMatch(/# Forward-declare for the async type hint above\./);
    expect(body).toMatch(/^from collections\.abc import Awaitable as _Awaitable {2}# noqa: E402$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
