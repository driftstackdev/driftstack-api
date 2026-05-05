# Changelog

All notable changes to the Driftstack Go SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes

- `0.1.0` is the inaugural alpha release. Tagged in the monorepo as
  `packages/sdk-go/v0.1.0` (Go modules sub-directory tagging
  convention) once the first publish lands.

## [0.2.0] - 2026-05-05

### Added

- **`AuthResource`** — new `client.Auth` for `/v1/auth/*` flows:
  `Signup`, `VerifyEmail`, `Login`, `RequestMagicLink`,
  `ConsumeMagicLink`, `RequestPasswordReset`, `ConfirmPasswordReset`,
  `Refresh`, `Logout`. Mirrors the TypeScript + Python SDK shape.
- **`BillingResource`** — new `client.Billing` for `/v1/billing`:
  `GetState`, `CreateCheckoutSession`, `StartTrialPack`,
  `CreatePortalSession`. Subscription + trial-pack state shapes
  added (`Subscription`, `TrialPackState`, `GetBillingStateResponse`).
- **`ProfilesResource`** — new `client.Profiles` for `/v1/profiles`:
  `Create`, `List`, `Iterate`, `Get`, `Update`, `Delete`. Iterator
  walks cursor pages; callback returns `(continue, error)`.
- **`SessionPurpose`** type + constants
  (`PurposeProductionCustomer`, `PurposeRecaptureRun`,
  `PurposeFingerprintProbe`, `PurposeBehaviouralCapture`) +
  `DefaultSessionPurpose` matching V-169 server-side schema.
  `CreateSessionRequest.Purpose` and `Session.Purpose` fields exposed.
- **`examples/billing_flow/main.go`** — server-side billing self-
  serve example.

### Changed

- **BREAKING — `AccountTier` enum** — replaced legacy values
  (`free`, `starter`, `solo`, `builder`, `scale`, `enterprise`) with
  the V-148 two-ladder restructure (`trial_pack`, `solo_manual`,
  `team_manual`, `agency_manual`, `api_starter`, `api_builder`,
  `api_scale`, `enterprise`). Old constants removed; consumers
  must update. Pre-1.0 SemVer permits the breakage.
- **`APIKeyScope` enum** — added `ScopeAccountOwner`,
  `ScopeDriftstackInternalAdmin`, `ScopeGUIControl` per V-174 split.
  The legacy `ScopeAdmin` token remains a compat alias.
- **`CreateSessionRequest.Archetype`** field exposed (server defaults
  to the locked archetype if empty, matching schema).

## [0.1.5] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error struct mapping the
  `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `TimeoutMs int` from the problem
  extension. Sentinel: `ErrSessionTimeout` for `errors.Is`
  matching. See V-044 in the control-plane repo.

  ```go
  err := client.Sessions.Interact(ctx, sid, body)
  if errors.Is(err, ErrSessionTimeout) {
      var ste *SessionTimeoutError
      if errors.As(err, &ste) {
          log.Printf("Op timed out after %d ms", ste.TimeoutMs)
      }
  }
  ```

- Test coverage at `errors_test.go::TestSessionTimeoutExtractsTimeoutMs`.

## [0.1.4] - 2026-05-03

### Removed

- `Offset` struct removed; `InteractAction.Offset` field dropped
  from the public surface. Same L-001 vector as `tap_at`: a
  coordinate primitive on the customer-facing schema lets the
  customer bypass the behavioral simulation layer for the offset
  portion of the interaction. Bounded coordinates are still
  coordinates. See `docs/locked-decisions.md` L-001 + V-042 in the
  control-plane repo.

### Migration

If your code constructs `InteractAction{Kind: "tap", Selector: ...,
Offset: &Offset{...}}` directly, drop the `Offset` field. The
`NewTapAction` constructor signature is unchanged (was already
selector-only). Re-express the intent through selector specificity:

```go
// Before (0.1.x):
action := InteractAction{
    Kind:     "tap",
    Selector: "button.cta",
    Offset:   &Offset{X: 0, Y: 50},
}

// After (0.1.4+):
action := NewTapAction("button.cta .icon-arrow")
```

Coordinate-level addressing for screenshot-driven workflows lives
on the gui-control plane and is not exposed in this SDK.

## [0.1.3] - 2026-05-03

### Fixed

- `NewTimeCondition(ms)` now emits `kind: "time"` on the wire (was
  `"time_ms"`, which the server's discriminated-union parser
  rejected with 400). Every Go customer call to
  `client.Wait(ctx, sid, NewTimeCondition(...))` was silently
  failing in 0.1.0–0.1.2.
- `NavigateRequest` gained the `TimeoutMS` field
  (`json:"timeout_ms,omitempty"`). The Zod schema accepts an
  optional `timeout_ms` in 1000–120000 ms range; TS/Python SDKs
  both expose it. Go customers can now set per-call navigate
  timeout overrides. Range validation happens server-side.

### Added

- `TestWaitConditionConstructors` and `TestNavigateRequestMarshalling`
  in `types_test.go`. Wire-shape regression coverage now matches
  the InteractAction tests added in 0.1.1.

## [0.1.2] - 2026-05-03

### Changed

- Re-cut: `Offset` struct kept for backwards-source-compat but
  `tap_at` / `type_focused` constructors removed (`NewTapAtAction`,
  `NewTypeFocusedAction`). Per L-001, customer-facing schemas stay
  intent-only. See V-036 in the control-plane repo.
- The `gui_control` API-key scope was added on the server side; it
  is a server-internal surface and doesn't appear in this SDK.

## [0.1.1] - 2026-05-02

### Fixed

- `NewScrollAction(x, y)` was emitting `{"x", "y"}` on the wire
  instead of `{"delta_x", "delta_y"}` — silently no-op'd by the
  server's `delta_x: 0, delta_y: 0` defaults. Renamed struct fields
  to `DeltaX`/`DeltaY` with proper JSON tags. Constructor signature
  is parameter-name-only — calls still type-check.

### Added

- `tap_at` and `type_focused` constructors briefly added (subsequently
  removed in 0.1.2 per L-001).
- `types_test.go` with marshalling round-trip tests for all
  `InteractAction` constructors. Catches the silent-noop class of
  bug locally before customer prod.

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
