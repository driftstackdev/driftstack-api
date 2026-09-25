# Changelog

All notable changes to the `driftstack` Python SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`warning` on a successful step result** — present on a `results` entry of
  kind `"success"` when there is something worth knowing about the step, and
  absent otherwise. Its one kind today is `"http_error_status"`: a navigation
  reached the site and the site answered with an HTTP status of 400 or above,
  carried in `status`. The step still succeeded — the page that loaded may be
  an error page, a page asking to sign in or to complete a verification step,
  or the whole page served under that status — and its `summary` says what the
  site answered. The generated models list the known kind and accept any other
  string: treat a kind you do not recognise as a note and read `summary`.
- **Desktop browser sign-in: code verifier (PKCE).** `auth.cli_authorize_initiate`
  forwards `code_challenge` (unpadded base64url SHA-256 of a `code_verifier`
  you keep) with `code_challenge_method: "S256"`, and
  `auth.cli_authorize_exchange` forwards `code_verifier`. A flow started with
  a challenge cannot be collected without the verifier, so the `code` and
  `state` in `browser_url` are no longer enough on their own. On both
  `Driftstack` and `AsyncDriftstack`.
- **`capability_report.egress_state` can read `"default_connection_down"`**
  (the generated `CapabilityReport` model's `Literal` lists it). A session
  started without a proxy of its own runs on the connection Driftstack
  provides; this value means that connection stopped carrying traffic while
  the session ran. It is on our side: there is nothing to fix at yours, and a
  session started with one of your own proxies runs now. `"dead_proxy"` keeps
  its meaning — your own proxy stopped. On `GET /v1/sessions/{id}` the same
  fact arrives as the `default_connection_down` code in
  `egress_capabilities.warnings`, and for that session a connection without
  UDP reads `quic_unavailable` and a failed check that its traffic left the
  right way reads `safeguard_failed` — never `udp_unsupported_by_proxy` or
  `safeguard_failed:proxy_egress_verification`, which name a proxy it does
  not have.
- **Error code `"default_egress_unavailable"`** in an agent session's
  `error_event.code`, and as its `closed_reason`: a session with no proxy of
  its own could not connect through Driftstack's connection. It arrives with
  `customer_actionable` `False` — ours to fix — and a session started with one
  of your own proxies runs now. `code` stays a `str`, so nothing to change
  unless you branch on it.

### Deprecated

- Calling `auth.cli_authorize_initiate` without `code_challenge`. It works as
  before until **31 January 2027**; responses carry `Deprecation` and
  `Sunset` headers, and from that date the server answers `400`.

## [0.3.0] - 2026-09-22

**Nothing was removed.** Every name 0.2.0 exported, every method, every
keyword argument and every error class is still here and still means the
same thing, so upgrading takes no code change on its own — except where
**Migration** below says a string comparison needs updating. Every addition
below exists on **both** `Driftstack` and `AsyncDriftstack`.

### Added

- **`EgressCapabilities.safeguards`** — `"passed"`, `"failed"` or
  `"unverified"`, summarising whether every egress safeguard held for a
  session. `"failed"` wins whenever any check did not pass; `"passed"` only
  when the device declared the full set of checks a healthy session reports
  and every one of them reported back; `"unverified"` otherwise. The field is
  **absent**, not `None`, on a session reported before it existed — do not
  read an absent value as `"unverified"` or `"passed"`. Rides everywhere
  `egress_capabilities` already does: `sessions.get()` / `.list()` /
  `.create()`, `profiles.launch()`, and the
  `session.egress_capability_changed` webhook payload.
- **`measured_by`** on a `?check=full` proxy test result
  (`egress.test_proxy(proxy_id)`) — `"phone"` when a real phone session took
  the measurement, `"driftstack"` when Driftstack itself did because no phone
  could be reached in time. The field this replaces, `measured_from`, is
  still sent beside it with its original values for existing integrations,
  but is no longer documented; read `measured_by` from here on.
- **`direct_reading` and `website_like_reading`** on `os_fingerprint` — the
  same two facts `single_host_vantage` and `web_port_vantage` already carry,
  under plainer names, added beside the originals rather than replacing
  them. Present on the proxy test result **and** on each saved
  proxy returned by `egress.list_proxies()` / `.update_proxy(proxy_id, body)`.
- **`"page_unreadable"`** joins the `AgentNoticeReason` values a
  `plan-executed` result can carry: the page could not be read to plan the
  next step, so the task stopped rather than guess. Send `continue` to try
  again.

### Changed

- **Two dead `egress_capabilities.warnings` codes are retired from the
  documentation**: `quic_disabled_fallback_http2` and
  `dns_remote_resolve_unsupported_by_proxy`. Neither has ever been sent, so
  this is a documentation correction, not a behavioural change.

### Migration

Two closed-string fields were narrowed — values removed, not added — inside
the `?check=full` proxy test result. `egress.test_proxy()` and
`egress.list_proxies()` return a plain `dict`, not a validated model, so the
affected `AccountProxyTestResult*` / `OsFingerprint` models in
`driftstack._generated.models` are typing-only for these two fields: neither
change raises at call time, and code comparing a value against one of the old
strings simply stops matching, silently. The server has sent the new values
only since 2026-09-21.

- **`not_run`** — `"node_busy"`, `"node_error"` and `"no_node"` merged into
  `"check_unavailable"` (you can do exactly one thing about any of the
  three: try again shortly, or contact support if it persists);
  `"unresolvable"` is now `"config_unresolvable"`, matching the word the
  "why a launch is refused" vocabulary already used for the identical fact.
  `"live_session"` is unchanged.
- **`os_fingerprint_unavailable`** — `"vpn_tunnel"` is now
  `"not_available_for_vpn"`, `"not_observed"` is now `"not_captured"`, and
  `"observer_off"` is now `"not_offered_here"`.

Update any code that compares `not_run` or `os_fingerprint_unavailable`
against one of the old strings to compare against its replacement instead.

### Pre-1.0 stability

The SDK is pre-1.0. Pin `driftstack-sdk~=0.3.0` rather than an exact version
and read this file before bumping.

## [0.2.0] - 2026-09-20

The release the guide [Run AI tasks from your
code](https://docs.driftstack.io/guides/run-ai-tasks-from-code/) is written
against — 0.1.5 cannot run any of its examples, because the AI agent was not
reachable from it at all.

**Nothing was removed.** Every name 0.1.5 exported, every method, every
keyword argument and every error class is still here and still means the same
thing, so upgrading takes no code change. What grew: both clients went from 4
resources to 19, and `driftstack.__all__` from 22 names to 56. Every addition
below exists on **both** `Driftstack` and `AsyncDriftstack`. Read **Changed**
before you upgrade anyway — a few behaviours differ, and one of them changes
which exception an `except` clause sees.

### Added

#### Run an AI task end to end

`client.agent_sessions` is new, and is the whole AI surface.

- **Start it, send the task, close it** — `create(body, ...)` opens a
  session, on a saved profile if you pass one; `message(id, text, ...)` sends
  the task in plain words and returns what happened; `get(id)`,
  `list(...)` and `iterate(...)` read sessions back; `close(id)` ends one and
  saves the profile's sign-in. A new session is `provisioning` until its
  browser is ready, then `active`.
- **Every way a turn can end is a named result kind** — `plan-executed` (the
  steps ran, with `answer` when you asked a question), `clarify` (the agent
  is asking you something), `refuse` (it will not do this), `stopped`, and a
  step held for your approval. `answer_unavailable` says why there is no
  `answer` when you asked for one.
- **Live progress while it runs** — `message(..., on_step=..., on_event=...)`
  parses the turn's stream as it arrives: `on_step(step)` gets each step
  (`{"index", "result"}`) and `on_event(name, data)` every other progress
  event (`phase`, `plan`, `step_start`, `answer`, `notice`, and any added
  later). On the async client either callback may be `async def`.
- **Approve a step, or don't** — a step with real-world consequences (a
  payment, a message sent, something deleted) pauses the turn and comes back
  as `confirmation_required`. Send the same task again with
  `approve_consequential_actions=` to release it; it accepts the step result
  exactly as it was returned, as well as `{"category", "matched_text"}`
  dicts, and raises `ValueError` before sending anything if an entry is
  neither. An unattended job simply never approves.
- **Stop a task that runs too long** — `stop(id)` asks the running turn to
  stop; the waiting `message()` then returns kind `stopped` rather than
  raising.
- **Screenshots** — `get_capture(id, capture_id)` returns the image behind a
  `capture` step's `captureId` as `{"content_type", "bytes"}` (`image/png` or
  `image/jpeg`). Screenshots are kept only briefly, so fetch one as soon as
  its turn ends; one that is no longer kept raises `NotFoundError`.
- **Transcripts** — `transcript(id, last_event_id=..., timeout_s=...)`
  iterates the session's conversation — an iterator on the sync client, an
  async iterator on the async one: every entry so far, then each new one as
  it is written. `last_event_id` resumes after the last `index` you saw, and
  closing the iterator closes the connection.
- **Why a turn handed back, in one word** — a `plan-executed` result carries
  `notice_reason` beside the `notice` sentence: `"step_limit"`,
  `"time_limit"`, `"budget_low"`, `"no_progress"`, `"repeated_step"`,
  `"ai_unavailable"`, `"question"` or `"declined"`, exported as the open
  union `AgentNoticeReason` (`Literal[...] | str`), so an ending this SDK has
  never heard of still type-checks and still parses — match the ones you know
  and show `notice` for the rest.
- **When it is safe to retry a message** — a refusal that did no work leaves
  its `Idempotency-Key` free: after a 409 whose `turn_in_progress` is set, a
  429, a 402, a 403 about the plan's AI or the model, or a 502 whose
  `key_rejected` is false, send the same request again with the **same**
  `idempotency_key=`. Any other failure gets a new one. One message is one
  key, always.
- **Typed refusals you can act on** — `ForbiddenError.requires_own_key` /
  `.model` (this model needs your own Anthropic key);
  `ConflictError.turn_in_progress`, `.session_status`, `.idempotency_status`,
  `.ai_control_unavailable`, `.phase`, `.tokens_consumed`, `.usage`,
  `.partial_results` and `.closed_reason` (why a closed session ended,
  without a second call); `FeatureUnavailableError.stop_unconfirmed` (the one
  `stop()` 503 worth calling again); and
  `ByokAnthropicRequiredError.key_rejected` / `.key_source` /
  `.key_rejected_reason` (your own key was refused, which key, and why).
- **Send your own Anthropic key** — `byok_api_key=` on `create()`, so a
  session can run on a model that requires one without storing anything.
- **Bound the whole call** — `timeout_s=` on `message()` (default 50
  minutes).
- **Why a step failed** — a failed step's `Diagnosis.category` explains it,
  including `"target_unverified"` (the tap was not made because its target
  could not be checked first — not retryable as the same step; the agent
  re-plans).
- **`examples/agent_chat.py`** is the complete flow end to end: create, wait
  until ready, send a task with a fresh idempotency key and live progress,
  handle every result kind, close in `finally`.

#### Watch one live, or take the wheel

- **`livekit_token(id)`** — a token for the live video view of a running
  session, so a person can watch it work. Returns `LiveKitInfo`.
- **`set_mode(id, body)`**, **`takeover(id, client_id)`** and
  **`handback(id)`** — hand control of a running session between the agent
  and a person, and hand it back. **`send_input_event(id, body)`** drives it
  while a person holds it, and **`resume(id)`** picks a session back up.
- **`set_egress(id, body)`** changes which of your proxies a running session
  goes out through.

#### The rest of the API

`client.sessions`, `client.api_keys`, `client.usage` and `client.webhooks`
were the whole client in 0.1.5, and each of the four gained methods:
`sessions` gained `get` / `iterate` / `extract` (pull structured data off the
page) / `search` / `login`; `usage` gained `series()` for usage over time;
`api_keys` gained
`rotate()` (issue the replacement and keep the old key working for a grace
window); `webhooks` gained `update()` (partial update — it does not rotate
the signing secret), `rotate_secret()` (fresh secret shown once, previous one
valid for 24h, both signatures sent during the window), `send_test()` (a
synthetic `test.ping` delivery so you can check your handler before depending
on it), `replay_delivery()` and `iterate_deliveries()`.

And fourteen resources are new:

- **`client.profiles`** — create, list, iterate, get, update, delete, plus
  `clone(profile_id, body=None)` (pass `None` to let the server name it
  "(copy)", "(copy 2)", …) and `trim()`.
- **`client.profile_snapshots`** — immutable point-in-time copies of a
  profile: `capture`, `list_for_profile`, `list`, `iterate`, `get`,
  `restore`, `delete`. `restore` creates a NEW profile; the original is never
  modified.
- **`client.account`** — `me()` (the full account profile: timezone, slug,
  region, avatar, whether MFA is enrolled, team memberships),
  `update_me()`, `upload_avatar()` / `clear_avatar()`,
  `list_web_sessions()` / `revoke_web_session(id)` /
  `revoke_all_other_web_sessions()`, and `rate_limits()` for the limits
  actually in force on your account.
- **`client.auth`** — sign-up, e-mail verification, log in, magic links,
  password reset, refresh, log out, and the three-call activation flow a CLI
  or desktop app uses instead of asking for a pasted key
  (`cli_authorize_initiate` → open the returned `browser_url` → poll
  `cli_authorize_exchange`, which delivers the key once, then reports
  `expired`).
- **`client.mfa`** — `status`, `enroll`, `verify`, `disable`,
  `regenerate_recovery_codes`; plus `auth.mfa_challenge()` to exchange a
  login challenge for a session (the response says whether it was satisfied
  by `"totp"` or `"recovery"`) and `auth.mfa_step_up()` to refresh the
  freshness window an operation asked for.
- **`client.team`** — members, invites, roles, and `list_owners()` for the
  workspaces your account has joined.
- **`client.audit_log`** — `list` / `iterate`, and `export()`: a single-call
  JSON export of your account's audit log, up to 10,000 rows, with
  `truncated` set when there were more.
- **`client.billing`** — current state, checkout, and the billing portal.
- **`client.crypto_orders`** — `quote`, `create_checkout` (takes
  `idempotency_key=` so a retry cannot mint a second order), `list`,
  `iterate` (walks every page for you; narrow it with `status`,
  `created_after`, `created_before`), `get`, `update_note`, `cancel`,
  `receipt`. Crypto payments are not refundable, and cancelling only works
  while an order is pending.
- **`client.egress`** and account proxies — manage saved proxies and route a
  session's traffic through one with `proxy_id` on create.
- **`client.archetypes`** — the device archetypes your plan can use.
- **`client.recipes`** — `create(agent_session_id=, label=, description=)`
  snapshots a finished agent session's steps and transcript into a recipe you
  can replay.
- **`client.email_preferences`** — `list` / `set` / `opt_in` / `opt_out`.
- **`client.legal`** — record acceptance of a document version.

#### Errors and retries

- **`is_retryable(err)`** is exported, so the predicate the built-in retry
  loop uses is one you can call yourself.
- **New error classes**, all importable from `driftstack`:
  `BadRequestError`, `InternalError`, `FeatureUnavailableError`,
  `MfaStepUpRequiredError`, `EmailAlreadyRegisteredError`,
  `InvalidCredentialsError`, `InvalidAuthTokenError`,
  `EmailNotVerifiedError`, `ByokAnthropicRequiredError`,
  `ProxyValidationFailedError`, `StorageQuotaExceededError`,
  `ProfileInUseError`, `BundledLlmConsentRequiredError`,
  `BundledLlmBudgetExhaustedError`, `PairModeConflictError` and
  `PairModeStateInvalidTransitionError`.
- **`verify_webhook_signature` accepts `header_prev=`** — an optional second
  signature header. You rarely need it: during a rotation grace window both
  signatures arrive inside the one `x-driftstack-signature` header, which the
  verifier already checks.

### Changed

- **Too many AI turns is a `RateLimitError` now.** This refusal answers as
  `rate-limited` with `retry_after_seconds` 5, so `message()` raises
  `RateLimitError` where it raised `ConcurrencyLimitError`.
  `ConcurrencyLimitError` still means exactly what it always meant on
  `create()`: your plan's limit on sessions running at once.
- **A generic 400 raises `BadRequestError` now**, not `ValidationError`. A
  400 that carries field-level issues is still a `ValidationError`. Callers
  with `except ValidationError` around a generic 400 should switch to
  `except BadRequestError`; `except DriftstackError` catch-alls and
  `is_retryable` are unaffected.
- **The agent-session docstrings describe what the API does** — result kinds,
  how an approval resumes paused steps, when a key may be reused, the
  progress event names — and no longer describe how the service is built. The
  README no longer claims every resource returns a Pydantic model
  (`agent_sessions` returns dicts) and now says that `ForbiddenError` is a
  subclass of `AuthError`.

### Fixed

- **A failure category newer than the SDK no longer breaks parsing.**
  `Diagnosis.category` is `Literal[...] | str`, so a category the server adds
  after this release is kept as a plain string. ⚠️ **This is the one reason
  to upgrade before you need to.** In 0.1.5 the field is a closed `Literal`,
  so a response carrying a category that SDK has never seen raises a pydantic
  `ValidationError` for the **whole** response — not just that field. Treat a
  value you do not recognise as `"unknown"`; code comparing `category`
  against known strings needs no change.
- **The account profile matches the full response** — `me()` returns every
  field the API sends, including the ones added since 0.1.5.

### Pre-1.0 stability

The SDK is pre-1.0. The surface is stable enough to build against, but a
MINOR bump may still carry additive changes — new methods, new fields, new
error subclasses. **Patch** releases (0.2.x) are fixes and additive types
only. Breaking changes that would stop shipping customer code are deferred to
1.0; until then pin `driftstack-sdk~=0.2.0` rather than an exact version, and
read this file before bumping.

## [0.1.5] - 2026-05-03

Written on 2026-09-20 from the published wheel: 0.1.5 went to PyPI without a
CHANGELOG heading of its own.

### Added

- **`LegalAcceptanceRequiredError`** — a 409 that asks you to accept a
  document version is its own exception now, carrying the pending
  acceptances (`document_key` + `current_version` for each) as
  `pending_acceptances`. Exported from the package root.

## [0.1.4] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error subclass mapping
  the `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `timeout_ms: int | None` from the
  problem extension. Re-exported at `driftstack.SessionTimeoutError`
  for convenient `isinstance` checks.

  ```python
  from driftstack import SessionTimeoutError

  try:
      client.sessions.interact(sid, body)
  except SessionTimeoutError as e:
      # Retry with a longer timeout, or surface to the user.
      print(f"Op timed out after {e.timeout_ms} ms")
  ```

- Test coverage at `tests/test_errors.py::test_session_timeout_extracts_timeout_ms`.

## [0.1.3] - 2026-05-03

### Removed

- `tap.offset` field stripped from the public `InteractAction.tap`
  shape. Same reason as `tap_at`: a coordinate primitive on the
  customer-facing schema lets the customer bypass the behavioral
  simulation layer. Bounded coordinates are still coordinates.

### Migration

If your code passes `offset={"x": ..., "y": ...}` to a `tap`
action, the value is now silently dropped (Pydantic strips unknown
keys by default). Re-express the intent through selector
specificity — better selectors, child-element targeting, ARIA-role
qualifiers, text-content matching:

```python
# Before (0.1.x):
client.sessions.interact(
    session_id,
    InteractRequest(action={"kind": "tap", "selector": "button.cta", "offset": {"x": 0, "y": 50}}),
)

# After (0.1.3+):
client.sessions.interact(
    session_id,
    InteractRequest(action={"kind": "tap", "selector": "button.cta .icon-arrow"}),
)
```

Coordinate-level addressing for screenshot-driven workflows lives
behind a separate endpoint gated by the `gui_control` API-key
scope, and is not exposed in this SDK.

## [0.1.2] - 2026-05-03

### Added

- Wire-shape regression tests at `tests/test_wire_shape.py` (10
  tests). Locks the canonical JSON shape for `InteractRequest`,
  `WaitRequest`, `NavigateRequest`. Asserts rejection of `tap_at` /
  `type_focused` (these live behind the `gui_control`-scoped
  endpoint).

### Fixed

- `tests/test_client.py::test_version_string_matches_pyproject_default`
  was pinning `__version__ == "0.0.1"` (stale from the pre-publish
  era). Fixed to assert SemVer shape, not exact value.

## [0.1.1] - 2026-05-02

### Changed

- Re-cut: `tap_at` and `type_focused` removed from
  `InteractAction`. They were briefly added in 0.1.0+ for the
  self-hosted GUI's manual-control input forwarding, and reverted.
  Customer-facing schemas stay intent-only — coordinate primitives
  bypass the behavioral simulation layer. The GUI now uses a
  separate, scope-gated endpoint
  (`/v1/sessions/:id/gui-input`).

## [0.1.0] - 2026-05-02

### Added

- Inaugural PyPI publish (under a maintainer account pre-entity;
  will transfer to a company-owned account once the legal entity
  is registered).
- Pydantic models regenerated from updated OpenAPI spec.

## [0.0.1] - 2026-05-02

### Added

- `Driftstack` (sync) and `AsyncDriftstack` (async) clients.
- Resource accessors mounted on the client: `sessions` (9 methods),
  `api_keys` (3), `usage` (1), `webhooks` (5).
- Typed Pydantic v2 models generated from the API's OpenAPI 3.1 spec.
- Error hierarchy: `DriftstackError` base + 14 subclasses covering
  every documented RFC 7807 problem type. `RateLimitError`,
  `ConcurrencyLimitError`, `QuotaExceededError` carry the relevant
  payload fields.
- Retry policy (`RetryConfig` + `with_retry`) with exponential
  backoff and full jitter; honours `Retry-After`.
- `verify_webhook_signature` helper (Stripe-style HMAC-SHA256,
  constant-time).
- 85 tests covering errors, retry, webhook signatures, every
  resource method, and end-to-end customer-journey workflows.
- Examples: `quickstart`, `error_handling`, `webhook_receiver`,
  `langchain_tool`, `pytest_fixture`.

### Build

- Hatchling backend, `py.typed` marker for PEP 561.
- Runtime deps: `httpx>=0.27,<1.0`, `pydantic[email]>=2.5,<3.0`.
- Dev deps: `pytest`, `pytest-asyncio`, `respx`, `ruff`, `mypy`,
  `datamodel-code-generator`.
- CI: lint + format + mypy + pytest on Ubuntu / Python 3.10.
