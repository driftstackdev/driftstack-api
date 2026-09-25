# Changelog

All notable changes to the Driftstack TypeScript SDK. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`warning` on a successful step result** (`AgentIntentResult` of kind
  `'success'`), typed `AgentStepWarning`. Absent means there is nothing to
  report. Its one kind today is `'http_error_status'`: a navigation reached
  the site and the site answered with an HTTP status of 400 or above, carried
  in `status`. The step still succeeded — the page that loaded may be an error
  page, a page asking to sign in or to complete a verification step, or the
  whole page served under that status — and its `summary` says what the site
  answered. The kind is an open set: treat one you do not recognise as a note
  and read `summary`.
- **Desktop browser sign-in: code verifier (PKCE).**
  `auth.cliAuthorizeInitiate` accepts `code_challenge` (unpadded base64url
  SHA-256 of a `code_verifier` you keep) with `code_challenge_method: 'S256'`,
  and `auth.cliAuthorizeExchange` accepts `code_verifier`. A flow started with
  a challenge cannot be collected without the verifier, so the `code` and
  `state` in `browser_url` are no longer enough on their own.
- **`AgentSession.capability_report.egress_state` can read
  `'default_connection_down'`.** A session started without
  a proxy of its own runs on the connection Driftstack provides; this value
  means that connection stopped carrying traffic while the session ran. It is
  on our side: there is nothing to fix at yours, and a session started with
  one of your own proxies runs now. `'dead_proxy'` keeps its meaning — your
  own proxy stopped. On `GET /v1/sessions/{id}` the same fact arrives as the
  `default_connection_down` code in `egress_capabilities.warnings`, and for
  that session a connection without UDP reads `quic_unavailable` and a failed
  check that its traffic left the right way reads `safeguard_failed` — never
  `udp_unsupported_by_proxy` or `safeguard_failed:proxy_egress_verification`,
  which name a proxy it does not have.
- **Error code `'default_egress_unavailable'`** in an agent session's
  `error_event.code`, and as its `closed_reason`: a session with no proxy of
  its own could not connect through Driftstack's connection. It arrives with
  `customer_actionable: false` — ours to fix — and a session started with one
  of your own proxies runs now. `code` stays a `string`, so nothing to change
  unless you branch on it.

### Deprecated

- Calling `auth.cliAuthorizeInitiate` without `code_challenge`. It works as
  before until **31 January 2027**; responses carry `Deprecation` and
  `Sunset` headers, and from that date the server answers `400`.

## [0.3.0] - 2026-09-22

**Nothing was removed.** Every export, method, field and error class 0.2.0
published still means the same thing, so upgrading takes no code change on
its own — except where **Migration** below says a string comparison needs
updating.

### Added

- **`EgressCapabilities.safeguards`** — `'passed'`, `'failed'` or
  `'unverified'`, summarising whether every egress safeguard held for a
  session. `'failed'` wins whenever any check did not pass; `'passed'` only
  when the device declared the full set of checks a healthy session reports
  and every one of them reported back; `'unverified'` otherwise. The field is
  **absent**, not `null`, on a session reported before it existed — do not
  read an absent value as `'unverified'` or `'passed'`. Rides everywhere
  `egressCapabilities` already does: `get` / `list` / `create` on
  `client.sessions`, `launch` on `client.profiles`, and the
  `session.egress_capability_changed` webhook payload.
- **`measured_by`** on a `?check=full` proxy test result
  (`client.egress.testProxy(id)`) — `'phone'` when a real phone session took
  the measurement, `'driftstack'` when Driftstack itself did because no phone
  could be reached in time. The field this replaces, `measured_from`, is
  still sent beside it with its original values for existing integrations,
  but is no longer documented; read `measured_by` from here on.
- **`direct_reading` and `website_like_reading`** on `os_fingerprint` — the
  same two facts `single_host_vantage` and `web_port_vantage` already carry,
  under plainer names, added beside the originals rather than replacing
  them. Present on the proxy test result **and** on each saved
  proxy returned by `client.egress.listProxies()` / `updateProxy(id, body)`.
- **`'page_unreadable'`** joins the `notice_reason` union a `plan-executed`
  result can carry: the page could not be read to plan the next step, so the
  task stopped rather than guess. Send `continue` to try again.
- **`ConcurrencyLimitError.aiTasksInFlight`** — `true` when a 429 is the
  concurrent-AI-tasks limit (at most 3 running at once) rather than the
  session-concurrency limit; `currentSessions` / `limit` keep meaning what
  they always meant. Python and Go read the same fact off the raw problem
  extension fields every `DriftstackError` already keeps — this is a typed
  accessor, not a new fact on the wire.

### Changed

- **Two dead `egress_capabilities.warnings` codes are retired from the
  documentation**: `quic_disabled_fallback_http2` and
  `dns_remote_resolve_unsupported_by_proxy`. Neither has ever been sent, so
  this is a documentation correction, not a behavioural change.

### Migration

Two closed-string fields were narrowed — values removed, not added — inside
`AccountProxyTestResult`, the return type of
`client.egress.testProxy(id)`. Nothing in this SDK parses or validates this
result (it is typed only), so neither change raises at compile time or at
runtime: an `if`/`switch` matching on an old string simply stops matching,
silently. The server has sent the new values only since 2026-09-21.

- **`not_run`** — `'node_busy'`, `'node_error'` and `'no_node'` merged into
  `'check_unavailable'` (you can do exactly one thing about any of the
  three: try again shortly, or contact support if it persists);
  `'unresolvable'` is now `'config_unresolvable'`, matching the word the
  "why a launch is refused" vocabulary already used for the identical fact.
  `'live_session'` is unchanged.
- **`os_fingerprint_unavailable`** — `'vpn_tunnel'` is now
  `'not_available_for_vpn'`, `'not_observed'` is now `'not_captured'`, and
  `'observer_off'` is now `'not_offered_here'`.

Update any code that compares `not_run` or `os_fingerprint_unavailable`
against one of the old strings to compare against its replacement instead.

### Pre-1.0 stability

The SDK is pre-1.0. Pin `^0.3.0` rather than an exact version and read this
file before bumping.

## [0.2.0] - 2026-09-20

The release the guide [Run AI tasks from your
code](https://docs.driftstack.io/guides/run-ai-tasks-from-code/) is written
against — 0.1.6 cannot run any of its examples, because the AI agent was not
reachable from it at all.

**Nothing was removed.** Every export, method, field and error class that
0.1.6 published is still here and still means the same thing, so upgrading
takes no code change. What grew: the client went from 4 resources to 19, the
package from 20 exported values to 52, and the type surface from 72 exported
names to 248. Read **Changed** before you upgrade anyway — a few behaviours
differ, and one of them changes which error class a `catch` block sees.

### Added

#### Run an AI task end to end

`client.agentSessions` is new, and is the whole AI surface.

- **Start it, send the task, close it** — `create(body, opts?)` opens a
  session, on a saved profile if you pass one; `message(id, task, opts?)`
  sends the task in plain words and resolves with what happened;
  `get(id)` / `list(query?)` / `iterate(opts?)` read sessions back;
  `close(id)` ends one and saves the profile's sign-in. A new session is
  `provisioning` until its browser is ready, then `active`.
- **Every way a turn can end is a typed result kind** — `plan-executed` (the
  steps ran, with `answer` when you asked a question), `clarify` (the agent
  is asking you something), `refuse` (it will not do this), `stopped`, and a
  step held for your approval. `answer_unavailable` says why there is no
  `answer` when you asked for one.
- **Live progress while it runs** — `onStep` is called as each step finishes
  and `onEvent` with every other progress event (`phase`, `plan`,
  `step_start`, `answer`, `notice`, and any added later), so a long task
  prints as it goes instead of arriving all at once.
- **Approve a step, or don't** — a step with real-world consequences
  (a payment, a message sent, something deleted) pauses the turn and comes
  back as `confirmation_required`. Send the same task again with
  `approveConsequentialActions` to release it. An unattended job simply never
  does, and the exported `ConsequentialActionCategory` admits categories newer
  than this SDK, so a new one can be passed straight back.
- **Stop a task that runs too long** — `stop(id)` asks the running turn to
  stop; the waiting `message()` then resolves with kind `stopped` rather than
  throwing.
- **Screenshots** — `getCapture(id, captureId)` returns the image behind a
  `capture` step's `captureId` as `{ contentType, bytes }` (`image/png` or
  `image/jpeg`). Screenshots are kept only briefly, so fetch one as soon as
  its turn ends; one that is no longer kept is a `NotFoundError`.
- **Transcripts** — `transcript(id, opts?)` is an async generator over the
  session's conversation: every entry so far, then each new one as it is
  written. `lastEventId` resumes after the last `index` you saw; leaving the
  loop, or aborting `signal`, closes the connection.
- **Why a turn handed back, in one word** — a `plan-executed` result carries
  `notice_reason` beside the `notice` sentence: `'step_limit'`,
  `'time_limit'`, `'budget_low'`, `'no_progress'`, `'repeated_step'`,
  `'ai_unavailable'`, `'question'` or `'declined'`. It is an open union
  (`AgentNoticeReason`), so an ending this SDK has never heard of still
  type-checks and still parses — branch on the ones you know and show
  `notice` for the rest.
- **When it is safe to retry a message** — a refusal that did no work leaves
  its `Idempotency-Key` free: after a 409 whose `turnInProgress` is set, a
  429, a 402, a 403 about the plan's AI or the model, or a 502 whose
  `keyRejected` is false, send the same request again with the **same** key.
  Any other failure gets a new one. One message is one key, always.
- **Typed refusals you can act on** — `ForbiddenError.requiresOwnKey` /
  `.model` (this model needs your own Anthropic key);
  `ConflictError.turnInProgress`, `.sessionStatus`, `.idempotencyStatus`,
  `.aiControlUnavailable`, `.phase`, `.tokensConsumed`, `.usage`,
  `.partialResults` and `.closedReason` (why a closed session ended, without
  a second call); `FeatureUnavailableError.stopUnconfirmed` (the one `stop()`
  503 worth calling again); and `ByokAnthropicRequiredError.keyRejected` /
  `.keySource` / `.keyRejectedReason` (your own key was refused, which key,
  and why).
- **Send your own Anthropic key** — `create(body, { byokApiKey })` at create,
  or per message, so a session can run on a model that requires one without
  storing anything.
- **Why a step failed** — `AgentFailureDiagnosis.category` explains a failed
  step, including `'target_unverified'` (the tap was not made because its
  target could not be checked first — not retryable as the same step; the
  agent re-plans).
- **`examples/agent-chat.ts`** is the complete flow end to end: create, wait
  until ready, send a task with a fresh idempotency key and live progress,
  handle every result kind, close in `finally`.

#### Watch one live, or take the wheel

- **`client.agentSessions.livekitToken(id)`** — a token for the live video
  view of a running session, so a person can watch it work.
- **`setMode(id, body)`**, **`takeover(id, clientId)`** and
  **`handback(id)`** — hand control of a running session between the agent
  and a person, and hand it back. **`sendInputEvent(id, body)`** drives it
  while a person holds it, and **`resume(id)`** picks a session back up.
- **`setEgress(id, body)`** changes which of your proxies a running session
  goes out through.

#### The rest of the API

`client.sessions`, `client.apiKeys`, `client.usage` and `client.webhooks`
were the whole client in 0.1.6, and each of the four gained methods:

- **`client.sessions`** — `get(id)`, `iterate(opts?)`, `extract(id, body)`
  (pull structured data off the page), `search(id, query)` and
  `login(id, body)`, beside the `create` / `navigate` / `interact` / `wait` /
  `getState` / `capture` / `destroy` it already had.
- **`client.usage`** — `currentPeriod()` and `series(query?)` for usage over
  time, beside `current()`.
- **`client.apiKeys.rotate(id, opts?)`** — issue the replacement and keep the
  old key working for a grace window.
- **`client.webhooks`** — `update(id, body)` (partial update; it does not
  rotate the signing secret), `rotateSecret(id)` (fresh secret shown once,
  previous one still valid for 24h, both signatures sent during the window),
  `sendTest(id)` (a synthetic `test.ping` delivery so you can check your
  handler before depending on it), `replayDelivery(id)` and
  `iterateDeliveries(id, query?)`.

And fourteen resources are new:

- **`client.profiles`** — create, list, iterate, get, update, delete, plus
  `clone(id, body?)` (empty body lets the server name it `(copy)`,
  `(copy 2)`, …) and `trim(id, body)`.
- **`client.profileSnapshots`** — immutable point-in-time copies of a
  profile: `capture`, `listForProfile`, `list`, `iterate`, `get`, `restore`,
  `delete`. `restore` creates a NEW profile; the original is never modified.
- **`client.account`** — `me()` (the full account profile: timezone, slug,
  region, avatar, whether MFA is enrolled, team memberships), `updateMe()`,
  `uploadAvatar()` / `clearAvatar()`, `listWebSessions()` /
  `revokeWebSession(id)` / `revokeAllOtherWebSessions()`, and `rateLimits()`
  for the limits actually in force on your account.
- **`client.auth`** — sign-up, e-mail verification, log in, magic links,
  password reset, refresh, log out, and the three-call activation flow a CLI
  or desktop app uses instead of asking for a pasted key
  (`cliAuthorizeInitiate` → open the returned `browser_url` → poll
  `cliAuthorizeExchange`, which delivers the key once).
- **`client.mfa`** — `status`, `enroll`, `verify`, `disable`,
  `regenerateRecoveryCodes`; plus `auth.mfaChallenge()` to exchange a login
  challenge for a session and `auth.mfaStepUp()` to refresh the freshness
  window an operation asked for.
- **`client.team`** — members, invites, roles, and `listOwners()` for the
  workspaces your account has joined.
- **`client.auditLog`** — `list` / `iterate`, and `export()`: a single-call
  JSON export of your account's audit log, up to 10,000 rows, with
  `truncated` set when there were more.
- **`client.billing`** — current state, checkout, and the billing portal.
- **`client.cryptoOrders`** — `quote`, `createCheckout` (takes an
  idempotency key so a retry cannot mint a second order), `list`, `iterate`,
  `get`, `updateNote`, `cancel`, `receipt`. Crypto payments are not
  refundable, and cancelling only works while an order is pending.
- **`client.egress`** and account proxies — manage saved proxies and route a
  session's traffic through one with `proxy_id` on create.
- **`client.archetypes`** — the device archetypes your plan can use.
- **`client.recipes`** — `create(body)` snapshots a finished agent session's
  steps and transcript into a recipe you can replay.
- **`client.emailPreferences`** — `list` / `set` / `optIn` / `optOut`.
- **`client.legal`** — record acceptance of a document version.

#### One client, one workspace

- **`effectiveAccount`** on the client is the account id of a team workspace
  you have joined. It is sent with every request, so reads resolve against
  that workspace; writes there need the admin role. Omit it for your own
  account.

#### Errors, retries and paging

- **`isRetryable(err)`** and **`iteratePaginated(...)`** are exported. So are
  `SessionTimeoutError` and `LegalAcceptanceRequiredError`: the SDK already
  threw both, but 0.1.6 never exported the classes, so there was no way to
  name them in an `instanceof`.
- **New error classes** — `BadRequestError`, `InternalError`,
  `FeatureUnavailableError`, `MfaStepUpRequiredError`,
  `EmailAlreadyRegisteredError`, `InvalidCredentialsError`,
  `InvalidAuthTokenError`, `EmailNotVerifiedError`,
  `ByokAnthropicRequiredError`, `ProxyValidationFailedError`,
  `StorageQuotaExceededError`, `ProfileInUseError`,
  `BundledLlmConsentRequiredError`, `BundledLlmBudgetExhaustedError`,
  `PairModeConflictError`, `PairModeStateInvalidTransitionError`.
- **`verifyWebhookSignature` accepts `headerPrev`** — an optional second
  signature header. You rarely need it: during a rotation grace window both
  signatures arrive inside the one `x-driftstack-signature` header, which the
  verifier already checks.

### Changed

- **Too many AI turns is a `RateLimitError` now.** This refusal answers as
  `rate-limited` with `retryAfterSeconds` 5, so `message()` throws
  `RateLimitError` where it threw `ConcurrencyLimitError`.
  `ConcurrencyLimitError` still means exactly what it always meant on
  `create()`: your plan's limit on sessions running at once.
- **A generic 400 is a `BadRequestError` now**, not a `ValidationError`. A
  400 that carries field-level issues is still a `ValidationError`. Callers
  matching `instanceof ValidationError` on a generic 400 should match
  `BadRequestError`; `instanceof DriftstackError` catch-alls are unaffected,
  and so is `isRetryable()` (both stay non-retryable).
- **`DriftstackErrorKind` gained members** — `'payment_required'`,
  `'email_already_registered'`, `'invalid_credentials'`,
  `'invalid_auth_token'`, `'email_not_verified'`, `'feature_unavailable'`,
  `'mfa_step_up_required'`, `'byok_anthropic_required'` and
  `'proxy_validation_failed'`. Nothing was taken out of the union. ⚠️ A
  `switch` over `kind` that relied on the old union being closed for
  exhaustiveness (`const _: never = kind`) now needs a `default` branch. The
  `kind` on four classes was corrected at the same time: the two 402 classes
  now report `'payment_required'` and the two pair-mode 409 classes report
  `'conflict'`, where all four were mislabelled `'bad_request'`.
- **`AgentFailureDiagnosis.category` and `ConsequentialActionCategory` are
  open unions** — the known values plus `(string & {})`. Editors still
  suggest the known ones, and a value the server adds later type-checks
  instead of needing a cast. Same `switch`/`default` caveat as above. Treat a
  category you do not recognise as `'unknown'`.
- **Default retry backoff** — the first retry now waits 200 ms rather than
  250 ms, and the backoff is capped at 10 s rather than 8 s. Both are still
  `retry` options on the client; nothing else about the retry contract moved.
- **The agent-session documentation describes what the API does** — result
  kinds, how an approval resumes paused steps, when a key may be reused, the
  progress event names — and no longer describes how the service is built.
- **The package now carries the API contract types itself.**
  `@driftstack/api-types` is no longer installed alongside the SDK — the types
  and schemas it provided ship inside this package — and `zod` is the single
  dependency that comes with it, so `import` and `require()` both load with
  nothing else to resolve.

### Fixed

- **Retries stop at terminal failures.** `DriverError` (502),
  `DriverNotIntegratedError` (503) and `SessionTimeoutError` (504) were
  retried on idempotent calls because of a blanket `status >= 500` check.
  The retry loop now asks the same `isRetryable()` predicate you can call —
  transport, internal and rate-limit errors only — so the two can no longer
  disagree.
- **`client.auth.login()` is typed as the union it returns**
  (`LoginResponseUnion`). It was typed as the non-MFA branch, which silently
  mismatched when MFA was required. Branch on `'mfa_required' in out`.
- **`AccountSelfProfile` matches the full account response** — it described 9
  fields where the API returns 15.

### Pre-1.0 stability

The SDK is pre-1.0. Every release is checked through the marshalling
round-trip tests in `tests/unit/wire-shape.test.ts`, and the surface is
stable enough to build against, but a MINOR bump may still carry additive
changes — new methods, new fields, new error subclasses. **Patch** releases
(0.2.x) are fixes and additive types only. Breaking changes that would make
shipping customer code stop compiling are deferred to 1.0; until then, pin
`^0.2.0` rather than an exact version and read this file before bumping.

## [0.1.6] - 2026-05-03

Written on 2026-09-20 from the published tarball: 0.1.6 went to npm without a
CHANGELOG heading of its own. Its exported surface is identical to 0.1.5's,
so an upgrade from 0.1.5 to 0.1.6 needed no code change.

### Added

- **A 409 that asks you to accept a document is its own error.** The SDK
  gained a `legal_acceptance_required` error carrying the list of pending
  acceptances (`document_key` + `current_version` for each). The class itself
  was not exported in 0.1.6, so the only way to recognise it was
  `err.kind === 'legal_acceptance_required'`; 0.2.0 exports it.

## [0.1.5] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error subclass mapping
  the `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `timeoutMs: number | undefined` from
  the problem extension.

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
  reason as `tap_at`: a coordinate primitive on the
  customer-facing schema lets a customer bypass the behavioral
  simulation layer for the offset portion of the interaction. Bounded
  coordinates are still coordinates.

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
selectors), that lives on a separate endpoint gated behind the
`gui_control` API-key scope and not exposed in this SDK.

## [0.1.3] - 2026-05-03

### Added

- Wire-shape regression tests at `tests/unit/wire-shape.test.ts`
  (13 tests). Locks the canonical JSON shape for `InteractAction`
  (5 variants), `WaitCondition` (4 variants), and `NavigateRequest`.
  Asserts rejection of `tap_at` / `type_focused` on the
  customer-facing surface (these live behind the `gui_control`
  scope, not exposed in this SDK).

### Changed

- Re-cut: `tap_at` and `type_focused` removed from
  `InteractActionSchema`. They were briefly added in 0.1.2 for the
  self-hosted GUI's manual-control input forwarding.
  Customer-facing schemas stay intent-only — coordinate primitives
  bypass the behavioral simulation layer. The GUI now uses a
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
  Tauri-based GUI client had a hand-written fetch wrapper as a
  workaround. Rewriting to Web Crypto API
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
