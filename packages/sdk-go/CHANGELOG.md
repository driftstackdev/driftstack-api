# Changelog

All notable changes to the Driftstack Go SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`AgentIntentResult.Warning`** — `*AgentStepWarning`, something worth
  knowing about a step that succeeded; `nil` means there is nothing to report.
  Its one kind today is `"http_error_status"`: a navigation reached the site
  and the site answered with an HTTP status of 400 or above, carried in
  `Status`. The step still succeeded — the page that loaded may be an error
  page, a page asking to sign in or to complete a verification step, or the
  whole page served under that status — and its `Summary` says what the site
  answered. `Kind` is an open set: treat a value you do not recognise as a
  note and read `Summary`.
- **Desktop browser sign-in: code verifier (PKCE).**
  `CliAuthorizeInitiateRequest.CodeChallenge` + `.CodeChallengeMethod`
  (`"S256"`) and `CliAuthorizeExchangeRequest.CodeVerifier`. A flow started
  with a challenge cannot be collected without the verifier, so the code and
  state in `BrowserURL` are no longer enough on their own. All three are
  `omitempty`: leaving them unset sends exactly the previous request.
- **`AgentSessionCapabilityReport.EgressState` can read
  `"default_connection_down"`.** A session started without a proxy of its own
  runs on the connection Driftstack provides; this value means that connection
  stopped carrying traffic while the session ran. It is on our side: there is
  nothing to fix at yours, and a session started with one of your own proxies
  runs now. `"dead_proxy"` keeps its meaning — your own proxy stopped. On
  `GET /v1/sessions/{id}` the same fact arrives as the
  `default_connection_down` code in `EgressCapabilities.Warnings`, and for
  that session a connection without UDP reads `quic_unavailable` and a failed
  check that its traffic left the right way reads `safeguard_failed` — never
  `udp_unsupported_by_proxy` or `safeguard_failed:proxy_egress_verification`,
  which name a proxy it does not have.
- **Error code `"default_egress_unavailable"`** in `AgentSessionErrorEvent.Code`,
  and as `AgentSession.ClosedReason`: a session with no proxy of its own could
  not connect through Driftstack's connection. It arrives with
  `CustomerActionable` `false` — ours to fix — and a session started with one
  of your own proxies runs now. `Code` stays a `string`, so nothing to change
  unless you branch on it.

### Deprecated

- Calling `Auth.CliAuthorizeInitiate` without `CodeChallenge`. It works as
  before until **31 January 2027**; responses carry `Deprecation` and
  `Sunset` headers, and from that date the server answers `400`.

## [0.4.0] - 2026-09-22

**Nothing was removed.** Every method, field and error type v0.3.0 published
still means the same thing, so upgrading takes no code change on its own —
except where **Migration** below says a string comparison needs updating.

### Added

- **`EgressCapabilities.Safeguards`** — `*string`, one of `"passed"`,
  `"failed"` or `"unverified"`, summarising whether every egress safeguard
  held for a session. `"failed"` wins whenever any check did not pass;
  `"passed"` only when the device declared the full set of checks a healthy
  session reports and every one of them reported back; `"unverified"`
  otherwise. `nil` on a session reported before this field existed — never
  read a `nil` `Safeguards` as `"unverified"` or `"passed"`. Rides everywhere
  `EgressCapabilities` already does: `client.Sessions.Get` / `.List` /
  `.Create`, `client.Profiles.Launch`, and the
  `session.egress_capability_changed` webhook payload.
- **`AccountProxyTestResult.MeasuredBy`** on a `?check=full` proxy test
  result (`client.Egress.TestProxy`) — `"phone"` when a real phone session
  took the measurement, `"driftstack"` when Driftstack itself did because no
  phone could be reached in time. `MeasuredFrom`, the field this replaces, is
  still sent beside it with its original values for existing integrations
  (now doc-commented `Deprecated`), but is no longer documented; read
  `MeasuredBy` from here on.
- **`AccountProxyOsFingerprint.DirectReading` and `.WebsiteLikeReading`** —
  the same two facts `SingleHostVantage` and `WebPortVantage` already carry,
  under plainer names, added beside the originals rather than replacing
  them. Present on the proxy test result **and** on each saved
  proxy returned by `client.Egress.ListProxies` / `.UpdateProxy`.
- **`"page_unreadable"`** joins the `NoticeReason` values a `plan-executed`
  turn can carry: the page could not be read to plan the next step, so the
  task stopped rather than guess. Send `continue` to try again.

### Changed

- **Two dead `EgressCapabilities.Warnings` codes are retired from the
  documentation**: `quic_disabled_fallback_http2` and
  `dns_remote_resolve_unsupported_by_proxy`. Neither has ever been sent, so
  this is a documentation correction, not a behavioural change. `Warnings`
  stays `[]string`.

### Migration

Two closed-string fields were narrowed — values removed, not added — on
`AccountProxyTestResult`, the result of `client.Egress.TestProxy`. Both
fields are plain `string`, not a Go enum type, so neither change fails to
compile: code comparing a value against one of the old strings simply stops
matching, silently. The server has sent the new values only since
2026-09-21.

- **`NotRun`** — `"node_busy"`, `"node_error"` and `"no_node"` merged into
  `"check_unavailable"` (you can do exactly one thing about any of the
  three: try again shortly, or contact support if it persists);
  `"unresolvable"` is now `"config_unresolvable"`, matching the word the
  "why a launch is refused" vocabulary already used for the identical fact.
  `"live_session"` is unchanged.
- **`OsFingerprintUnavailable`** — `"vpn_tunnel"` is now
  `"not_available_for_vpn"`, `"not_observed"` is now `"not_captured"`, and
  `"observer_off"` is now `"not_offered_here"`.

Update any code that compares `NotRun` or `OsFingerprintUnavailable` against
one of the old strings to compare against its replacement instead.

## [0.3.0] - 2026-09-20

The release the guide [Run AI tasks from your
code](https://docs.driftstack.io/guides/run-ai-tasks-from-code/) is written
against — the last tag, `packages/sdk-go/v0.1.6`, cannot run any of its
examples, because the AI agent was not reachable from it at all.

**Read this if you are upgrading from v0.1.6**, which almost everyone is:
`v0.2.0` below was written but the tag was never pushed, so nothing in it
ever reached a customer. Going from v0.1.6 to v0.3.0 therefore brings BOTH
entries, and everything a v0.1.6 program may need changed is collected under
**Migrating from v0.1.6** here rather than left in the older entry. Of the
three removals `v0.2.0` made, two are back as deprecated constants for the
removal window the versioning policy asks for, so exactly one thing still
fails to compile. Everything else is additive: the client went from 4
resources to 19, and no method or error type present in v0.1.6 was removed
or renamed.

### Migrating from v0.1.6

Four things a v0.1.6 program may need changed. Two fail at compile time; the
other two compile as they are, so read them rather than waiting for the
compiler to raise them.

1. **The `AccountTier` constants are the current plan names.** The single
   pricing ladder became two. `TierFree` and `TierEnterprise` are unchanged,
   and the ladder is now:

   ```go
   TierFree         // "free"
   TierSoloManual   // "solo_manual"
   TierTeamManual   // "team_manual"
   TierAgencyManual // "agency_manual"
   TierAPIStarter   // "api_starter"
   TierAPIBuilder   // "api_builder"
   TierAPIScale     // "api_scale"
   TierEnterprise   // "enterprise"
   ```

   `TierStarter`, `TierSolo`, `TierBuilder` and `TierScale` still compile.
   They are **deprecated** and will be removed in a later MINOR release, and
   they keep the wire values they had in v0.1.6 — values the server no longer
   returns, so a comparison against one is now always false. That, not the
   compile, is what to fix. `TierStarter` → `TierAPIStarter`, `TierBuilder` →
   `TierAPIBuilder` and `TierScale` → `TierAPIScale` are the closest matches;
   `TierSolo` has no single successor — decide between `TierSoloManual` and
   `TierTeamManual` by what the account actually pays for. A `switch` over
   `AccountTier` should gain a `default`: the ladder has changed once and may
   again.

2. **The two quota webhook events are no longer sent.**
   `EventQuotaWarning80Pct` (`quota.warning_80pct`) and `EventQuotaExceeded`
   (`quota.exceeded`) still compile — also **deprecated**, also to be removed
   in a later MINOR release — but nothing dispatches them and the create and
   update schemas reject them, so drop them from any `Events` slice you
   build. No event replaced them: read `Quotas` from
   `client.Usage.CurrentPeriod(ctx)` to watch headroom instead. The
   constants that remain, plus the ones added since, are
   `EventSessionCompleted`, `EventSessionFailed`,
   `EventSessionChallengeDetected`, `EventSessionProfileSaveFailed`,
   `EventSessionEgressCapabilityChanged`, `EventAPIKeyRevoked`,
   `EventCryptoOrderPaid`, `EventCryptoOrderFailed` and `EventTestPing`.

3. **`CreateWebhookRequest.Description` is a `*string`.** It was a `string`
   with `omitempty`, which cannot tell "no description" from "the empty
   string". Pass a pointer:

   ```go
   // v0.1.6
   &driftstack.CreateWebhookRequest{URL: u, Events: ev, Description: "billing"}
   // v0.3.0
   desc := "billing"
   &driftstack.CreateWebhookRequest{URL: u, Events: ev, Description: &desc}
   ```

   Leave it `nil` to send no description at all. This is the removal that
   could not become a deprecated alias: a field cannot carry both types at
   once.

4. **Seven structs that existed in v0.1.6 gained fields**, so an unkeyed
   (positional) composite literal over any of them no longer compiles — name
   the fields instead, and it stays compiling the next time one gains a
   field. They are `Session`, `SessionState`, `CreateSessionRequest`,
   `InteractAction`, `WebhookEndpoint`, `VerifyWebhookOptions` and `Client`.

   ```go
   // v0.1.6 — no longer compiles, the struct has four more fields now:
   driftstack.CreateSessionRequest{"run-42", nil}
   // Keyed, and it stays compiling the next time a field is added:
   driftstack.CreateSessionRequest{Label: "run-42"}
   ```

### Added

#### Run an AI task end to end

`client.AgentSessions` is new, and is the whole AI surface.

- **Start it, send the task, close it** — `Create(ctx, body, opts...)` opens a
  session, on a saved profile if you pass one; `Message(ctx, id, text, opts)`
  sends the task in plain words and returns what happened;
  `Get` / `List` / `Iterate` read sessions back; `Close(ctx, id)` ends one and
  saves the profile's sign-in. A new session is `provisioning` until its
  browser is ready, then `active`.
- **Every way a turn can end is a named result kind** — `plan-executed` (the
  steps ran, with `Answer` when you asked a question), `clarify` (the agent is
  asking you something), `refuse` (it will not do this), `stopped`, and a step
  held for your approval. `AnswerUnavailable` says why there is no `Answer`
  when you asked for one.
- **Live progress while it runs** — `MessageOptions.OnStep` receives each
  `AgentStepEvent` as the step finishes and `MessageOptions.OnEvent` every
  other progress event (`phase`, `plan`, `step_start`, `answer`, `notice`, and
  any added later), under the same byte ceiling and deadline as before.
- **Approve a step, or don't** — a step with real-world consequences (a
  payment, a message sent, something deleted) pauses the turn and comes back
  as a `confirmation_required` result. `ApprovalFor(result)` turns that result
  into the approval that releases it; send it on the next `Message` with the
  same task. An unattended job simply never does.
- **Stop a task that runs too long** — `Stop(ctx, id)` asks the running turn
  to stop; the waiting `Message` then returns kind `stopped` rather than an
  error.
- **Screenshots** — `GetCapture(ctx, id, captureID)` returns the image behind
  a `capture` step's `captureId` as `*AgentCapture` (`ContentType`
  `image/png` or `image/jpeg`, plus `Bytes`). Screenshots are kept only
  briefly, so fetch one as soon as its turn ends; one that is no longer kept
  is a `*NotFoundError`.
- **Transcripts** — `Transcript(ctx, id, opts, fn)` calls `fn` with every
  entry of the session's conversation, oldest first, and then with each new
  one as it is written. Return `false` from `fn` to stop, or cancel the
  context. `TranscriptOptions.LastEventID` resumes after the last `Index` you
  saw. Adds `AgentTranscriptEntry`, `AgentTranscriptEvent` and
  `TranscriptOptions`.
- **Why a turn handed back, in one word** — `AgentMessageResponse.NoticeReason`
  sits beside `Notice`: `"step_limit"`, `"time_limit"`, `"budget_low"`,
  `"no_progress"`, `"repeated_step"`, `"ai_unavailable"`, `"question"` or
  `"declined"`. The set is OPEN — a `switch` over it needs a `default` that
  shows `Notice` — and the field is empty against an older server. The
  streamed `notice` event carries the same pair.
- **When it is safe to retry a message** — a refusal that did no work leaves
  its `Idempotency-Key` free: after a 409 whose `TurnInProgress()` is true, a
  429, a 402, a 403 about the plan's AI or the model, or a 502 whose
  `KeyRejected()` is false, send the same request again with the **same**
  `MessageOptions.IdempotencyKey`. Any other failure gets a new one. One
  message is one key, always.
- **Typed refusals you can act on** — `(*ForbiddenError).RequiresOwnKey()` /
  `.Model()` (this model needs your own Anthropic key);
  `(*ConflictError).TurnInProgress()`, `.SessionStatus()`,
  `.IdempotencyStatus()`, `.AIControlUnavailable()`, `.Phase()`,
  `.TokensConsumed()`, `.Usage()`, `.PartialResults()` and `.ClosedReason()`
  (why a closed session ended, without a second call);
  `(*FeatureUnavailableError).StopUnconfirmed()` (the one `Stop` 503 worth
  calling again); and `(*ByokAnthropicRequiredError).KeyRejected()` /
  `.KeySource()` / `.KeyRejectedReason()` (your own key was refused, which
  key, and why).
- **Send your own Anthropic key** — `CreateOptions.ByokAPIKey` at create, so a
  session can run on a model that requires one without storing anything.
  `CreateAgentSessionRequest` also reaches `SkipProxyProbe` and
  `ContinueFromAgentSessionID`.
- **Typed steps** — `AgentIntent`, `AgentIntentResult`,
  `AgentFailureDiagnosis`, and `ParsedResults()` / `ParsedIntents()` to read
  them. `Results` and `Intents` stay `[]json.RawMessage`, so a shape this SDK
  has not seen still arrives intact.
- **`examples/agent_chat`** is the complete flow end to end: create, wait
  until ready, send a task with a fresh idempotency key and live progress,
  handle every result kind, close with `defer`.

#### Watch one live, or take the wheel

- **`LivekitToken(ctx, id)`** — a `*LiveKitInfo` for the live video view of a
  running session, so a person can watch it work.
- **`SetMode(ctx, id, body)`**, **`SendInputEvent(ctx, id, body)`** and
  **`Resume(ctx, id)`** drive a session a person is holding, and pick one back
  up. **`SetEgress(ctx, id, body)`** changes which of your proxies a running
  session goes out through.
- **`Takeover(ctx, id, clientID)`** and **`Handback(ctx, id)`** hand control
  of a running session between the agent and a person, and hand it back. Both
  return a `*PairModeStateEnvelope` whose `PairModeState` is a
  `map[string]any`, so you can branch on `["kind"]` without a second call. An
  invalid transition, or a session that is not in pair mode, is a typed 409.

#### The rest of the API

`client.Sessions`, `client.APIKeys`, `client.Usage` and `client.Webhooks`
were the whole client in v0.1.6, and each of the four gained methods:
`Webhooks` gained `Update` (partial update — pointer fields tell "leave as
is" from "set", and it does NOT rotate the signing secret), `RotateSecret`
(fresh secret shown once, previous one valid for 24h, both signatures sent
during the window), `SendTest` (a synthetic `test.ping` delivery so you can
check your handler before depending on it), `ReplayDelivery` and
`IterateDeliveries`; `APIKeys` gained `Rotate`.

And fourteen resources are new:

- **`client.Profiles`** — `Create`, `List`, `Iterate`, `Get`, `Update`,
  `Delete`, plus `Clone(ctx, profileID, nil)` to let the server name the copy
  `(copy)` / `(copy 2)` / … and `Trim`.
- **`client.ProfileSnapshots`** — immutable point-in-time copies of a
  profile: `Capture`, `ListForProfile`, `List`, `Iterate`, `Get`, `Restore`,
  `Delete`. `Restore` creates a NEW profile; the original is never modified.
- **`client.Account`** — `Me(ctx)` returns `*AccountSelfProfile` with the
  full account: slug, region, avatar, whether MFA is enrolled, team
  memberships. Plus `UpdateMe`, `UploadAvatar` / `ClearAvatar`,
  `ListWebSessions` / `RevokeWebSession` / `RevokeAllOtherWebSessions`, and
  `RateLimits` for the limits actually in force on your account.
- **`client.Auth`** — sign-up, e-mail verification, log in, magic links,
  password reset, refresh, log out, and the three-call activation flow a CLI
  or desktop app uses instead of asking for a pasted key:
  `CliAuthorizeInitiate` returns a `Code` and a `BrowserURL`, the person signs
  in and authorises, and `CliAuthorizeExchange` reports `pending`, then
  `bound` once (with `APIKey` + `AccountID`), then `expired`.
- **`client.Mfa`** — `Status`, `Enroll`, `Verify`, `Disable`,
  `RegenerateRecoveryCodes`; plus `Auth.MfaChallenge` to exchange a login
  challenge for a session (the response's `Via` is `"totp"` or `"recovery"`)
  and `Auth.MfaStepUp` to refresh the freshness window an operation asked
  for. Pair it with `*MfaStepUpRequiredError`: catch, step up, retry.
- **`client.Team`** — members, invites, roles, and `ListOwners(ctx)` for the
  workspaces your account has joined.
- **`client.AuditLog`** — `List` / `Iterate`, and `Export(ctx)`: a
  single-call JSON export of your account's audit log, up to 10,000 rows,
  with `Truncated` set when there were more.
- **`client.Billing`** — `GetState`, `CreateCheckoutSession`,
  `CreatePortalSession`.
- **`client.CryptoOrders`** — `Quote`, `CreateCheckout` (takes
  `*CreateCheckoutOptions{IdempotencyKey}` so a retry cannot mint a second
  order), `List`, `Iterate` (the visit callback walks every page — return
  `false` to stop early), `Get`, `UpdateNote`, `Cancel`, `Receipt`. Returned
  envelopes are forward-compatible `map[string]any` envelopes, so a field
  added server-side arrives without an SDK release. Crypto payments are not
  refundable, and cancelling only works while an order is pending.
- **`client.Egress`** and account proxies — manage saved proxies, and route a
  session's traffic through one with `ProxyID` on agent-session create. An
  unknown or not-owned proxy id is a 404.
- **`client.Archetypes`** — the device archetypes your plan can use.
- **`client.Recipes`** — `Create(ctx, CreateRecipeRequest{...})` snapshots a
  finished agent session's steps and transcript into a recipe you can replay.
  `Label` is 1–120 characters after trimming and `Description` is optional
  and omitted from the wire when empty. The returned `Recipe.AgentSessionID`
  is a `*string`, so a recipe that outlived its source session decodes
  cleanly as `nil`.
- **`client.EmailPreferences`** — `List`, `Set`, `OptIn`, `OptOut`.
- **`client.Legal`** — record acceptance of a document version.

#### Errors

- **New typed errors, each with an `errors.Is` sentinel** —
  `BadRequestError`, `InternalError`, `FeatureUnavailableError`,
  `MfaStepUpRequiredError`, `EmailAlreadyRegisteredError`,
  `InvalidCredentialsError`, `InvalidAuthTokenError`,
  `EmailNotVerifiedError`, `ByokAnthropicRequiredError`,
  `ProxyValidationFailedError`, `StorageQuotaExceededError`,
  `PairModeConflictError` and `PairModeStateInvalidTransitionError`. You can
  `errors.As(err, &InvalidCredentialsError{})` on login instead of falling
  through to the unknown case.
- **`VerifyWebhookSignature` accepts a previous-secret signature.** You
  rarely need it: during a rotation grace window both signatures arrive
  inside the one `x-driftstack-signature` header, which the verifier already
  checks.

### Changed

- **Too many AI turns is a `*RateLimitError` now.** This refusal answers as
  `rate-limited` with `RetryAfterSeconds` 5, so `Message` returns
  `*RateLimitError` (and `IsRetryable` is true) where it returned
  `*ConcurrencyLimitError`. `*ConcurrencyLimitError` still means exactly what
  it always meant on `Create`: your plan's limit on sessions running at once.
- **A generic 400 is a `*BadRequestError` now**, not a `*ValidationError`. A
  400 that carries field-level issues is still a `*ValidationError`. Callers
  matching `errors.As(err, &ValidationError{})` or
  `errors.Is(err, ErrValidation)` on a generic 400 should switch to
  `*BadRequestError` / `ErrBadRequest`. `IsRetryable` is unaffected — both
  400 types stay non-retryable.
- **`Intents` on a `plan-executed` result** covers every plan the turn made,
  not only the first.
- **The agent-session documentation describes what the API does** — result
  kinds, how an approval resumes paused steps, when a key may be reused, the
  progress event names — and no longer describes how the service is built.

### Fixed

- **`AgentMessageResponse.Answer` is readable.** It was dropped when the
  response was decoded, so a Go caller could not read the answer to the
  question their own task asked, at all.
- **The docs on `AgentSession.Model` and `CreateAgentSessionRequest.Model`
  named the wrong default.** The default is `"claude-sonnet-5"`.
- **Auth responses match what the API sends.** `LoginResponse`,
  `VerifyEmailResponse`, `MagicLinkConsumeResponse`,
  `PasswordResetConfirmResponse` and `RefreshSessionResponse` were flat
  `{AccountID, SessionToken, ExpiresAt}` structs; the API returns a nested
  `{session: …}`, so every one of them failed to decode. They are nested now,
  with a new `WebSession` struct, and `LoginResponse` carries the
  MFA-required branch (`MfaRequired`, `ChallengeToken`,
  `ChallengeExpiresAt`) to branch on.
- **Auth request fields match what the API accepts.**
  `RefreshSessionRequest` and `LogoutRequest` sent `session_token`; the API
  expects `token`. `SignupResponse` described fields the API never returned.
- **`Profile`, `CreateProfileRequest` and `UpdateProfileRequest` match the
  API.** They carried fields the API does not return and silently dropped,
  and were missing `Archetype` — so you could not pin a non-default archetype
  on create.
- **`WebhookEndpoint`** was missing the rotation fields and the delivery
  counts.
- **`Subscription`** described 5 fields where the API returns 8, and typed
  `StripeSubscriptionID` as nullable when it is always present.
- **`SessionPurpose` values the API actually accepts.** Three of the four
  constants matched no server value and would have been rejected with a 400.

## [0.2.0] - 2026-05-05

> ⚠️ **Never tagged.** `packages/sdk-go/v0.2.0` was written but the tag was
> never pushed, so this release never reached a customer; everything in it
> shipped for the first time in v0.3.0. Kept here as history — if you are
> upgrading from v0.1.6, the **Migrating from v0.1.6** section of v0.3.0 is
> the one to read, because it accounts for later changes to the same symbols.

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
  `DefaultSessionPurpose`. `CreateSessionRequest.Purpose` and
  `Session.Purpose` fields exposed.
- **`examples/billing_flow/main.go`** — server-side billing self-
  serve example.

### Changed

- **BREAKING — `AccountTier` enum** — replaced legacy values
  (`free`, `starter`, `solo`, `builder`, `scale`, `enterprise`) with
  the two-ladder restructure (`trial_pack`, `solo_manual`,
  `team_manual`, `agency_manual`, `api_starter`, `api_builder`,
  `api_scale`, `enterprise`). Old constants removed; consumers
  must update. Pre-1.0 SemVer permits the breakage.
- **`APIKeyScope` enum** — added `ScopeAccountOwner`,
  `ScopeDriftstackInternalAdmin`, `ScopeGUIControl`. The legacy
  `ScopeAdmin` token remains a compat alias.
- **`CreateSessionRequest.Archetype`** field exposed (server defaults
  to the locked archetype if empty, matching schema).

## [0.1.6] - 2026-05-03

Written on 2026-09-20 from the tagged tree: `packages/sdk-go/v0.1.6` was
tagged and published without a CHANGELOG heading of its own.

### Added

- **`LegalAcceptanceRequiredError`** — a 409 that asks you to accept a
  document version is its own error type now, carrying the pending
  acceptances (`PendingAcceptance.DocumentKey` +
  `.CurrentVersion`) as `PendingAcceptances`. Sentinel
  `ErrLegalAcceptanceRequired` for `errors.Is`.

## [0.1.5] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error struct mapping the
  `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `TimeoutMs int` from the problem
  extension. Sentinel: `ErrSessionTimeout` for `errors.Is`
  matching.

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
  from the public surface. Same reason as `tap_at`: a coordinate
  primitive on the customer-facing schema lets the customer bypass
  the behavioral simulation layer for the offset portion of the
  interaction. Bounded coordinates are still coordinates.

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
on the gui-control surface and is not exposed in this SDK.

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
  `NewTypeFocusedAction`). Customer-facing schemas stay
  intent-only.
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
  removed in 0.1.2, to keep customer-facing schemas intent-only).
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

### Notes

- `0.1.0` is the inaugural alpha release, tagged as
  `packages/sdk-go/v0.1.0` (Go modules sub-directory tagging
  convention). This note sat under `[Unreleased]` until 2026-09-20;
  it describes 0.1.0 and belongs here.

### Notes

- Types in `types.go` are hand-maintained, not codegen output —
  `oapi-codegen` doesn't yet support OpenAPI 3.1 nullable shorthand
  (`type: [string, null]`). Hand-writing is tractable at the current
  schema size and produces cleaner output.
- Same hand-written-over-codegen call as the TypeScript SDK.
