---
layout: ../../layouts/DocLayout.astro
title: SDK versioning policy
description: Driftstack SDK versioning and deprecation policy, independent of HTTP API versioning.
---

# SDK versioning + deprecation policy

**Status:** Active
**Effective date:** 2026-05-05
**Applies to:** `@driftstack/sdk` (TypeScript), `driftstack-sdk`
(Python — that's the PyPI distribution name; the import name is
`driftstack`),
`github.com/driftstackdev/driftstack-api/packages/sdk-go` (Go).

The three SDKs follow the same versioning + deprecation policy. Each
maintains its own CHANGELOG.md tracking concrete additions / removals
per version. This doc is the operating contract that the CHANGELOGs
implement.

## Versioning — SemVer

All three SDKs follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html):

- **MAJOR** bump on breaking changes — any change that requires
  customer code to be modified to keep working. Examples: removing
  a public method or class, renaming a public field on a returned
  object, narrowing a parameter's accepted type, removing an export.
- **MINOR** bump on backwards-compatible feature additions. Examples:
  new method on an existing resource, new optional parameter on an
  existing method, new exported type, new public class.
- **PATCH** bump on backwards-compatible bug fixes. Examples: fixing
  a runtime error in an existing method, correcting a documented but
  wrong return type, performance improvements.

The Driftstack server itself is not versioned — its API is
versioned via the `/v1/` URL prefix; breaking changes there bump to
`/v2/`. SDKs follow whichever API version they target. Today every
SDK targets `/v1/`; targeting a different API major requires an SDK
major-version bump.

## Pre-1.0 stability

All three SDKs are currently pre-1.0 (`0.x.y`). Pre-1.0 SemVer
relaxes the breaking-change rule for MINOR bumps: 0.x.y → 0.(x+1).0
is allowed to break. We DO NOT take advantage of this — pre-1.0
breaks bump the MINOR version AND get explicit deprecation notice
(see Deprecation policy below). The bar is the same as post-1.0;
the difference is only that we haven't promised long-term stability.

Customers integrating a pre-1.0 SDK should pin a compatible version
(e.g., `^0.2.0`) and read the CHANGELOG before bumping.

## Deprecation policy

A method, type, or behavior is deprecated by:

1. Adding `@deprecated` JSDoc / Python `DeprecationWarning` / Go
   doc-comment `// Deprecated:` to the symbol in the SDK source.
2. CHANGELOG.md entry under the next MINOR-or-greater release noting
   the deprecation, the replacement (if any), and the declared
   removal version.
3. SDK runtime emits a one-time deprecation warning on first use
   (TS via `console.warn`; Python via `warnings.warn(category=
DeprecationWarning)`; Go is doc-only since runtime warnings would
   be noisy in non-interactive callers).

Removal happens after **at least one MINOR version release** that
contains the deprecation notice. So:

- v0.5.0: deprecate `oldMethod`, ship replacement `newMethod`.
- v0.5.x: patches; oldMethod still works with deprecation warning.
- v0.6.0: oldMethod still works with warning.
- v0.7.0 (or later): oldMethod removed; major-equivalent change
  (since pre-1.0, MINOR bump is sufficient signal).

Post-1.0:

- vX.Y.Z: deprecate.
- vX.(Y+1).0: still works with warning.
- v(X+1).0.0: removed.

The deprecation period is at minimum 30 days post-deprecation-release
to give customers time to migrate even if the version cadence is
rapid.

## Migration paths

When a breaking change ships, the SDK release post includes a
**migration guide** in the GitHub release notes covering:

1. What the old code looked like.
2. What the new code looks like.
3. Sed/regex replacement when feasible.
4. Behavioral differences (if any) that aren't a pure rename.

For non-trivial breaks, a migration script ships inside the SDK package
as `scripts/migrate-<from>-to-<to>.<ext>`.

## Cross-SDK consistency

The three SDKs MUST stay in lockstep on:

- Resource names + method names. `client.sessions.create()` exists in
  all three with semantically equivalent behavior.
- Error class hierarchy. `RateLimitError` / `InvalidKeyError` /
  `SessionTimeoutError` / etc. exist in all three, under one name
  wherever the SDKs share one. Two problem types deliberately do not:
  `tier-limit` is `TierLimitError` in TypeScript but
  `QuotaExceededError` in Python and Go, and `driver-not-integrated`
  has a dedicated class only in TypeScript — Python and Go map that
  problem type onto `DriverError`, so a caller there cannot tell it
  apart from a `driver-error` by class. Both are explicit entries in
  each SDK's problem-type registry.
- Webhook signature verification helper. `verifyWebhookSignature` in
  TS, `verify_webhook_signature` in Python, `VerifyWebhookSignature`
  in Go.
- OpenAPI schema. Each SDK regenerates its types from the same
  `openapi.json` per release.

When a feature lands in one SDK but not another, the missing SDKs
get a CHANGELOG parity note and a tracking issue. The lag must not
exceed one MINOR release.

## Version-pinning recommendations

In customer code:

- **TypeScript**: `"@driftstack/sdk": "^0.2.0"` (caret = pre-1.0
  pinning to MINOR). Bump on customer schedule.
- **Python**: `driftstack-sdk>=0.2.0,<0.3` or
  `driftstack-sdk~=0.2.0` (PEP 440 compatible-release). Pin the
  `driftstack-sdk` distribution name — `pip install driftstack-sdk`,
  then `import driftstack`.
- **Go**: `go.mod` with `github.com/driftstackdev/driftstack-api/
packages/sdk-go v0.3.0`. Bump via `go get -u`.

What every one of those lines has in common: while a package is `0.x`, a
MINOR version can change the surface and a PATCH never does, so the default
install already takes only the safe releases. Read the CHANGELOG before moving
to a new minor. Pin an exact version only if you need a byte-for-byte
reproducible build — and a lockfile (`package-lock.json`, the resolved
requirements file, `go.sum`) already gives you one, so for most deployments
there is nothing further to do.

## Releases

Each SDK release ships with a CHANGELOG entry and a GitHub release
post that includes a migration guide when the release is breaking.

## Cross-references

- Each SDK's `CHANGELOG.md` for the running history.

## Current support boundaries

- **LTS branches**. The SDKs don't carry long-term support
  branches; only the latest MINOR receives patches.
- **Deprecation notices**. The SDK CHANGELOGs and source-level
  deprecation markers are the source of truth.
- **Telemetry on deprecated-call usage**. Customer-side telemetry
  for deprecated SDK call sites is not collected.
