# Changelog

All notable changes to the `driftstack` Python SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
