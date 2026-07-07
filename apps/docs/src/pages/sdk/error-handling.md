---
layout: ../../layouts/DocLayout.astro
title: SDK error handling
description: Typed error hierarchy across the TypeScript / Python / Go SDKs; categorical try/catch patterns; retry semantics.
---

# SDK error handling

Every Driftstack SDK ships a typed error hierarchy mapping
`application/problem+json` responses (RFC 9457) to language-native
exceptions. Catch by category for control-flow logic; catch the
base type for blanket logging.

The hierarchy is consistent across TypeScript / Python / Go — the
type names + URI mapping are kept in sync via a single source of
truth (`PROBLEM_TYPE_TO_ERROR` per language, generated against the
server's OpenAPI 3.1 spec).

## Hierarchy

Server problem-type URIs live under the stable
`https://errors.driftstack.dev/<slug>` host and are pinned by
`PROBLEM_TYPES` in `@driftstack/api-types`. Dispatch on the slug,
not on HTTP status.

| Server problem-type slug              | TS class                       | Python exception               | Go type                                              | Retryable |
| ------------------------------------- | ------------------------------ | ------------------------------ | ---------------------------------------------------- | --------- |
| `unauthorized`                        | `AuthError`                    | `AuthError`                    | `*AuthError` (`ErrAuth`)                             | no        |
| `invalid-key`                         | `InvalidKeyError`              | `InvalidKeyError`              | `*InvalidKeyError` (`ErrInvalidKey`, also `ErrAuth`) | no        |
| `expired-key`                         | `ExpiredKeyError`              | `ExpiredKeyError`              | `*ExpiredKeyError` (`ErrExpiredKey`, also `ErrAuth`) | no        |
| `revoked-key`                         | `RevokedKeyError`              | `RevokedKeyError`              | `*RevokedKeyError` (`ErrRevokedKey`, also `ErrAuth`) | no        |
| `forbidden`                           | `ForbiddenError`               | `ForbiddenError`               | `*ForbiddenError`                                    | no        |
| `validation-failed`                   | `ValidationError`              | `ValidationError`              | `*ValidationError`                                   | no        |
| `not-found`                           | `NotFoundError`                | `NotFoundError`                | `*NotFoundError`                                     | no        |
| `conflict`                            | `ConflictError`                | `ConflictError`                | `*ConflictError`                                     | no        |
| `rate-limited`                        | `RateLimitError`               | `RateLimitError`               | `*RateLimitError`                                    | yes       |
| `concurrency-limit`                   | `ConcurrencyLimitError`        | `ConcurrencyLimitError`        | `*ConcurrencyLimitError`                             | no        |
| `tier-limit`                          | `TierLimitError`               | `QuotaExceededError`           | `*QuotaExceededError`                                | no        |
| `legal-acceptance-required`           | `LegalAcceptanceRequiredError` | `LegalAcceptanceRequiredError` | `*LegalAcceptanceRequiredError`                      | no        |
| `driver-not-integrated`               | `DriverNotIntegratedError`     | `DriverError`                  | `*DriverError`                                       | no        |
| `session-timeout`                     | `SessionTimeoutError`          | `SessionTimeoutError`          | `*SessionTimeoutError`                               | no        |
| `session-destroyed`                   | `SessionDestroyedError`        | `SessionDestroyedError`        | `*SessionDestroyedError`                             | no        |
| `internal`                            | `InternalError`                | `InternalError`                | `*InternalError` (`ErrInternal`)                     | yes       |
| transport (network / parse / timeout) | `TransportError`               | `TransportError`               | `*TransportError`                                    | yes       |

All extend `DriftstackError` in TypeScript and Python. Go exports
no base error type — every typed error embeds an unexported base
struct, so match a category with `errors.Is` against the exported
sentinels (`ErrAuth`, `ErrTransport`, …) or pull the concrete type
with `errors.As`, as the Go example below shows.

> **Catching the auth category:** the languages differ. In Python
> `InvalidKeyError` / `ExpiredKeyError` / `RevokedKeyError`
> subclass `AuthError`, so `except AuthError` catches all four. In
> TypeScript they extend `DriftstackError` directly — an
> `instanceof AuthError` check matches ONLY the `unauthorized`
> type, so check the key-specific classes explicitly. In Go, `errors.Is(err, ErrAuth)`
> matches the whole category; `errors.As(err, &auth *AuthError)`
> does not match the key-specific types.

> **Naming note:** for the `tier-limit` problem type the TypeScript SDK
> exports `TierLimitError` (the original name, shipped since 0.1.x),
> whereas the Python and Go SDKs name it `QuotaExceededError`. All three
> surface the same payload fields (`current` / `limit` / `recordType`,
> snake_case in Python).

## TypeScript

```ts
import {
  Driftstack,
  DriftstackError,
  AuthError,
  InvalidKeyError,
  ExpiredKeyError,
  RevokedKeyError,
  RateLimitError,
  ConcurrencyLimitError,
  TierLimitError,
  ValidationError,
} from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY! });

try {
  const session = await client.sessions.create();
  // ...
} catch (err) {
  if (
    err instanceof AuthError || // unauthorized
    err instanceof InvalidKeyError ||
    err instanceof ExpiredKeyError ||
    err instanceof RevokedKeyError
  ) {
    // re-mint key + retry, or surface to ops. NOTE: in TS the three
    // bad-key classes do NOT extend AuthError — check them explicitly.
  } else if (err instanceof ConcurrencyLimitError) {
    console.warn(`at concurrent ceiling: ${err.currentSessions}/${err.limit}`);
  } else if (err instanceof TierLimitError) {
    console.warn(`quota exceeded for ${err.recordType}: ${err.current}/${err.limit}`);
  } else if (err instanceof RateLimitError) {
    await sleep((err.retryAfterSeconds ?? 1) * 1000);
    // retry
  } else if (err instanceof ValidationError) {
    console.error('bad request:', err.message);
  } else if (err instanceof DriftstackError) {
    // catch-all for anything typed Driftstack
  } else {
    throw err; // not a Driftstack error
  }
}
```

The default retry policy (3 retries, exponential backoff with full
jitter, honours `Retry-After`) handles `TransportError`,
`RateLimitError`, and `InternalError` (5xx `internal`)
automatically. Other typed errors propagate
immediately so your code can route them.

## Python

```python
from driftstack import (
    Driftstack,
    AuthError,
    ConcurrencyLimitError,
    QuotaExceededError,
    RateLimitError,
    ValidationError,
    DriftstackError,
)

client = Driftstack(api_key="ds_live_…")

try:
    session = client.sessions.create()
except AuthError:
    ...
except ConcurrencyLimitError as e:
    print(f"at concurrent ceiling: {e.current_sessions}/{e.limit}")
except QuotaExceededError as e:
    print(f"quota exceeded for {e.record_type}: {e.current}/{e.limit}")
except RateLimitError as e:
    time.sleep(e.retry_after_seconds or 1)
except ValidationError as e:
    print(f"bad request: {e.message}")
except DriftstackError:
    raise  # catch-all for anything else typed Driftstack
```

## Go

```go
import (
    "errors"
    "time"

    driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

client := driftstack.New(os.Getenv("DRIFTSTACK_API_KEY"))
defer client.Close()

session, err := client.Sessions.Create(ctx, nil)
if err != nil {
    var auth *driftstack.AuthError
    if errors.As(err, &auth) {
        // matches ONLY the `unauthorized` problem type — for the whole
        // auth category (incl. invalid/expired/revoked key) use the
        // errors.Is(err, driftstack.ErrAuth) sentinel below.
    }

    var rl *driftstack.RateLimitError
    if errors.As(err, &rl) {
        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
        // retry
    }

    var cle *driftstack.ConcurrencyLimitError
    if errors.As(err, &cle) {
        log.Printf("at concurrent ceiling: %d/%d", cle.CurrentSessions, cle.Limit)
    }

    if errors.Is(err, driftstack.ErrAuth) {
        // sentinel-style match for AuthError category
    }

    log.Fatal(err)
}
```

`errors.As` for the structured payload, `errors.Is` for category
matching against the package-level sentinels (`ErrAuth`,
`ErrTransport`, etc.).

## Retry policy details

Retryable errors by default:

- `TransportError` (network / timeout / response parse failure).
- `RateLimitError` (HTTP 429). Honours the server's
  `retry-after-seconds` value when present.
- `InternalError` (the 5xx `internal` problem type).

Non-retryable: every other typed error. Auth errors aren't retried
because retrying with the same bad key won't help. Validation
errors aren't retried because the client request is wrong.
Concurrency / quota errors aren't retried because retrying without
freeing capacity will keep failing. The other 5xx-status typed
errors (`DriverError` 502, `DriverNotIntegratedError` 503,
`SessionTimeoutError` 504) are treated as terminal and are NOT
auto-retried.

Override via constructor options:

**TypeScript:**

```ts
const client = new Driftstack({
  apiKey,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    // Backoff multiplier is fixed at 2× in the TS SDK (it is not a config
    // field; Python and Go expose it as backoff_multiplier / BackoffMultiplier).
  },
});
```

**Python:**

```python
from driftstack.retry import RetryConfig

client = Driftstack(
    api_key="ds_live_…",
    retry=RetryConfig(max_retries=5, initial_delay_ms=500, max_delay_ms=10_000),
)

# disable entirely (predictable testing):
client = Driftstack(api_key="…", retry=RetryConfig(enabled=False))
```

**Go:**

```go
client := driftstack.New(
    apiKey,
    driftstack.WithRetry(driftstack.RetryConfig{
        MaxRetries:        5,
        InitialDelay:      500 * time.Millisecond,
        MaxDelay:          10 * time.Second,
        BackoffMultiplier: 2.0,
    }),
)
// disable entirely:
client := driftstack.New(apiKey, driftstack.WithRetry(driftstack.RetryConfig{Disabled: true}))
```

## Cancellation

All three SDKs honour cancellation:

- **TypeScript**: pass an `AbortSignal` via per-call options
  (`{ signal }`). Aborting between retry attempts terminates the
  retry loop; aborting mid-request cancels the in-flight `fetch`.
- **Python**: the sync client uses thread-blocking sleeps; the
  async client uses `asyncio.sleep` and respects `asyncio.CancelledError`.
- **Go**: pass a `context.Context` first arg to every method.
  Cancelling the context aborts both the retry loop + the
  in-flight `http.Request`.

## Surfacing errors to your end users

The `message` field on every `DriftstackError` is human-readable
but technical. For customer-facing surfaces, map the error to a
user-friendly message:

```ts
function userMessageFor(err: unknown): string {
  if (err instanceof AuthError) return 'Your session expired — please sign in again.';
  if (err instanceof ConcurrencyLimitError) {
    return `You're at the maximum number of concurrent sessions (${err.limit}). Stop one before starting a new one.`;
  }
  if (err instanceof RateLimitError) return "We're going too fast — give it a moment.";
  if (err instanceof DriftstackError) return 'Something went wrong on our end.';
  return 'Unexpected error.';
}
```

Don't expose raw `DriftstackError.message` in customer UIs.

## See also

- [SDK installation](/sdk/installation/) — install + configure each
  SDK.
- [Quickstart](/quickstart/) — first session in five minutes.
- [Webhook events](/webhooks/events/) — server-pushed events use a
  separate signature-verification path; not error-handling.
