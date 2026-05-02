# Changelog

All notable changes to the Driftstack Go SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes

- `0.1.0` is the inaugural alpha release. Tagged in the monorepo as
  `packages/sdk-go/v0.1.0` (Go modules sub-directory tagging
  convention) once the first publish lands.

## [0.1.0] - 2026-05-02

### Added

- `Client` with sync-only API (Go's idiomatic concurrency is
  goroutines, not async/await; one client serves both shapes).
- Resource accessors mounted on the client: `Sessions` (9 methods),
  `APIKeys` (3), `Usage` (1), `Webhooks` (5). All take
  `context.Context` first.
- Error type hierarchy with sentinel errors (`ErrAuth`,
  `ErrRateLimit`, etc.) for `errors.Is` matching plus typed structs
  (`*RateLimitError`, `*ConcurrencyLimitError`, etc.) for `errors.As`
  payload extraction.
- `RetryConfig` + automatic retry on `*TransportError` and
  `*RateLimitError`. Honours `Retry-After`. `context.Cancel` aborts
  the retry loop between attempts.
- `VerifyWebhookSignature` helper (Stripe-style HMAC-SHA256,
  constant-time via `hmac.Equal`).
- Discriminated-union builders for `Interact` (`NewTapAction`,
  `NewTypeAction`, `NewScrollAction`, `NewPressAction`) and `Wait`
  (`NewSelectorCondition`, `NewSelectorHiddenCondition`,
  `NewURLMatchesCondition`, `NewTimeCondition`).
- 33 tests covering errors, retry, webhook signatures, and every
  resource method via `httptest.Server` mocks.
- 5 examples: `quickstart`, `error_handling`, `webhook_receiver`,
  `goroutine_pool`, `scraping_pipeline`.

### Build

- Module path:
  `github.com/driftstackdev/driftstack-api/packages/sdk-go`.
- Zero non-stdlib runtime dependencies.
- CI: `go vet` + `go test` on Ubuntu / Go 1.22.

### Notes (V-026)

- Types in `types.go` are hand-maintained, not codegen output —
  `oapi-codegen` doesn't yet support OpenAPI 3.1 nullable shorthand
  (`type: [string, null]`). Hand-writing is tractable at the current
  schema size and produces cleaner output.
- Same hand-written-over-codegen call as the TypeScript SDK (D-021).
