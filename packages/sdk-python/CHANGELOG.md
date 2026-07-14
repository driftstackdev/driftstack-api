# Changelog

All notable changes to the `driftstack` Python SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Durable agent-turn idempotency** — sync and async
  `client.agent_sessions.message(..., idempotency_key="…")` forward one
  caller-reusable `Idempotency-Key` beside SSE/BYOK headers so an ambiguous
  retry cannot execute browser actions twice.
- **`client.team.list_owners()`** plus the async mirror — typed access
  to `GET /v1/team/owners` for owner workspaces the calling account has
  joined. Returns `TeamOwnersList` / `TeamOwner` and requires broad
  `read` (or `account_owner`).
- `BadRequestError` — the generic `bad-request` problem-type (HTTP 400,
  no field-level issues) now maps to a dedicated `BadRequestError`
  (subclasses `DriftstackError` directly, a sibling of `ValidationError`),
  mirroring the TypeScript + Python error surface. Exported from the
  package top level (`from driftstack import BadRequestError`).
  `validation-failed` continues to map to `ValidationError`.

### Changed

- **Minor behaviour change:** a generic 400 (`bad-request` problem-type)
  now raises `BadRequestError` instead of `ValidationError`. Callers with
  `except ValidationError` around a generic 400 should switch to
  `except BadRequestError`. `validation-failed` 400s are unaffected, and
  `except DriftstackError` catch-alls (and `is_retryable`) are unaffected.

### Added

- `proxy_id` on agent-session create (`agent_sessions.create` body) — route
  the session's egress through one of your account proxies (managed at
  `/v1/account/me/proxies`). Must be an owned proxy id (unknown / not-owned
  → 404). Optional; omit for the default egress.
- `session.profile_save_failed` webhook event (regenerated models) — a
  profile-backed session's save-back failed at teardown (terminal; the
  next restore of that profile will be stale). Subscribable; payload
  carries `session_id`, `profile_id`, `reason`
  (`serialize_failed|seal_failed|too_large|upload_failed`) and an
  optional `detail`.

### Added

- **`Session.egress_capability_report`** (Arc 5 EGRESS eg.1.f) —
  raw harness-emitted event payload as `dict[str, Any] | None`,
  stored alongside the derived `egress_capabilities` view. Forensics
  - schema-evolution safety net: surfaces fields the SDK schema
    doesn't formally know (e.g. harness-side diagnostic counters)
    without requiring an SDK release. Consumers should prefer
    `egress_capabilities` for typed access; this is opaque JSON for
    inspection / observability piping. Regenerated `_generated/
models.py` via the `scripts/generate.sh` codegen pipeline.
- **`client.agent_sessions.takeover(agent_session_id, client_id)`** +
  **`.handback(agent_session_id)`** + async mirrors (v2-#8 Arc 2
  sub-slice 8.9) — pair-mode state-machine wrappers. Takeover requests
  a human to take control of a `mode='pair'` agent session (state
  machine transitions `ai-driving → takeover-pending`, or
  `takeover-queued` when the runtime is mid-decompose); handback
  returns control to AI from `human-driving`. Both return
  `{"pair_mode_state": {"kind": ..., ...}}`. Raises
  `PairModeStateInvalidTransitionError` (409) on invalid transitions.
- **`client.recipes.create(agent_session_id=, label=, description=)`**
  (AI-B4 / Q.5.d) + async mirror — snapshot a finished agent-session's
  intent_log + transcript into a replayable recipe row. `label` is
  1..120 chars and `description` is ≤2000 chars after trim. Server
  assembles `intent_log` by flatMapping the source agent-session's
  transcript — each plan-executed turn's structured intent array
  contributes in turn order. Returns the inserted recipe dict
  including `intent_count`. Read / list / execute / delete are v1.1
  D2/D3 surfaces. 503 until the deployment wires both `recipesRepo`
  and `agentSessionsRepo`.
- **`client.crypto_orders.*`** + async mirror (V-666 Python parity) —
  customer-facing crypto-checkout surface: `quote(body)`,
  `create_checkout(body, *, idempotency_key=None)`, `list(*, limit,
status, cursor, created_after, created_before)`, `iterate(...)`,
  `get(order_id)`, `update_note(order_id, body)`, `cancel(order_id)`,
  `receipt(order_id)`. The `Idempotency-Key` header is forwarded
  through `create_checkout` so retries don't mint duplicate orders.
  `iterate(...)` is the recommended way to walk every order — cursor
  handoff is managed internally; pass `status` / `created_after` /
  `created_before` to narrow the walk. Crypto payments are
  non-refundable; consult the support team for disputes.
- **`client.webhooks.send_test(webhook_id)`** + async mirror
  (V-463 / V-356) — synthetic `test.ping` delivery; bypasses
  subscription. Returns `{delivery_id, event_id, event_type}`.
- **`client.webhooks.update(webhook_id, body)`** + async mirror
  (V-464 / V-351) — partial-update a webhook endpoint
  (`url`/`events`/`description`/`active`; at least one required).
  Signing secret is NOT rotated by update — use `rotate_secret`.
  Disabled endpoints cannot be updated (409).
- **`client.audit_log.export()`** + async mirror (V-462 / V-297) —
  single-call JSON bulk-export of the calling account's audit log.
  Designed for GDPR Article 20 data-portability requests; up to 10,000
  rows per call; response dict includes `truncated` for the ceiling
  case. CSV download (browser-driven spreadsheet flow) is intentionally
  not surfaced through the SDK.
- **CLI/GUI activation flow** (V-460 / V-266) — three new methods on
  `client.auth` plus async mirrors: `cli_authorize_initiate`,
  `cli_authorize_bind`, and `cli_authorize_exchange`. CLI/GUI tools
  call `cli_authorize_initiate` for a `code` + `browser_url`, open the
  URL, the user signs in + confirms, and the CLI/GUI polls
  `cli_authorize_exchange` for one-shot delivery of the plaintext API
  key. Status discriminator on the exchange response: `pending` /
  `bound` (with `api_key` + `account_id`) / `expired`.
- **`client.profile_snapshots`** + **`async_client.profile_snapshots`** —
  V-312 immutable point-in-time profile copies. Methods: `capture`,
  `list_for_profile`, `list` (cross-account), `iterate`, `get`,
  `restore`, `delete`. `restore` creates a NEW profile; the original
  is never modified.
- **`client.profiles.clone(profile_id, body=None)`** + async mirror —
  V-313 profile clone. `None` / empty dict lets the server auto-derive
  a "(copy)" / "(copy 2)" / ... name; explicit `{"name": ...}` is
  forwarded verbatim.
- **`client.webhooks.rotate_secret(webhook_id)`** + async mirror —
  V-359 webhook signing-secret rotation. Returns dict with the fresh
  plaintext (shown ONCE), prefixes, and `grace_expires_at`. Previous
  secret stays active for 24h.
- **`client.account.me()`** + async mirror (V-434) — V-385 full
  `/v1/account/me` rich-shape read (15+ fields incl. slug, region,
  avatar_url, mfa_enrolled, teams). Returns `dict[str, Any]` until
  the next `scripts/generate.sh` regen pass adds a Pydantic model.

### Regenerated (V-432)

- `_generated/models.py` refreshed against the live OpenAPI spec.
  Picks up V-148 tier rename (`free`/`starter`/`solo`/`builder`/
  `scale` → `trial_pack`/`solo_manual`/`team_manual`/`agency_manual`/
  `api_starter`/`api_builder`/`api_scale`), V-185 + V-359 webhook
  fields (`prev_secret_prefix`, `rotation_grace_expires_at`,
  `delivery_counts`), V-169 session purpose field, V-174 expanded
  scope enum, etc.

### Added typed errors (V-439)

- `FeatureUnavailableError` — endpoint requires infrastructure not
  configured in this deployment (HTTP 503).
- `MfaStepUpRequiredError` — V-353e step-up gate; customer should
  call `client.auth.mfa_step_up(...)` and retry.
- `InternalError` — unhandled server error.

`PROBLEM_TYPE_TO_ERROR` now covers 24 typed problem URIs.

### Added (V-445)

- **`client.auth.mfa_challenge(body)`** + async mirror — V-353d
  exchange of login challenge_token for a session via TOTP or
  recovery code. Response includes `via: "totp" | "recovery"`.
- **`client.auth.mfa_step_up(body)`** + async mirror — V-353e
  refresh of `mfa_satisfied_at` (15-minute freshness window). No
  new session issued. Pair with `MfaStepUpRequiredError` recovery:
  catch → `mfa_step_up` → retry.

### Added (V-448 / V-449 / V-450) — Account-surface parity

- **`client.mfa`** + async mirror — V-353b MFA enrollment
  (`status / enroll / verify / disable / regenerate_recovery_codes`).
- **`client.audit_log`** + async mirror — V-216 audit-log
  (`list / iterate`).
- **`client.email_preferences`** + async mirror — V-204 opt-in/
  opt-out (`list / set / opt_in / opt_out`).
- **`client.account.update_me(body)`** — V-352 PATCH /me.
- **`client.account.upload_avatar(body)`** + **`clear_avatar()`** —
  V-352b.
- **`client.account.list_web_sessions()`** +
  **`revoke_web_session(id)`** + **`revoke_all_other_web_sessions()`** —
  V-355.
- **`client.account.rate_limits()`** — V-258.

Three-SDK Account-surface parity complete: every `/v1/account/*`
endpoint registered server-side is now exposed in all three SDKs.

### Notes

- `0.0.1` is the inaugural alpha. Versioning will move to SemVer
  proper once the SDK is published to PyPI (gated on entity setup).

## [0.1.4] - 2026-05-03

### Added

- **`SessionTimeoutError`** — new typed error subclass mapping
  the `https://errors.driftstack.dev/session-timeout` problem type
  (status 504). Distinguished from `DriverError` so callers can
  react specifically to "the operation didn't finish within the
  per-call timeout I supplied" without conflating with downstream
  driver failures. Carries `timeout_ms: int | None` from the
  problem extension. Re-exported at `driftstack.SessionTimeoutError`
  for convenient `isinstance` checks. See V-044 [control].

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
  shape. Same L-001 vector as `tap_at`: a coordinate primitive on
  the customer-facing schema lets the customer bypass the
  behavioral simulation layer. Bounded coordinates are still
  coordinates. See `docs/locked-decisions.md` L-001 in the
  control-plane repo and V-042 [control].

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
on the gui-control plane (separate endpoint gated behind the
`gui_control` API-key scope), not exposed in this SDK.

## [0.1.2] - 2026-05-03

### Added

- Wire-shape regression tests at `tests/test_wire_shape.py` (10
  tests). Locks the canonical JSON shape for `InteractRequest`,
  `WaitRequest`, `NavigateRequest`. Asserts L-001 rejection of
  `tap_at` / `type_focused` (these live on the gui-control plane).

### Fixed

- `tests/test_client.py::test_version_string_matches_pyproject_default`
  was pinning `__version__ == "0.0.1"` (stale from the pre-publish
  era). Fixed to assert SemVer shape, not exact value.

## [0.1.1] - 2026-05-02

### Changed

- Re-cut: `tap_at` and `type_focused` removed from
  `InteractAction`. They were briefly added in 0.1.0+ for the
  self-hosted GUI's manual-control input forwarding; reverted per
  L-001. Customer-facing schemas stay intent-only — coordinate
  primitives bypass the behavioral simulation layer and erode the
  moat. See V-036 in the control-plane repo. The GUI now uses a
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
