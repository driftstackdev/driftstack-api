// W797 — cross-SDK error-handling-example parity. One-hundred-
// twenty-third in the drift-guard series. Pins the typed-error
// catch demos in lockstep across sdk-typescript / sdk-python /
// sdk-go. The 3 examples deliberately use language-idiomatic
// patterns (instanceof / except / errors.As), but the *set* of
// error classes demonstrated and the retry-loop shape need to stay
// synchronised — drift would let docs reference an error class
// only one SDK actually shows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/error-handling.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/error_handling.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/error_handling/main.go');

describe('W797 cross-SDK error-handling examples parity', () => {
  it('all 3 error-handling example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── TS-side: 9-error-class instanceof ladder ─────────────────

  it('CRITICAL TS imports all 9 documented error classes — ConcurrencyLimitError + DriftstackError + ExpiredKeyError + InvalidKeyError + NotFoundError + RateLimitError + RevokedKeyError + SessionDestroyedError + ValidationError. Drift to dropping any would leave docs/sdk/error-handling referencing a class the example does not exhibit.', () => {
    const p = read(TS);
    expect(p).toMatch(/ConcurrencyLimitError,/);
    expect(p).toMatch(/DriftstackError,/);
    expect(p).toMatch(/ExpiredKeyError,/);
    expect(p).toMatch(/InvalidKeyError,/);
    expect(p).toMatch(/NotFoundError,/);
    expect(p).toMatch(/RateLimitError,/);
    expect(p).toMatch(/RevokedKeyError,/);
    expect(p).toMatch(/SessionDestroyedError,/);
    expect(p).toMatch(/ValidationError,/);
  });

  it("CRITICAL TS 9-branch instanceof ladder pinned with DriftstackError catch-all last + throw err re-raise. The 'else if (err instanceof DriftstackError)' catch-all branch must come last so the more-specific subclasses match first; the final 'throw err' re-raises non-Driftstack errors (programmer bugs).", () => {
    const p = read(TS);
    expect(p).toMatch(/if \(err instanceof NotFoundError\)/);
    expect(p).toMatch(/} else if \(err instanceof SessionDestroyedError\)/);
    expect(p).toMatch(/} else if \(err instanceof ConcurrencyLimitError\)/);
    expect(p).toMatch(/} else if \(err instanceof RateLimitError\)/);
    expect(p).toMatch(/} else if \(err instanceof ValidationError\)/);
    expect(p).toMatch(/} else if \(err instanceof InvalidKeyError\)/);
    expect(p).toMatch(/} else if \(err instanceof RevokedKeyError\)/);
    expect(p).toMatch(/} else if \(err instanceof ExpiredKeyError\)/);
    expect(p).toMatch(/} else if \(err instanceof DriftstackError\)/);
    expect(p).toMatch(/throw err;/);
  });

  it('CRITICAL TS demonstrates the 3 typed-payload accessors. ConcurrencyLimitError.currentSessions/limit + RateLimitError.retryAfterSeconds + DriftstackError.status/title. Drift would lose the only quickstart-level demonstration of these fields.', () => {
    const p = read(TS);
    expect(p).toMatch(/err\.currentSessions \?\? '\?'.*err\.limit \?\? '\?'/);
    expect(p).toMatch(/err\.retryAfterSeconds\.toString\(\)/);
    expect(p).toMatch(/err\.status\.toString\(\)/);
    expect(p).toMatch(/err\.title/);
    expect(p).toMatch(/err\.detail/);
    expect(p).toMatch(/err\.issues/);
  });

  it("CRITICAL TS env-var fallback to 'ds_live_demo' pinned. The fallback lets the example RUN without env-var setup (so it can be docs-rendered + lint-checked); the real key is unrecognised, so the example always hits InvalidKeyError. Drift to dropping the fallback would force CI to inject a real key.", () => {
    const p = read(TS);
    expect(p).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY \?\? 'ds_live_demo'/);
  });

  it("CRITICAL TS 'ses_does-not-exist' session ID + void tryCall() entrypoint pinned. The literal ID is deliberately non-existent so the example demonstrates the 404 → NotFoundError path. Drift to a different ID would change the demo's expected outcome.", () => {
    const p = read(TS);
    expect(p).toMatch(/'ses_does-not-exist'/);
    expect(p).toMatch(/void tryCall\(\);/);
  });

  // ─── Python-side: 2-pattern demo (granular catch + retry loop) ─

  it('CRITICAL Python 6-error-class import set pinned — AuthError + ConcurrencyLimitError + Driftstack + DriftstackError + QuotaExceededError + RateLimitError + ValidationError. Python uses a coarser AuthError class (not InvalidKeyError/RevokedKeyError/ExpiredKeyError) by design — drift would re-introduce the granularity.', () => {
    const p = read(PY);
    expect(p).toMatch(
      /from driftstack import \(\s*\n\s+AuthError,\s*\n\s+ConcurrencyLimitError,\s*\n\s+Driftstack,\s*\n\s+DriftstackError,\s*\n\s+QuotaExceededError,\s*\n\s+RateLimitError,\s*\n\s+ValidationError,\s*\n\)/,
    );
  });

  it("CRITICAL Python 2-pattern framing pinned. '1. The simple catch — granular subclasses for granular reactions' + '2. Custom retry loop for a specific operation. The SDK already retries TransportError + RateLimitError automatically per RetryConfig; this is just for the demo'. Drift would lose the canonical SDK-already-retries disclaimer.", () => {
    const p = read(PY);
    expect(p).toMatch(/# 1\. The simple catch — granular subclasses for granular reactions\./);
    expect(p).toMatch(/# 2\. Custom retry loop for a specific operation\. The SDK already/);
    expect(p).toMatch(/# {4}retries TransportError \+ RateLimitError automatically per/);
    expect(p).toMatch(/# {4}RetryConfig; this is just for the demo\./);
  });

  it('CRITICAL Python 5-branch except ladder pinned — AuthError + ConcurrencyLimitError + QuotaExceededError + ValidationError + DriftstackError catch-all. Each returns a distinct exit code (2-6) so a shell wrapper can react.', () => {
    const p = read(PY);
    expect(p).toMatch(/except AuthError:[\s\S]*?return 2/);
    expect(p).toMatch(/except ConcurrencyLimitError as e:[\s\S]*?return 3/);
    expect(p).toMatch(/except QuotaExceededError as e:[\s\S]*?return 4/);
    expect(p).toMatch(/except ValidationError as e:[\s\S]*?return 5/);
    expect(p).toMatch(/except DriftstackError as e:[\s\S]*?return 6/);
  });

  it('CRITICAL Python retry-loop with exponential-backoff fallback pinned. The `wait = e.retry_after_seconds or (2**attempt)` pattern uses the server-provided Retry-After value when present, else 2^attempt seconds (so attempt 0 = 1s, attempt 4 = 16s). Drift would lose the canonical client-side retry demonstration.', () => {
    const p = read(PY);
    expect(p).toMatch(/for attempt in range\(5\):/);
    expect(p).toMatch(/except RateLimitError as e:/);
    expect(p).toMatch(/wait = e\.retry_after_seconds or \(2\*\*attempt\)/);
    expect(p).toMatch(/time\.sleep\(wait\)/);
    expect(p).toMatch(/print\("gave up after 5 retries"\)/);
    expect(p).toMatch(/return 7/);
  });

  it('CRITICAL Python typed-payload accessors pinned — current_sessions / limit on ConcurrencyLimitError + record_type / current / limit on QuotaExceededError + message on ValidationError + retry_after_seconds on RateLimitError. Field names use snake_case per Python convention; drift to camelCase would break consumers.', () => {
    const p = read(PY);
    expect(p).toMatch(/\(\{e\.current_sessions\}\/\{e\.limit\}\)/);
    expect(p).toMatch(/\{e\.record_type\} quota exhausted \(\{e\.current\}\/\{e\.limit\}\)/);
    expect(p).toMatch(/\{e\.message\}/);
    expect(p).toMatch(/e\.retry_after_seconds/);
  });

  // ─── Go-side: errors.As + errors.Is sentinel patterns ─────────

  it('CRITICAL Go errors.As + errors.Is sentinel pattern framing pinned. The header comment: "errors.As for payload, errors.Is for category" is the load-bearing teaching anchor — Go users expect both idioms.', () => {
    const p = read(GO);
    expect(p).toMatch(/errors\.As for\s*\n\/\/ payload, errors\.Is for category\./);
    expect(p).toMatch(/errors\.As\(err, &rl\)/);
    expect(p).toMatch(/errors\.As\(err, &cle\)/);
    expect(p).toMatch(/errors\.As\(err, &qe\)/);
    expect(p).toMatch(/errors\.Is\(err, driftstack\.ErrAuth\)/);
  });

  it("CRITICAL Go 4-typed-error catch set pinned — RateLimitError + ConcurrencyLimitError + QuotaExceededError + ErrAuth sentinel. Matches Python's 4-explicit + DriftstackError catch-all; matches TS's superset 9-class ladder.", () => {
    const p = read(GO);
    expect(p).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(p).toMatch(/var cle \*driftstack\.ConcurrencyLimitError/);
    expect(p).toMatch(/var qe \*driftstack\.QuotaExceededError/);
    expect(p).toMatch(/driftstack\.ErrAuth/);
  });

  it('CRITICAL Go retry-loop with shift-based exponential backoff pinned. The `wait = time.Duration(1<<attempt) * time.Second` pattern parallels Python `2**attempt` — attempt 0 = 1s, attempt 4 = 16s. Drift to a different backoff would break the cross-SDK retry-shape parallelism.', () => {
    const p = read(GO);
    expect(p).toMatch(/for attempt := 0; attempt < 5; attempt\+\+ \{/);
    expect(p).toMatch(/wait := time\.Duration\(rl\.RetryAfterSeconds\) \* time\.Second/);
    expect(p).toMatch(/wait = time\.Duration\(1<<attempt\) \* time\.Second/);
    expect(p).toMatch(/time\.Sleep\(wait\)/);
    expect(p).toMatch(/log\.Fatal\("gave up after 5 retries"\)/);
  });

  it("CRITICAL Go SDK-already-retries disclaimer pinned. The 'Most callers don\\'t need this — the SDK retries TransportError + RateLimitError automatically. Shown here as a recipe for finer control' wording matches Python's '#2 pattern' framing.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /Most callers\s*\n\s*\/\/ don't need this — the SDK retries TransportError \+ RateLimitError\s*\n\s*\/\/ automatically\. Shown here as a recipe for finer control\./,
    );
  });

  it('CRITICAL Go typed-payload accessors use PascalCase per Go convention — RetryAfterSeconds + CurrentSessions + Limit + RecordType + Current. Drift to snake_case would break Go consumers; drift to camelCase would un-export them.', () => {
    const p = read(GO);
    expect(p).toMatch(/rl\.RetryAfterSeconds/);
    expect(p).toMatch(/cle\.CurrentSessions, cle\.Limit/);
    expect(p).toMatch(/qe\.RecordType, qe\.Current, qe\.Limit/);
  });

  it('CRITICAL Go destroy-on-warn pinned. The final `log.Printf("warn: destroy failed: %v", err)` (not log.Fatal) keeps the example exit-clean even if the destroy itself errors — drift to Fatal would mask the demo outcome.', () => {
    const p = read(GO);
    expect(p).toMatch(/log\.Printf\("warn: destroy failed: %v", err\)/);
  });

  // ─── Cross-SDK shared invariants ──────────────────────────────

  it('CRITICAL all 3 examples demonstrate RateLimitError + ConcurrencyLimitError + ValidationError handling. These 3 are the canonical "expected-during-normal-operation" errors every integrator must handle; drift to dropping any from any SDK would create a documentation gap.', () => {
    expect(read(TS)).toMatch(/RateLimitError/);
    expect(read(TS)).toMatch(/ConcurrencyLimitError/);
    expect(read(TS)).toMatch(/ValidationError/);

    expect(read(PY)).toMatch(/RateLimitError/);
    expect(read(PY)).toMatch(/ConcurrencyLimitError/);
    expect(read(PY)).toMatch(/ValidationError/);

    expect(read(GO)).toMatch(/RateLimitError/);
    expect(read(GO)).toMatch(/ConcurrencyLimitError/);
  });

  it('CRITICAL all 3 examples reference retry-after / retry_after_seconds field on RateLimitError. The HTTP Retry-After header is the canonical rate-limit-retry signal; drift to ignoring it would create thundering-herd retry storms.', () => {
    expect(read(TS)).toMatch(/retryAfterSeconds/);
    expect(read(PY)).toMatch(/retry_after_seconds/);
    expect(read(GO)).toMatch(/RetryAfterSeconds/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-error-handling-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
