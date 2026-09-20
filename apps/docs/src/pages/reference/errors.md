---
layout: ../../layouts/DocLayout.astro
title: Error reference
description: Every Driftstack RFC 9457 problem-type — what it means, the SDK error class for each language, status code, and whether to retry.
---

# Error reference

Every error response from the Driftstack API is
an [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
JSON document. The `type` URI uniquely identifies the error class;
the `status` carries the HTTP status code; the `detail` field
explains what went wrong in human-readable text.

```json
{
  "type": "https://errors.driftstack.dev/rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Rate limit for \"global\" exceeded for tier \"api_starter\".",
  "retry_after_seconds": 12
}
```

The full mapping below covers every problem-type the API can
return, the matching SDK error class in each language, and
whether `isRetryable()` (TS / Python) / `IsRetryable()` (Go)
returns true for that class.

## Mapping table

| Problem-type URI                                     | HTTP | TypeScript                            | Python                                | Go                                    | Retryable? |
| ---------------------------------------------------- | ---- | ------------------------------------- | ------------------------------------- | ------------------------------------- | ---------- |
| `errors.driftstack.dev/bad-request`                  | 400  | `BadRequestError`                     | `BadRequestError`                     | `BadRequestError`                     | no         |
| `errors.driftstack.dev/validation-failed`            | 400  | `ValidationError`                     | `ValidationError`                     | `ValidationError`                     | no         |
| `errors.driftstack.dev/unauthorized`                 | 401  | `AuthError`                           | `AuthError`                           | `AuthError`                           | no         |
| `errors.driftstack.dev/invalid-key`                  | 401  | `InvalidKeyError`                     | `InvalidKeyError`                     | `InvalidKeyError`                     | no         |
| `errors.driftstack.dev/revoked-key`                  | 401  | `RevokedKeyError`                     | `RevokedKeyError`                     | `RevokedKeyError`                     | no         |
| `errors.driftstack.dev/expired-key`                  | 401  | `ExpiredKeyError`                     | `ExpiredKeyError`                     | `ExpiredKeyError`                     | no         |
| `errors.driftstack.dev/forbidden`                    | 403  | `ForbiddenError`                      | `ForbiddenError`                      | `ForbiddenError`                      | no         |
| `errors.driftstack.dev/mfa-step-up-required`         | 403  | `MfaStepUpRequiredError`              | `MfaStepUpRequiredError`              | `MfaStepUpRequiredError`              | no         |
| `errors.driftstack.dev/email-not-verified`           | 403  | `EmailNotVerifiedError`               | `EmailNotVerifiedError`               | `EmailNotVerifiedError`               | no         |
| `errors.driftstack.dev/not-found`                    | 404  | `NotFoundError`                       | `NotFoundError`                       | `NotFoundError`                       | no         |
| `errors.driftstack.dev/conflict`                     | 409  | `ConflictError`                       | `ConflictError`                       | `ConflictError`                       | no         |
| `errors.driftstack.dev/email-already-registered`     | 409  | `EmailAlreadyRegisteredError`         | `EmailAlreadyRegisteredError`         | `EmailAlreadyRegisteredError`         | no         |
| `errors.driftstack.dev/invalid-credentials`          | 401  | `InvalidCredentialsError`             | `InvalidCredentialsError`             | `InvalidCredentialsError`             | no         |
| `errors.driftstack.dev/invalid-auth-token`           | 400  | `InvalidAuthTokenError`               | `InvalidAuthTokenError`               | `InvalidAuthTokenError`               | no         |
| `errors.driftstack.dev/legal-acceptance-required`    | 409  | `LegalAcceptanceRequiredError`        | `LegalAcceptanceRequiredError`        | `LegalAcceptanceRequiredError`        | no         |
| `errors.driftstack.dev/rate-limited`                 | 429  | `RateLimitError`                      | `RateLimitError`                      | `RateLimitError`                      | **yes**    |
| `errors.driftstack.dev/concurrency-limit`            | 429  | `ConcurrencyLimitError`               | `ConcurrencyLimitError`               | `ConcurrencyLimitError`               | no         |
| `errors.driftstack.dev/tier-limit`                   | 429  | `TierLimitError`                      | `QuotaExceededError`                  | `QuotaExceededError`                  | no         |
| `errors.driftstack.dev/session-destroyed`            | 410  | `SessionDestroyedError`               | `SessionDestroyedError`               | `SessionDestroyedError`               | no         |
| `errors.driftstack.dev/session-timeout`              | 504  | `SessionTimeoutError`                 | `SessionTimeoutError`                 | `SessionTimeoutError`                 | no         |
| `errors.driftstack.dev/driver-error`                 | 502  | `DriverError`                         | `DriverError`                         | `DriverError`                         | no         |
| `errors.driftstack.dev/driver-not-integrated`        | 503  | `DriverNotIntegratedError`            | `DriverError`                         | `DriverError`                         | no         |
| `errors.driftstack.dev/feature-unavailable`          | 503  | `FeatureUnavailableError`             | `FeatureUnavailableError`             | `FeatureUnavailableError`             | no         |
| `errors.driftstack.dev/byok-anthropic-required`      | 502  | `ByokAnthropicRequiredError`          | `ByokAnthropicRequiredError`          | `ByokAnthropicRequiredError`          | no         |
| `errors.driftstack.dev/bundled-llm-budget-exhausted` | 402  | `BundledLlmBudgetExhaustedError`      | `BundledLlmBudgetExhaustedError`      | `BundledLlmBudgetExhaustedError`      | no         |
| `errors.driftstack.dev/bundled-llm-consent-required` | 402  | `BundledLlmConsentRequiredError`      | `BundledLlmConsentRequiredError`      | `BundledLlmConsentRequiredError`      | no         |
| `errors.driftstack.dev/pair-mode-conflict`           | 409  | `PairModeConflictError`               | `PairModeConflictError`               | `PairModeConflictError`               | no         |
| `errors.driftstack.dev/pair-mode-invalid-transition` | 409  | `PairModeStateInvalidTransitionError` | `PairModeStateInvalidTransitionError` | `PairModeStateInvalidTransitionError` | no         |
| `errors.driftstack.dev/storage-quota-exceeded`       | 409  | `StorageQuotaExceededError`           | `StorageQuotaExceededError`           | `StorageQuotaExceededError`           | no         |
| `errors.driftstack.dev/proxy-validation-failed`      | 422  | `ProxyValidationFailedError`          | `ProxyValidationFailedError`          | `ProxyValidationFailedError`          | no         |
| `errors.driftstack.dev/profile-in-use`               | 409  | `ProfileInUseError`                   | `ProfileInUseError`                   | `ProfileInUseError`                   | no         |
| `errors.driftstack.dev/internal`                     | 5xx  | `InternalError`                       | `InternalError`                       | `InternalError`                       | **yes**    |
| (network failure / parse error)                      | 0    | `TransportError`                      | `TransportError`                      | `TransportError`                      | **yes**    |

## When to retry

The SDKs all expose a public `isRetryable(err)` / `is_retryable` /
`IsRetryable` predicate that returns true for the three retryable
classes above. Use it from your own retry/backoff loop:

```ts
import { Driftstack, isRetryable } from '@driftstack/sdk';

for (let attempt = 0; attempt < 5; attempt++) {
  try {
    return await client.sessions.create();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await sleepWithBackoff(attempt, err);
  }
}
```

```python
from driftstack import Driftstack, is_retryable, RateLimitError

for attempt in range(5):
    try:
        return client.sessions.create()
    except Exception as err:
        if not is_retryable(err):
            raise
        wait = err.retry_after_seconds if isinstance(err, RateLimitError) else backoff(attempt)
        time.sleep(wait or backoff(attempt))
```

```go
request := &driftstack.CreateSessionRequest{}
for attempt := 0; attempt < 5; attempt++ {
    sess, err := client.Sessions.Create(ctx, request)
    if err == nil {
        return sess, nil
    }
    if !driftstack.IsRetryable(err) {
        return nil, err
    }
    var rl *driftstack.RateLimitError
    if errors.As(err, &rl) && rl.RetryAfterSeconds > 0 {
        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
    } else {
        time.Sleep(backoff(attempt))
    }
}
```

The built-in retry in each SDK does this automatically — see
the SDK quickstarts for the no-config retry path. Use the
`isRetryable` predicate when you have your own retry/circuit-
breaker library and want to integrate Driftstack errors.

## Why some 5xx aren't retryable

`DriverError` (502) and `DriverNotIntegrated` (503) are
**not** retryable because the cause is not transient (for
example, the requested device profile is unavailable). Retrying
the same call will not help. Surface the error to the user; the
[incidents page](https://driftstack.io/trust/incidents/) will show
any active outage.

`FeatureUnavailableError` (503) means a feature is not enabled
on this deployment (for example, avatar uploads). Retrying does
not change that; surface the error.

`MfaStepUpRequiredError` (403) means the customer needs to
prove fresh MFA before the request will succeed. Retrying
without an MFA prompt is the same as the first attempt;
prompt the customer first.

## AI agent messages

`POST /v1/agent-sessions/{id}/message` runs a browser task, so a few of the
rules above read differently there. The
[Run AI tasks from your code](/guides/run-ai-tasks-from-code/#errors-and-safe-retries)
guide has the full table.

- **The SDKs never retry `message()` for you**, whatever `isRetryable` says: a
  lost response may belong to a task that already ran. Retry it yourself.
- **A `502` (`ByokAnthropicRequiredError`) with `key_rejected: true`** means
  Anthropic refused your own key on the turn's first planning call. No step
  ran. `key_source` says which key (`header` or `stored`) and
  `key_rejected_reason` why: `invalid_or_unauthorized` (replace the key — test
  it with `POST /v1/account/me/byok-anthropic-key/test`) or `billing` (fix
  billing with Anthropic). Without `key_rejected` the same type means no key
  was available at all. A `500` (`InternalError`) on a message is never about
  your key.
- **`RateLimitError` (429) on a message** is the request rate, or your account
  already running as many AI turns at once as it may — across your sessions, or
  on bundled billing. `retry_after_seconds` says how long to wait. No step ran.
  (`ConcurrencyLimitError` is now only the open-session cap at create.)
- **`ConflictError` (409) with `session_status`** means the session was not
  active: `"closed"`, with `closed_reason` saying why, or `"paused"`. No second
  call is needed to read the reason.
- **`FeatureUnavailableError` (503)** on a message sent with an
  `Idempotency-Key` means the key could not be recorded and the turn did not
  run; on `POST /v1/agent-sessions/{id}/stop`, `stop_unconfirmed: true` means
  the stop could not be confirmed. Both are worth retrying yourself —
  `isRetryable` reports `false` for this class, so the SDKs will not. A `503`
  on Stop _without_ `stop_unconfirmed` means AI is not enabled here, and
  calling again will not help.
- **With an `Idempotency-Key`, a refusal raised before the turn did any work
  gives the key back** — the 409 `turn_in_progress`, the 429s, the 402s, the
  403s about the plan's AI or the model, and the 502 without `key_rejected`.
  Fix the cause or wait, then send the same request again with the same key.
  Every other answer is final for its key and replays; those need a new one.
  See [Idempotency](/reference/idempotency/).

## Cross-references

- [Idempotency keys](/reference/idempotency/) — when retrying a POST
  that creates a resource, send an `Idempotency-Key` header so the
  retry replays the original response instead of minting a duplicate.
- [Pagination](/reference/pagination/) — cursor-based pagination
  contract shared across every list endpoint; request shape,
  opaque-cursor semantics, and TS/Python/Go drive-to-completion loops.
- [Prometheus metrics](/reference/metrics/) — operators integrating
  Driftstack into their own observability stack: counter catalogue,
  bearer-token gate, suggested alert thresholds.
- [API key scopes](/reference/scopes/) — when a request returns
  `forbidden`, the `detail` names the required scope.
- [Rate limits](/reference/rate-limits/) — when a request returns
  `rate-limited`, the `Retry-After` header carries the wait time.
- [SDK quickstarts](/sdk/typescript-quickstart/) — built-in retry
  configuration for each language.
