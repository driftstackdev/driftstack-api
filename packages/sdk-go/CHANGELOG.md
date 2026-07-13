# Changelog

All notable changes to the Driftstack Go SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`client.Team.ListOwners(ctx)`** — typed access to
  `GET /v1/team/owners` for owner workspaces the calling account has
  joined. Returns `TeamOwnersList` / `TeamOwner` and requires broad
  `read` (or `account_owner`).
- **`BadRequestError`** + **`ErrBadRequest`** sentinel — the generic
  `bad-request` problem-type (HTTP 400, no field-level issues) now maps
  to a dedicated `BadRequestError` (sibling of `ValidationError`),
  mirroring the TypeScript + Python SDKs. `validation-failed` continues
  to map to `ValidationError`.

### Changed

- **Minor behaviour change:** a generic 400 (`bad-request` problem-type)
  now surfaces as `*BadRequestError` instead of `*ValidationError`.
  Callers matching `errors.As(err, &ValidationError{})` /
  `errors.Is(err, ErrValidation)` on a generic 400 should switch to
  `*BadRequestError` / `ErrBadRequest`. `validation-failed` 400s are
  unaffected. `IsRetryable` is unaffected (both 400 types stay
  non-retryable).

### Added

- **`ProxyID`** (`proxy_id`) on the agent-session create request — route
  the session's egress through one of your account proxies (managed at
  `/v1/account/me/proxies`). Must be an owned proxy id (unknown / not-owned
  → 404). Empty string omits it (default egress).
- **`EventSessionProfileSaveFailed`** (`session.profile_save_failed`) —
  webhook event constant for a profile-backed session whose save-back
  failed at teardown (the session itself succeeded; terminal — the next
  restore of that profile will be stale). Subscribable; payload carries
  `session_id`, `profile_id`, `reason`
  (`serialize_failed|seal_failed|too_large|upload_failed`) and an
  optional `detail`.

- **`Session.EgressCapabilityReport`** (Arc 5 EGRESS eg.1.g) —
  raw harness-emitted event payload as `map[string]any` (with
  `json:"egress_capability_report"` tag), stored alongside the
  derived `EgressCapabilities` view. Forensics + schema-evolution
  safety net: surfaces fields the SDK schema doesn't formally know
  (e.g. harness-side diagnostic counters) without requiring an SDK
  release. Consumers should prefer `EgressCapabilities` for typed
  access; this is opaque map for inspection / observability piping.
  Round-trip unmarshalling tests (eg.1.g.2) pin both populated and
  null wire-shape cases.
- **`client.AgentSessions.Takeover(ctx, id, clientID)`** +
  **`.Handback(ctx, id)`** (v2-#8 Arc 2 sub-slice 8.9) — pair-mode
  state-machine wrappers. Takeover requests a human to take control
  of a `mode: 'pair'` agent session (state machine transitions
  `ai-driving → takeover-pending`, or `takeover-queued` when the
  runtime is mid-decompose); handback returns control to AI from
  `human-driving`. Both return `*PairModeStateEnvelope` whose
  `PairModeState` is a `map[string]any` so callers can branch on
  the discriminator `["kind"]` + payload fields without a separate
  GET round-trip. Returns the SDK-mapped 409 errors on invalid
  transitions / non-pair sessions.
- **`client.Recipes.Create(ctx, CreateRecipeRequest{...})`**
  (AI-B4 / Q.5.d) — snapshot a finished agent-session's intent_log
  and transcript into a replayable recipe row. `AgentSessionID` and
  `Label` (1..120 chars after trim) are required; `Description`
  (≤2000 chars) is optional and omitted from the wire when empty
  (`json:"description,omitempty"`). Server assembles `intent_log`
  by flatMapping the source agent-session's transcript — each
  plan-executed turn's structured intent array contributes in turn
  order. Returns `*Recipe` including `IntentCount`. `AgentSessionID`
  on the response struct is `*string` so the server's ON DELETE SET
  NULL (recipe outlived its source session) decodes as a nil pointer
  cleanly. Read / list / execute / delete are v1.1 D2/D3 surfaces.
  503 until the deployment wires both `recipesRepo` and
  `agentSessionsRepo`.
- **`client.CryptoOrders.*`** (V-666 Go parity) — customer-facing
  crypto-checkout surface: `Quote`, `CreateCheckout` (with
  `*CreateCheckoutOptions{IdempotencyKey}` for V-666.AO header
  forwarding), `List` (with `*ListCryptoOrdersOptions{Limit, Status,
Cursor, CreatedAfter, CreatedBefore}`), `Iterate` (visit callback
  walks every cursor page — return `false` to stop early), `Get`,
  `UpdateNote`, `Cancel`, `Receipt`. New `ListCryptoOrdersResponse`
  struct exposes `Orders` + `NextCursor`. Returned envelopes are
  `map[string]any` pending an OpenAPI codegen pass. Crypto payments
  are non-refundable; cancellation only works while pending.
- **`requestOptions.headers`** (internal) — resource methods can now
  attach extra request headers (used today by
  `CryptoOrders.CreateCheckout` for `Idempotency-Key`). Behaviour is
  unchanged for every existing resource that doesn't opt in.
- **`client.Webhooks.SendTest(ctx, webhookID)`** (V-463 / V-356) —
  send a synthetic `test.ping` delivery; bypasses subscription. Returns
  `*SendTestWebhookResponse` with the synthetic delivery id.
- **`client.Webhooks.Update(ctx, webhookID, *UpdateWebhookRequest)`**
  (V-464 / V-351) — partial-update a webhook endpoint. Pointer fields
  on the request struct distinguish "leave as-is" from "set"; at least
  one must be non-nil. Signing secret is NOT rotated by Update — use
  RotateSecret for that. Disabled endpoints can't be updated (409).
  New types: `UpdateWebhookRequest`, `SendTestWebhookResponse`.
- **`client.AuditLog.Export(ctx)`** (V-462 / V-297) — single-call JSON
  bulk-export of the calling account's audit log. Designed for GDPR
  Article 20 data-portability requests; up to 10,000 rows per call;
  response includes `Truncated bool` for the ceiling case. CSV download
  (browser-driven spreadsheet flow) is intentionally not surfaced
  through the SDK. New type: `AuditLogExportResponse`.
- **CLI/GUI activation flow** (V-460 / V-266) — three new methods on
  `client.Auth`: `CliAuthorizeInitiate`, `CliAuthorizeBind`, and
  `CliAuthorizeExchange`. Tools call `CliAuthorizeInitiate` for a
  `Code` + `BrowserURL`, open the URL, the user signs in + clicks
  Authorize, and the CLI/GUI polls `CliAuthorizeExchange` for one-shot
  delivery of the plaintext API key. Status discriminator on
  `CliAuthorizeExchangeResponse`: "pending" (keep polling) / "bound"
  (APIKey + AccountID populated; one-shot — subsequent calls 404) /
  "expired" (restart the flow). New types:
  `CliAuthorizeInitiateRequest` / `Response`,
  `CliAuthorizeBindRequest` / `Response`,
  `CliAuthorizeExchangeRequest` / `Response`.
- **`client.ProfileSnapshots`** — V-312 immutable point-in-time
  profile copies. Methods: `Capture(ctx, profileID, *CaptureSnapshotRequest)`,
  `ListForProfile(ctx, profileID, *ListProfileSnapshotsQuery)`,
  `List(ctx, *ListProfileSnapshotsQuery)` (cross-account),
  `Iterate(ctx, query, fn)`, `Get(ctx, snapshotID)`,
  `Restore(ctx, snapshotID, *RestoreSnapshotRequest)`,
  `Delete(ctx, snapshotID)`. New types: `ProfileSnapshot`,
  `CaptureSnapshotRequest`, `RestoreSnapshotRequest`,
  `ProfileSnapshotsListPage`, `ListProfileSnapshotsQuery`. `Restore`
  creates a NEW profile; the parent is never modified.
- **`client.Profiles.Clone(ctx, profileID, *CloneProfileRequest)`** —
  V-313 profile clone. Pass `nil` to let the server auto-derive
  `(copy)` / `(copy 2)` / ... naming; pass `&CloneProfileRequest{Name: …}`
  for an explicit name. New type: `CloneProfileRequest`.
- **`client.Webhooks.RotateSecret(ctx, webhookID)`** — V-359 webhook
  signing-secret rotation. Returns `*RotateWebhookSecretResponse`
  with fields `ID`, `Secret`, `SecretPrefix`, `PrevSecretPrefix`,
  `GraceExpiresAt`. Fresh plaintext shown ONCE; previous secret
  active for 24h. New type: `RotateWebhookSecretResponse`.
- **`client.Account.Me(ctx)`** (V-428) — V-385 full
  `/v1/account/me` rich-shape read. New `*AccountSelfProfile` carries
  15+ fields incl. `Slug`, `Region`, `AvatarURL`, `MfaEnrolled`,
  `Teams[]AccountTeamMembership`.

### Fixed (V-425 / V-426 / V-427 / V-429 / V-433)

Wire-shape correctness sweep against the live server. The Go SDK
had several response/request shapes that didn't match what the
server returns or accepts; customers calling these endpoints would
have hit JSON decode failures or 400s.

- **Auth flow responses** (V-425): `LoginResponse`,
  `VerifyEmailResponse`, `MagicLinkConsumeResponse`,
  `PasswordResetConfirmResponse`, `RefreshSessionResponse` — all
  were flat `{ AccountID, SessionToken, ExpiresAt }`; server returns
  nested `{ session: WebSession }`. Now correctly nested. New
  `WebSession` struct.
- **`LoginResponse` MFA branch** (V-425): now carries `MfaRequired`,
  `ChallengeToken`, `ChallengeExpiresAt` for V-353d's discriminated
  response. Customer code branches on `MfaRequired`.
- **Auth flow request fields** (V-425): `RefreshSessionRequest` and
  `LogoutRequest` had `SessionToken` (json `session_token`); server
  expects `Token` (json `token`). Renamed.
- **`SignupResponse`** (V-425): was `{ AccountID, VerifyEmailSent }`
  (server never returned that); now `{ VerificationEmailExpiresAt,
DebugToken? }` matching server.
- **`Profile`** (V-426): had stale `Persona`, `StorageState`, `Notes`,
  `AccountID`, `LastSessionID` fields not in server response; was
  missing `Archetype`. Now matches server's 7-field shape.
- **`CreateProfileRequest`/`UpdateProfileRequest`** (V-426): same
  staleness; `Persona`, `StorageState`, `Notes` removed (server's
  Zod parse silently dropped them); `Archetype` added to Create so
  customers can pin a non-default archetype.
- **`WebhookEndpoint`** (V-427): missing `PrevSecretPrefix`,
  `RotationGraceExpiresAt` (V-359), `DeliveryCounts` (V-185). Added.
  New helper `WebhookEndpointDeliveryCounts`.
- **`Subscription`** (V-429): was 5 fields; server returns 8.
  Missing `CanceledAt`, `CreatedAt`, `UpdatedAt`. Plus
  `StripeSubscriptionID` was `*string` (nullable); server requires
  it always-present (now `string`).
- **`GetBillingStateResponse.TrialPack`** (V-429): was
  `*TrialPackState`; server schema is non-nullable. Now value type.
- **`SessionPurpose` enum** (V-433): constants were
  `production_customer`/`recapture_run`/`fingerprint_probe`/
  `behavioural_capture`; server enum is `production_customer`/
  `cumulative_rig_validation`/`test_domain_probe`. Three of four
  values were broken; customer code passing
  `PurposeRecaptureRun` etc. would 400. Fixed.
- **`WebhookEventType`** (V-433): missing `EventTestPing` (V-356).
  Added.
- **Typed error coverage** (V-437/V-438): 7 new typed errors close
  the gap to TS SDK parity. New error types + `errors.Is` sentinels:
  `EmailAlreadyRegisteredError`, `InvalidCredentialsError`,
  `InvalidAuthTokenError`, `EmailNotVerifiedError`,
  `FeatureUnavailableError`, `MfaStepUpRequiredError`,
  `InternalError`. Customers can now `errors.As(err, &InvalidCredentialsError{})`
  on login or `errors.As(err, &MfaStepUpRequiredError{})` on
  step-up-gated operations instead of falling through to
  `UnknownError`.

### Added (V-445)

- **`client.Auth.MfaChallenge(ctx, *MfaChallengeRequest)`** — V-353d
  exchange of login challenge_token for a session via TOTP or
  recovery code. Response carries `Via = "totp" | "recovery"`.
- **`client.Auth.MfaStepUp(ctx, *MfaStepUpRequest)`** — V-353e
  refresh of `MfaSatisfiedAt` (15-minute freshness window). No new
  session issued. Pair with `MfaStepUpRequiredError` recovery:
  `errors.As(err, &MfaStepUpRequiredError{})` → call `MfaStepUp` →
  retry. New types: `MfaChallengeRequest / Response`,
  `MfaStepUpRequest / Response`.

### Added (V-448 / V-449 / V-450) — Account-surface parity

- **`client.Mfa`** — V-353b MFA enrollment management
  (`Status / Enroll / Verify / Disable / RegenerateRecoveryCodes`).
  New types: `MfaStatus`, `MfaEnrollResponse`, `MfaVerifyRequest /
Response`, `MfaDisableRequest`.
- **`client.AuditLog`** — V-216 audit-log read (`List / Iterate`).
  New types: `AuditLogEntry`, `AuditLogListPage`,
  `ListAuditLogQuery`.
- **`client.EmailPreferences`** — V-204 opt-in/opt-out toggles
  (`List / Set / OptIn / OptOut`). New types: `EmailPreference`,
  `ListEmailPreferencesResponse`, `SetEmailPreferenceRequest`.
- **`client.Account.UpdateMe(ctx, *UpdateMeRequest)`** — V-352
  partial PATCH /me.
- **`client.Account.UploadAvatar(ctx, *UploadAvatarRequest)`** +
  **`ClearAvatar(ctx)`** — V-352b.
- **`client.Account.ListWebSessions(ctx)`** +
  **`RevokeWebSession(ctx, sessionID)`** +
  **`RevokeAllOtherWebSessions(ctx)`** — V-355.
- **`client.Account.RateLimits(ctx)`** — V-258 effective rate-
  limit config.

Three-SDK Account-surface parity complete: every `/v1/account/*`
endpoint registered server-side is now exposed in all three SDKs.

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
