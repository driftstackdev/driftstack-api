# Changelog

All notable changes to the Driftstack TypeScript SDK. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Retry policy** (`shouldRetry`) no longer auto-retries the terminal
  5xx errors `DriverError` (502), `DriverNotIntegratedError` (503), and
  `SessionTimeoutError` (504). It now delegates to the public
  `isRetryable()` predicate (retry ONLY `transport` / `internal` /
  `rate_limited` kinds), so the built-in retry loop and `isRetryable()`
  can no longer drift apart — and it matches the Go (`IsRetryable`) +
  Python (`is_retryable`) SDKs. Previously these terminal failures were
  retried on idempotent calls because of a blanket `status >= 500` check.

### Changed

- **Minor behaviour change:** the `kind` discriminator on
  `BundledLlmBudgetExhaustedError` + `BundledLlmConsentRequiredError`
  (HTTP 402) is now `'payment_required'` (a new `DriftstackErrorKind`
  union member) and on `PairModeConflictError` +
  `PairModeStateInvalidTransitionError` (HTTP 409) is now `'conflict'` —
  previously all four were mislabelled `'bad_request'`. The error classes,
  HTTP statuses, typed extension fields, and `isRetryable()` results
  (still `false` for all four) are unchanged.

### Added

- **`client.team.listOwners()`** — typed access to `GET /v1/team/owners`
  for owner workspaces the calling account has joined. Returns
  `TeamOwnersList` / `TeamOwner` and requires broad `read` (or
  `account_owner`).
- `proxy_id` on agent-session create (`CreateAgentSessionRequest`) — route
  the session's egress through one of your account proxies (manage them at
  `/v1/account/me/proxies`). Must reference a proxy your account owns
  (unknown / not-owned → 404). Optional; omit for the default egress.
- `session.profile_save_failed` webhook event — a profile-backed
  session's save-back failed at teardown (terminal; the next restore of
  that profile will be stale). Subscribable; payload:
  `{ session_id, profile_id, reason, detail? }` with `reason` one of
  `serialize_failed | seal_failed | too_large | upload_failed`.

### Added

- **`Session.egress_capability_report`** (Arc 5 EGRESS eg.1.c) —
  raw harness-emitted event payload as `Record<string, unknown> | null`,
  stored alongside the derived `egress_capabilities` view. Forensics
  - schema-evolution safety net: surfaces fields the SDK schema
    doesn't formally know (e.g. harness-side diagnostic counters)
    without requiring an SDK release. Consumers should prefer
    `egress_capabilities` for typed access; this is opaque JSON for
    inspection / observability piping.
- **`client.agentSessions.takeover(id, clientId)`** + **`.handback(id)`**
  (v2-#8 Arc 2 sub-slice 8.9) — pair-mode state-machine wrappers.
  Takeover requests a human to take control of a `mode: 'pair'`
  agent session (state machine transitions `ai-driving →
takeover-pending`, or `takeover-queued` when the runtime is
  mid-decompose); handback returns control to AI from
  `human-driving`. Both return `{ pair_mode_state: { kind, ... } }`
  so callers can branch on whether the request was queued without a
  separate GET round-trip. 409 `PairModeStateInvalidTransitionError`
  on invalid transitions (e.g. takeover from `takeover-pending`);
  409 `ConflictError` when the session is not `mode: 'pair'`.
- **`client.recipes.create(body)`** (AI-B4 / Q.5.d) — snapshot a
  finished agent-session's intent_log + transcript into a replayable
  recipe row. Body: `{ agent_session_id, label, description? }`
  with `label` 1..120 chars and `description` ≤2000 chars after trim.
  Server assembles `intent_log` by flatMapping the source
  agent-session's transcript — each plan-executed turn's structured
  intent array is concatenated in turn order. Returns the inserted
  `Recipe` including `intent_count`. Read / list / execute / delete
  are v1.1 D2/D3 surfaces. Re-exported types: `Recipe`,
  `CreateRecipeRequest`. 503 until the deployment wires both
  `recipesRepo` and `agentSessionsRepo`.
- **`client.webhooks.sendTest(id)`** (V-463 / V-356) — send a
  synthetic `test.ping` delivery to a webhook endpoint, bypassing
  subscription. Lets customers verify their handler is reachable +
  signature-valid before depending on it for real events. Returns
  `{ delivery_id, event_id, event_type: 'test.ping' }`.
- **`client.webhooks.update(id, body)`** (V-464 / V-351) — partial-
  update a webhook endpoint (`url` / `events` / `description` /
  `active`; at least one required). Signing secret is NOT rotated by
  update — use `rotateSecret` for that. Disabled endpoints cannot be
  updated (409). Re-exported type: `UpdateWebhookRequest`.
- **`client.auditLog.export()`** (V-462 / V-297) — single-call JSON
  bulk-export of the calling account's audit log; designed for GDPR
  Article 20 data-portability requests. Up to 10,000 rows per call;
  the response includes `truncated: boolean` for the ceiling case.
  CSV download (browser-driven spreadsheet flow) is intentionally
  not surfaced through the SDK — hit
  `/v1/account/audit-log/export?format=csv` directly with the bearer.
  New type re-exported: `AuditLogExportResponse`.
- **CLI/GUI activation flow** (V-460 / V-266) — three new methods on
  `client.auth`: `cliAuthorizeInitiate`, `cliAuthorizeBind`, and
  `cliAuthorizeExchange`. CLI/GUI tools no longer need to ask users to
  paste an API key from the dashboard; instead they call
  `cliAuthorizeInitiate` for a `code` + `browser_url`, open the URL,
  the user signs in to the dashboard and clicks Authorize, and the
  CLI/GUI polls `cliAuthorizeExchange` for one-shot delivery of the
  plaintext API key. Re-exported types: `CliAuthorizeInitiateRequest /
Response`, `CliAuthorizeBindRequest / Response`,
  `CliAuthorizeExchangeRequest / Response`,
  `CliAuthorizeExchangeStatus`.
- **`client.profileSnapshots`** — V-312 immutable point-in-time
  profile copies. Methods: `capture(profileId, body)`,
  `listForProfile(profileId, query?)`, `list(query?)` (cross-account),
  `iterate(opts?)`, `get(id)`, `restore(id, body)`, `delete(id)`.
  `restore` creates a NEW profile (the parent is never modified) and
  is checked against the same tier-cap and name-conflict rules as
  `client.profiles.create`. New types re-exported:
  `ProfileSnapshot`, `CaptureSnapshotRequest`, `RestoreSnapshotRequest`,
  `ProfileSnapshotsListPage`.
- **`client.profiles.clone(id, body?)`** — V-313 profile clone.
  Empty body lets the server auto-derive a `(copy)` / `(copy 2)` /
  ... name; explicit `{ name }` is forwarded verbatim. Tier-cap +
  name-conflict apply identically to `create`. New type re-exported:
  `CloneProfileRequest`.
- **`client.webhooks.rotateSecret(id)`** — V-359 webhook signing-
  secret rotation. Returns the fresh plaintext (shown ONCE) plus
  grace metadata. The previous secret stays active for 24h
  (`grace_expires_at`); during that window Driftstack dual-signs
  every outbound delivery with both new + old secrets. New type
  re-exported: `RotateWebhookSecretResponse`.

### Fixed (V-423 / V-428)

- **`client.auth.login()`** now returns `Promise<LoginResponseUnion>`
  (previously typed as `Promise<LoginResponse>`, which silently
  type-mismatched on the V-353d MFA-required branch). Branch on the
  `'mfa_required' in out` discriminator for type-narrowed access.
  New types re-exported: `LoginResponseUnion`, `LoginMfaRequiredResponse`.
- **`AccountSelfProfile`** now matches the full server `/me` response
  (was 9 fields; server returns 15). Added: `timezone` (V-352),
  `slug` (V-298a), `region` (V-298b), `avatar_url` (V-352b),
  `mfa_enrolled` (V-353h), `teams` (V-326c).

### Added (V-441 / V-445)

- **`FeatureUnavailableError`** + **`MfaStepUpRequiredError`** typed
  errors mapping `feature-unavailable` / `mfa-step-up-required`
  problem URIs (V-441). Customers can `instanceof MfaStepUpRequiredError`
  on the catch path.
- **`client.auth.mfaChallenge(body)`** + **`mfaStepUp(body)`** —
  V-353d/e MFA exchange. `mfaChallenge` exchanges the login
  challenge_token for a session via TOTP or recovery code;
  `mfaStepUp` refreshes `mfa_satisfied_at` for the V-353e step-up
  gate. Pair `mfaStepUp` with the `MfaStepUpRequiredError` recovery
  path: catch → `mfaStepUp` → retry. New types re-exported:
  `MfaChallengeRequest / Response`, `MfaStepUpRequest / Response`.

### Added (V-448 / V-449 / V-450) — Account-surface parity

- **`client.mfa`** — V-353b MFA enrollment management
  (`status / enroll / verify / disable / regenerateRecoveryCodes`).
- **`client.auditLog`** — V-216 audit-log read (`list / iterate`).
- **`client.emailPreferences`** — V-204 opt-in/opt-out toggles
  (`list / set / optIn / optOut`).
- **`client.account.updateMe(body)`** — V-352 PATCH /me.
- **`client.account.uploadAvatar(body)`** + **`clearAvatar()`** —
  V-352b avatar upload + clear.
- **`client.account.listWebSessions()`** +
  **`revokeWebSession(id)`** + **`revokeAllOtherWebSessions()`** —
  V-355 active-sign-ins management.
- **`client.account.rateLimits()`** — V-258 effective rate-limit
  config read.

Three-SDK Account-surface parity complete: every `/v1/account/*`
endpoint registered server-side is now exposed in all three SDKs.

### Pre-1.0 stability policy

The SDK is at **0.1.x**; the public surface is stable enough to
build against (every release is checked through the marshalling
round-trip tests in `tests/unit/wire-shape.test.ts`) but minor
versions may introduce additive changes — new methods, new fields,
new error subclasses. **Patch versions** (0.1.x → 0.1.y) are
strictly fixes and additive types. **Minor versions** (0.1 → 0.2)
may include schema renames if the iPhone-archetype reference rig
discovers a wire-shape divergence. **Breaking changes** that affect
shipping customer code are deferred until 1.0; pre-1.0 customers
should pin against `^0.1.0` rather than an exact version.

## [0.1.5] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error subclass mapping
  the `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `timeoutMs: number | undefined` from
  the problem extension. See V-044 [control].

  ```ts
  try {
    await client.sessions.interact(sid, { action: t, timeout_ms: 5000 });
  } catch (err) {
    if (err instanceof SessionTimeoutError) {
      // Retry with a longer timeout, or surface to the user.
      console.log(`Op timed out after ${err.timeoutMs} ms`);
    }
  }
  ```

- HTTP-layer regression tests for `RevokedKeyError`,
  `ExpiredKeyError`, and `SessionTimeoutError` mappings.

## [0.1.4] - 2026-05-03

### Removed

- `InteractAction.tap.offset` removed from the public surface. Same
  L-001 vector as `tap_at`: a coordinate primitive on the
  customer-facing schema lets a customer bypass the behavioral
  simulation layer for the offset portion of the interaction. Bounded
  coordinates are still coordinates. See `docs/locked-decisions.md`
  L-001 in the control-plane repo and V-042 [control].

### Migration

If existing code passes `offset: { x, y }` to `tap`, the value is now
silently stripped (Zod's default unknown-key behavior on object
schemas). Re-express the intent through selector specificity:
better selectors, child-element targeting, ARIA-role qualifiers, or
text-content matching. Examples:

```ts
// Before (0.1.x):
client.sessions.interact(id, {
  action: { kind: 'tap', selector: 'button.cta', offset: { x: 0, y: 50 } },
});

// After (0.1.4+):
// Identify the actual sub-element you wanted to hit:
client.sessions.interact(id, {
  action: { kind: 'tap', selector: 'button.cta .icon-arrow' },
});
```

If your app genuinely needs coordinate-level addressing (because
you're driving the session from a screenshot, not from DOM
selectors), that lives on the gui-control plane — a separate
endpoint gated behind the `gui_control` API-key scope and not
exposed in this SDK.

## [0.1.3] - 2026-05-03

### Added

- Wire-shape regression tests at `tests/unit/wire-shape.test.ts`
  (13 tests). Locks the canonical JSON shape for `InteractAction`
  (5 variants), `WaitCondition` (4 variants), and `NavigateRequest`.
  Asserts L-001 rejection of `tap_at` / `type_focused` on the
  customer-facing surface (these live on the gui-control plane,
  not exposed in this SDK). See V-037 in the control-plane repo.

### Changed

- Re-cut: `tap_at` and `type_focused` removed from
  `InteractActionSchema`. They were briefly added in 0.1.2 (V-032
  in the control-plane repo) for the self-hosted GUI's
  manual-control input forwarding. Per L-001 in
  `docs/locked-decisions.md`, customer-facing schemas stay
  intent-only — coordinate primitives bypass the behavioral
  simulation layer and erode the moat. The GUI now uses a
  separate, scope-gated endpoint (`/v1/sessions/:id/gui-input`,
  `gui_control` API-key scope) that customer SDKs do not expose.

## [0.1.2] - 2026-05-02

### Added

- `tap_at` and `type_focused` variants on `InteractActionSchema`
  (subsequently reverted in 0.1.3 — see above).

### Notes

- Brief release; superseded by 0.1.3 within hours.

## [0.1.1] - 2026-05-02

### Changed

- `verifyWebhookSignature` is now `async` (returns `Promise<boolean>`)
  because the underlying HMAC implementation switched from Node's
  `crypto` module to the Web Crypto API for browser-isomorphism.
  Sub-millisecond runtime cost; doesn't affect throughput. Callers
  must `await` the result.
- Body input type widened: accepts `string | Uint8Array | ArrayBuffer`
  instead of `Buffer` (which was Node-specific).

### Why

- The previous `verifyWebhookSignature` used `node:crypto` which
  Vite/rollup couldn't bundle for browser environments — the
  Tauri-based GUI client (control-plane repo) had a hand-written
  fetch wrapper as a workaround. Rewriting to Web Crypto API
  closes that gap; the SDK is now usable in Node 20+, every modern
  browser, Tauri WebViews, Cloudflare Workers, Deno, and Bun.

## [0.1.0] - 2026-05-02

### Added

- Inaugural release. `Driftstack` client + four resource accessors
  (`sessions`, `apiKeys`, `usage`, `webhooks`).
- Discriminated-union types for `InteractAction` (`tap`, `type`,
  `scroll`, `press`) and `WaitCondition` (`selector`,
  `selector_hidden`, `url_matches`, `time`).
- Error hierarchy: `DriftstackError` base with `kind` discriminator;
  subclasses `BadRequestError`, `ValidationError`, `AuthError`,
  `InvalidKeyError`, `RevokedKeyError`, `RateLimitError`,
  `NotFoundError`, `TransportError`, etc.
- Built-in retry on transient transport + rate-limit errors;
  honours server `Retry-After`.
- `verifyWebhookSignature` helper (Stripe-style HMAC-SHA256
  signature verification).
- Public packages on npm under `@driftstack/sdk` (this) +
  `@driftstack/api-types` (shared Zod schemas, re-exports types).
