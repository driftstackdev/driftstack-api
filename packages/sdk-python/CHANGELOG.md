# Changelog

All notable changes to the `driftstack` Python SDK. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes

- `0.0.1` is the inaugural alpha. Versioning will move to SemVer
  proper once the SDK is published to PyPI (gated on entity setup).

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
