// W776 — apps/docs sdk/error-handling.md content parity. One-
// hundred-second in the cross-SDK drift-guard series.
//
// /sdk/error-handling is the cross-SDK typed-error reference. Drift
// to the problem-type-URI table or the retry-policy framing would
// let SDK consumers' expectations diverge from generated error
// classes + server's RFC 7807 problem-detail emissions.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/error-handling.md');
const TS_SDK_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const TS_SDK_RETRY = resolve(REPO_ROOT, 'packages/sdk-typescript/src/retry.ts');

describe('W776 docs /sdk/error-handling content parity', () => {
  it('sdk/error-handling.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned. Description threads typed-error + try/catch + retry across TS/Python/Go.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: SDK error handling\n/,
    );
    expect(p).toMatch(
      /description: Typed error hierarchy across the TypeScript \/ Python \/ Go SDKs; categorical try\/catch patterns; retry semantics\./,
    );
  });

  it("CRITICAL RFC 9457 + categorical-catch framing pinned. The 'Every Driftstack SDK ships a typed error hierarchy mapping application/problem+json responses (RFC 9457) to language-native exceptions. Catch by category for control-flow logic; catch the base type for blanket logging' wording is the load-bearing error-protocol contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Every Driftstack SDK ships a typed error hierarchy mapping\s*\n?`application\/problem\+json` responses \(RFC 9457\) to language-native\s*\n?exceptions\./,
    );
    expect(p).toMatch(/Catch by category for control-flow logic; catch the/);
    expect(p).toMatch(/base type for blanket logging\./);
    // Ban the superseded RFC 7807 reference — the corrected doc moved to RFC 9457.
    expect(p).not.toMatch(/\(RFC 7807\)/);
  });

  it("CRITICAL PROBLEM_TYPE_TO_ERROR cross-SDK source-of-truth framing pinned. The 'type names + URI mapping are kept in sync via a single source of truth (PROBLEM_TYPE_TO_ERROR per language, generated against the server\\'s OpenAPI 3.1 spec)' wording explains the cross-SDK consistency mechanism.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The hierarchy is consistent across TypeScript \/ Python \/ Go — the\s*\n?type names \+ URI mapping are kept in sync via a single source of\s*\n?truth \(`PROBLEM_TYPE_TO_ERROR` per language, generated against the\s*\n?server's OpenAPI 3\.1 spec\)\./,
    );
  });

  it("CRITICAL dispatch-on-slug-not-status framing pinned. The 'Server problem-type URIs live under the stable https://errors.driftstack.dev/<slug> host and are pinned by PROBLEM_TYPES in @driftstack/api-types. Dispatch on the slug, not on HTTP status' wording is the load-bearing API-versioning-aware error-dispatch contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Server problem-type URIs live under the stable\s*\n?`https:\/\/errors\.driftstack\.dev\/<slug>` host and are pinned by\s*\n?`PROBLEM_TYPES` in `@driftstack\/api-types`\. Dispatch on the slug,\s*\n?not on HTTP status\./,
    );
  });

  it('CRITICAL 15-row error-hierarchy table pinned. Drift to dropping any row would let SDK consumers fail to handle that error class. The 15-class catalog covers auth/forbidden/validation/not-found/conflict/rate-limit/concurrency/tier-limit/legal-acceptance/driver-not-integrated/session-timeout/session-destroyed/transport.', () => {
    const p = read(PAGE);

    for (const slug of [
      'invalid-key',
      'expired-key',
      'revoked-key',
      'forbidden',
      'validation-failed',
      'not-found',
      'conflict',
      'rate-limited',
      'concurrency-limit',
      'tier-limit',
      'legal-acceptance-required',
      'driver-not-integrated',
      'session-timeout',
      'session-destroyed',
    ]) {
      expect(p, `error slug ${slug}`).toMatch(new RegExp(`\\| \`${slug}\``));
    }
    // Transport is the special non-slug row.
    expect(p).toMatch(/\| transport \(network \/ parse \/ timeout\) \| `TransportError`/);
  });

  it('CRITICAL tier-limit TS class is TierLimitError, NOT QuotaExceededError. The TS SDK kept the historical 0.1.x `TierLimitError` name while Python/Go expose `QuotaExceededError` for the same `tier-limit` problem type. The doc table + TS code example must import/catch the class the TS SDK actually exports, or the snippet fails to compile (regression: docs once showed QuotaExceededError in the TS column + example).', () => {
    // Source of truth: TS SDK exports TierLimitError and has NO QuotaExceededError class.
    const sdk = read(TS_SDK_ERRORS);
    expect(sdk).toMatch(/export class TierLimitError extends DriftstackError/);
    expect(sdk).not.toMatch(/export class QuotaExceededError/);

    const p = read(PAGE);
    // Table row: TS column = TierLimitError; Python + Go columns = QuotaExceededError.
    expect(p).toMatch(
      /\| `tier-limit`\s+\| `TierLimitError`\s+\| `QuotaExceededError`\s+\| `\*QuotaExceededError`\s+\| no\s+\|/,
    );
    // TS example imports + catches the real export (single-line discrete pins — no backtracking chains).
    expect(p).toMatch(/\n {2}TierLimitError,\n/);
    expect(p).toMatch(/} else if \(err instanceof TierLimitError\) \{/);
    // And does NOT reintroduce a TS `instanceof QuotaExceededError`.
    expect(p).not.toMatch(/instanceof QuotaExceededError/);
  });

  it("CRITICAL bad-key slug mapping pinned — invalid-key/expired-key/revoked-key map to the TYPED classes, not AuthError. S36 2026-07-07 (fable-truth-audit): the old all-map-to-AuthError rows were FALSE for TS and Go — TS TYPE_TO_CTOR maps them to InvalidKeyError/ExpiredKeyError/RevokedKeyError which extend DriftstackError directly (NOT AuthError; sdk-typescript/src/errors.ts), and Go builds typed errors that only match ErrAuth via the errors.Is sentinel. Python alone subclasses AuthError. The doc's catching-the-auth-category note carries the per-language truth.", () => {
    const p = read(PAGE);

    // unauthorized is the ONLY slug that maps to AuthError itself.
    expect(p).toMatch(
      /\| `unauthorized`\s+\| `AuthError`\s+\| `AuthError`\s+\| `\*AuthError` \(`ErrAuth`\)/,
    );
    for (const cls of ['InvalidKeyError', 'ExpiredKeyError', 'RevokedKeyError']) {
      const slug = cls
        .replace('Error', '')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase();
      expect(p, `${slug} → ${cls}`).toMatch(
        new RegExp(`\\| \`${slug}\`\\s+\\| \`${cls}\`\\s+\\| \`${cls}\``),
      );
    }
    expect(p).toMatch(
      // Wrap-tolerant: prettier reflows this blockquote freely.
      /In[\s>]+TypeScript they extend `DriftstackError` directly — an[\s>]+`instanceof AuthError` check matches ONLY the `unauthorized`[\s>]+type/,
    );
    // Negative pin — the false TS AuthError mapping must not come back.
    expect(p).not.toMatch(/\| `invalid-key`\s+\| `AuthError`/);
  });

  it("CRITICAL Retryable column pinned — rate-limited + internal + transport are yes. S36 2026-07-07 (fable-truth-audit): InternalError (5xx `internal`) IS auto-retried by the built-in loop in all three SDKs (TS retry.ts isRetryable kind 'internal'; Python retry.py retryable_errors tuple; Go errors.go IsRetryable) — the old only-transport+rate-limit claim contradicted every SDK and reference/errors.md's own table. The other 5xx typed errors (DriverError 502 / DriverNotIntegratedError 503 / SessionTimeoutError 504) stay terminal.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\| `rate-limited`\s+\| `RateLimitError`\s+\| `RateLimitError`\s+\| `\*RateLimitError`\s+\| yes\s+\|/,
    );
    expect(p).toMatch(
      /\| `internal`\s+\| `InternalError`\s+\| `InternalError`\s+\| `\*InternalError` \(`ErrInternal`\)\s+\| yes\s+\|/,
    );
    expect(p).toMatch(
      /\| `TransportError`\s+\| `TransportError`\s+\| `\*TransportError`\s+\| yes\s+\|/,
    );
    expect(p).toMatch(/- `InternalError` \(the 5xx `internal` problem type\)\./);
    expect(p).toMatch(
      /Auth errors aren't retried\s*\n?because retrying with the same bad key won't help\. Validation\s*\n?errors aren't retried because the client request is wrong\./,
    );
    expect(p).toMatch(
      /Concurrency \/ quota errors aren't retried because retrying without\s*\n?freeing capacity will keep failing\./,
    );
    expect(p).toMatch(
      /The other 5xx-status typed\s*\n?errors \(`DriverError` 502, `DriverNotIntegratedError` 503,\s*\n?`SessionTimeoutError` 504\) are treated as terminal and are NOT\s*\n?auto-retried\./,
    );
  });

  it("CRITICAL Go ErrAuth sentinel-style match framing pinned. The 'errors.As for the structured payload, errors.Is for category matching against the package-level sentinels (ErrAuth, ErrTransport, etc.)' wording explains the 2-style Go error idiom.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`errors\.As` for the structured payload, `errors\.Is` for category\s*\n?matching against the package-level sentinels \(`ErrAuth`,\s*\n?`ErrTransport`, etc\.\)\./,
    );
  });

  it('CRITICAL default-retry-policy framing pinned. S36 2026-07-07 (fable-truth-audit): the default retry loop handles TransportError + RateLimitError + InternalError (5xx internal) in all three SDKs; the old two-class claim under-stated the real retryable set.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The default retry policy \(3 retries, exponential backoff with full\s*\n?jitter, honours `Retry-After`\) handles `TransportError`,\s*\n?`RateLimitError`, and `InternalError` \(5xx `internal`\)\s*\n?automatically\./,
    );
    expect(p).toMatch(
      /Other typed errors propagate\s*\n?immediately so your code can route them\./,
    );
  });

  it('CRITICAL TS retry-config 3-field shape pinned — maxAttempts/initialDelayMs/maxDelayMs. The TS RetryConfig has NO backoffMultiplier (the multiplier is fixed at 2× internally; only Python/Go expose it as a config field). A doc example setting backoffMultiplier on the TS RetryConfig would be a TS excess-property compile error (regression: it once did).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/maxAttempts: 5,/);
    expect(p).toMatch(/initialDelayMs: 500,/);
    expect(p).toMatch(/maxDelayMs: 10_000,/);

    // Source of truth: the TS RetryConfig interface has no backoffMultiplier field.
    const retrySrc = read(TS_SDK_RETRY);
    expect(retrySrc).toMatch(/interface RetryConfig/);
    expect(retrySrc).not.toMatch(/backoffMultiplier/);
    // So the TS example must NOT set it (Python/Go RetryConfig examples may).
    expect(p).not.toMatch(/backoffMultiplier: 2,/);
  });

  it('CRITICAL Python RetryConfig 3-field shape pinned — max_retries/initial_delay_ms/max_delay_ms + enabled=False disable. Drift to inconsistent field names cross-language would mismatch SDK contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /retry=RetryConfig\(max_retries=5, initial_delay_ms=500, max_delay_ms=10_000\)/,
    );
    expect(p).toMatch(/retry=RetryConfig\(enabled=False\)/);
  });

  it('CRITICAL Go RetryConfig 4-field shape pinned — MaxRetries/InitialDelay/MaxDelay/BackoffMultiplier (Duration types). Plus Disabled: true alternative.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/MaxRetries:\s+5,/);
    expect(p).toMatch(/InitialDelay:\s+500 \* time\.Millisecond,/);
    expect(p).toMatch(/MaxDelay:\s+10 \* time\.Second,/);
    expect(p).toMatch(/BackoffMultiplier: 2\.0,/);
    expect(p).toMatch(/driftstack\.RetryConfig\{Disabled: true\}/);
  });

  it('CRITICAL 3-cancellation idiom set pinned — TS AbortSignal + Python asyncio.CancelledError + Go context.Context. Drift to a different idiom would break customer cancellation logic.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\*\*TypeScript\*\*: pass an `AbortSignal` via per-call options\s*\n?\s+\(`\{ signal \}`\)/,
    );
    expect(p).toMatch(/async client uses `asyncio\.sleep` and respects `asyncio\.CancelledError`/);
    expect(p).toMatch(/\*\*Go\*\*: pass a `context\.Context` first arg to every method\./);
    expect(p).toMatch(
      /Cancelling the context aborts both the retry loop \+ the\s*\n?\s+in-flight `http\.Request`\./,
    );
  });

  it("CRITICAL user-facing-message mapping framing pinned. The 'The message field on every DriftstackError is human-readable but technical. For customer-facing surfaces, map the error to a user-friendly message' wording + 'Don\\'t expose raw DriftstackError.message in customer UIs' is the canonical separation-of-concerns guidance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The `message` field on every `DriftstackError` is human-readable\s*\n?but technical\. For customer-facing surfaces, map the error to a\s*\n?user-friendly message:/,
    );
    expect(p).toMatch(/Don't expose raw `DriftstackError\.message` in customer UIs\./);
  });

  it("CRITICAL example user-messages pinned — AuthError ('Your session expired — please sign in again.') + ConcurrencyLimitError ('You\\'re at the maximum number of concurrent sessions...') + RateLimitError ('We\\'re going too fast — give it a moment.'). Drift to a different wording would mismatch dashboard customer-comms patterns.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/'Your session expired — please sign in again\.'/);
    expect(p).toMatch(/`You're at the maximum number of concurrent sessions \(\$\{err\.limit\}\)/);
    expect(p).toMatch(/"We're going too fast — give it a moment\."/);
  });

  it('CRITICAL ConcurrencyLimitError + QuotaExceededError surfaced-field framing pinned. ConcurrencyLimitError has currentSessions + limit; QuotaExceededError has recordType + current + limit. Drift to a different field name would break SDK consumer error-handling logic.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/err\.currentSessions/);
    expect(p).toMatch(/err\.recordType/);
    expect(p).toMatch(/err\.current/);
    expect(p).toMatch(/err\.limit/);

    // Python snake_case variants.
    expect(p).toMatch(/e\.current_sessions/);
    expect(p).toMatch(/e\.record_type/);
  });

  it('CRITICAL Go errors.As / errors.Is dual-idiom pinned. errors.As(err, &auth) for structured access; errors.Is(err, driftstack.ErrAuth) for category match. Both demonstrated in the Go snippet.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/errors\.As\(err, &auth\)/);
    expect(p).toMatch(/errors\.Is\(err, driftstack\.ErrAuth\)/);
  });

  it("CRITICAL base-class framing pinned. S36 2026-07-07 (fable-truth-audit): the old '*DriftstackError (Go base struct embedded in every typed error)' claim was FALSE — sdk-go exports NO DriftstackError type; the embedded base is the unexported apiError (errors.go), so Go callers match categories via the exported sentinels with errors.Is. TS + Python really do extend DriftstackError.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /All extend `DriftstackError` in TypeScript and Python\. Go exports\s*\n?no base error type — every typed error embeds an unexported base\s*\n?struct/,
    );
    // Negative pin — the nonexistent Go export must not come back.
    expect(p).not.toMatch(/`\*DriftstackError`/);
  });

  it('CRITICAL 3-language try/catch idiomatic patterns pinned. TS uses instanceof + if-else chain; Python uses except-Class-as-e; Go uses errors.As pattern. The 3 idiomatic patterns demonstrate the cross-language consistency.', () => {
    const p = read(PAGE);

    // TS instanceof. (S36 2026-07-07: the auth arm now checks the three
    // bad-key classes explicitly — in TS they do NOT extend AuthError.)
    expect(p).toMatch(/err instanceof AuthError \|\| \/\/ unauthorized/);
    expect(p).toMatch(/err instanceof InvalidKeyError \|\|/);
    expect(p).toMatch(/if \(err instanceof ConcurrencyLimitError\)/);

    // Python except.
    expect(p).toMatch(/except AuthError:/);
    expect(p).toMatch(/except ConcurrencyLimitError as e:/);

    // Go errors.As.
    expect(p).toMatch(/var auth \*driftstack\.AuthError/);
    expect(p).toMatch(/var rl \*driftstack\.RateLimitError/);
    expect(p).toMatch(/var cle \*driftstack\.ConcurrencyLimitError/);
  });

  it('CRITICAL retryAfterSeconds / retry_after_seconds / RetryAfterSeconds framing pinned. The same field surfaced 3 ways across TS/Python/Go matches RateLimitError shape.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/err\.retryAfterSeconds/);
    expect(p).toMatch(/e\.retry_after_seconds/);
    expect(p).toMatch(/rl\.RetryAfterSeconds/);
  });

  it("CRITICAL 'See also' 3-link cross-references pinned — /sdk/installation/ + /quickstart/ + /webhooks/events/. The webhook-events 'server-pushed events use a separate signature-verification path; not error-handling' wording is the canonical scope-discrimination.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\[SDK installation\]\(\/sdk\/installation\/\)/);
    expect(p).toMatch(/\[Quickstart\]\(\/quickstart\/\)/);
    expect(p).toMatch(/\[Webhook events\]\(\/webhooks\/events\/\)/);
    expect(p).toMatch(
      /server-pushed events use a\s*\n?\s+separate signature-verification path; not error-handling\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-sdk-error-handling-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
