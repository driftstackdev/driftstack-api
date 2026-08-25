// W884 — RateLimitError retry_after_seconds cross-SDK invariant.
// Two-hundred-tenth in the drift-guard series. Pins the rate-
// limit response handling:
//
//   1. Body extension: `retry_after_seconds` (numeric; RFC 7807
//      catchall extension on rate-limited problem).
//   2. Header fallback: `Retry-After` HTTP header (RFC 6585).
//   3. Body wins over header; both default to 1s if missing.
//
// stays in lockstep across:
//   - packages/sdk-typescript/src/errors.ts (RateLimitError class
//     + errorFromProblem body-vs-header precedence).
//   - packages/sdk-go/error_mapping.go (buildRateLimit uses
//     intFromProblem(problem, "retry_after_seconds")).
//   - packages/sdk-go/errors.go (RateLimitError struct +
//     RetryAfterSeconds field).
//
// Drift would silently break:
//   * Customer retry logic missing the body extension (default
//     to 1s; rate-limit thrash).
//   * Header fallback ignored (server-only-sets-body customers
//     stuck).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W884 RateLimit retry-after cross-source invariant', () => {
  // ─── TS SDK RateLimitError class ─────────────────────────────

  it("CRITICAL packages/sdk-typescript/src/errors.ts RateLimitError class has readonly retryAfterSeconds: number. The 'Suggested wait before retrying. Sourced from retry_after_seconds extension or Retry-After header' framing pins the dual-source contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    expect(p).toMatch(/export class RateLimitError extends DriftstackError \{/);
    expect(p).toMatch(/readonly retryAfterSeconds: number;/);
    expect(p).toMatch(
      /Suggested wait before retrying\. Sourced from `retry_after_seconds` extension or `Retry-After` header/,
    );
  });

  it('CRITICAL TS SDK errorFromProblem() rate-limited branch reads body.retry_after_seconds FIRST, then Retry-After header, then defaults to 1. The body-wins-over-header precedence is the V-219 contract.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    expect(p).toMatch(
      /const fromBody = \(p as \{ retry_after_seconds\?: number \}\)\.retry_after_seconds;/,
    );
    expect(p).toMatch(
      /const fromHeader = retryAfterHeader !== null \? Number\(retryAfterHeader\) : NaN;/,
    );
    expect(p).toMatch(
      /const retryAfter = fromBody \?\? \(Number\.isFinite\(fromHeader\) \? fromHeader : 1\);/,
    );
  });

  // ─── Go SDK error_mapping.go ─────────────────────────────────

  it('CRITICAL packages/sdk-go/error_mapping.go buildRateLimit reads retry_after_seconds from the problem body via intFromProblem helper. The Go-side body-extension read mirrors TS.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go'));
    expect(p).toMatch(/intFromProblem\(problem, "retry_after_seconds"\)/);
    expect(p).toMatch(/return &RateLimitError\{apiError: base, RetryAfterSeconds: retryAfter\}/);
  });

  // ─── Go SDK RateLimitError struct ────────────────────────────

  it('CRITICAL packages/sdk-go/errors.go RateLimitError struct has RetryAfterSeconds int field (NOT *int — defaults to 0 if missing). The non-pointer int is what makes type-safe consumer pattern-match work without nil-checks.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/errors.go'));
    expect(p).toMatch(/type RateLimitError struct \{/);
    expect(p).toMatch(/RetryAfterSeconds int/);
  });

  it('CRITICAL Go SDK RateLimitError JSDoc usage-example pins the recommended retry pattern — "var rl *driftstack.RateLimitError" type-assertion + "time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)" wait. The example teaches Go customers the canonical retry pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/errors.go'));
    expect(p).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(p).toMatch(/time\.Sleep\(time\.Duration\(rl\.RetryAfterSeconds\) \* time\.Second\)/);
  });

  // ─── RateLimitError framing — '429 token-bucket' ──────────────

  it("CRITICAL Go SDK RateLimitError comment pins '429 token-bucket' framing — 'RetryAfterSeconds is the server's' hint. The token-bucket model matches V-219 server-side bucketConfigFor.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/errors.go'));
    expect(p).toMatch(/RateLimitError — 429 token-bucket\. RetryAfterSeconds is the server's/);
  });

  // ─── TS SDK retry-eligible vs not-retryable categorization ───

  it("CRITICAL TS SDK errors.ts header categorizes errors as 'retryable' vs 'NOT retryable' — 'rate_limited (429 with a Retry-After hint — back off then retry)' belongs to retryable. The categorization teaches consumers backoff strategy.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    expect(p).toMatch(
      /rate_limited.*429 with a Retry-After hint — back off then\s*\n\s*\*\s*retry/,
    );
    expect(p).toMatch(/NOT retryable:/);
  });

  // ─── retry_after_seconds is a body extension (catchall) ──────

  it('CRITICAL retry_after_seconds is an RFC 7807 CATCHALL extension on the rate-limited problem — NOT a typed field in ProblemSchema. The catchall pattern lets the server add fields without ProblemSchema schema migration; clients read via type-assertion.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    // retry_after_seconds is NOT declared as a typed field in ProblemSchema.
    const m = apiTypes.match(/ProblemSchema = z\s*\.object\(\{([\s\S]+?)\}\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body, 'retry_after_seconds must NOT be a typed field in ProblemSchema').not.toMatch(
      /retry_after_seconds:/,
    );
    // But the catchall accepts it.
    expect(apiTypes).toMatch(/\.catchall\(z\.unknown\(\)\)/);
  });

  // ─── 1-second fallback default ──────────────────────────────

  it('CRITICAL TS SDK rate-limit retryAfter defaults to 1 second if NEITHER body nor header is set. The 1-second default is the minimum reasonable wait — drift to 0 would let consumers tight-loop a rate-limit response.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    // The ternary 'Number.isFinite(fromHeader) ? fromHeader : 1' is the 1s fallback.
    expect(p).toMatch(/Number\.isFinite\(fromHeader\) \? fromHeader : 1/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rate-limit-retry-after-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
