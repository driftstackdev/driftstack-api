# V-551 — per-language SDK CHANGELOG plan

**Date:** 2026-05-11
**Wave:** 25
**Status:** PLAN — applies post-V-525-extraction. Each new SDK repo
ships an existing `CHANGELOG.md` from the monorepo; V-551 standardises
the format + cadence going forward.

## Current state

Each SDK package already has a `CHANGELOG.md` in the monorepo
(`packages/sdk-typescript/CHANGELOG.md`, `packages/sdk-python/
CHANGELOG.md`, `packages/sdk-go/CHANGELOG.md`). The format is loose —
free-form prose per version, not Keep-a-Changelog compliant.

After V-525 extracts each SDK to its own public repo, the CHANGELOG
becomes the customer-facing release-notes artifact. Need a stricter
format.

## Target format — Keep-a-Changelog

```markdown
# Changelog

All notable changes to this SDK are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this SDK
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New `Profiles.snapshot(id)` method.

### Changed

- `Sessions.create()` now accepts an optional `metadata` map.

### Fixed

- `WebhookSignature.verify()` no longer throws on empty payloads.

## [0.1.6] — 2026-05-10

### Added

- Initial public release.
```

Section names (Added / Changed / Deprecated / Removed / Fixed /
Security) drawn from the Keep-a-Changelog spec.

## Cadence

Each SDK release follows:

1. **During development:** changes accumulate under `## [Unreleased]`.
2. **At release time** (manual or via the V-544 generate-changelog.sh
   script):
   - Move `[Unreleased]` content into `[X.Y.Z]` with today's date.
   - Create a fresh empty `[Unreleased]` block.
   - Commit the CHANGELOG change as part of the release commit.
3. **Tag** the release commit `vX.Y.Z`.
4. **The publish workflow** (V-525 plan, Step 7) reads the
   `[X.Y.Z]` section + uses it as the npm/PyPI release notes body.

## V-544 integration

`scripts/generate-changelog.sh` (V-544.A) generates a bullet list from
commit messages. Integration target (V-551.B):

- Per-SDK: filter commits to those that touched `packages/sdk-<lang>/`
  (in the monorepo) OR everything in the standalone SDK repo
  (post-extraction).
- Categorise commits by message prefix:
  - `feat:` → Added
  - `fix:` → Fixed
  - `breaking:` or `!:` → Changed (with breaking-change warning)
  - `chore:` / `docs:` / `test:` → skip from CHANGELOG (release-notes
    audience doesn't need these)
- Output a Keep-a-Changelog formatted `[Unreleased]` block ready to
  paste into the file.

The script becomes part of each SDK repo's release runbook.

## Per-SDK divergence

The 3 SDKs version independently. They don't share version numbers.
TypeScript may be at 0.2.0 while Python is still at 0.1.6.

Reasoning: SDK changes happen at different cadences. Forcing a shared
version number creates needless churn (TS gets 0.2.0 just because
Python had a fix, even though TS itself is unchanged).

API contract is the shared concept — every SDK at any version must
work against the live API surface. The OpenAPI spec is the
cross-SDK contract; per-SDK CHANGELOGs document the wrapper-layer
divergence.

## What goes in vs out

**Goes in:**

- New methods.
- New parameters on existing methods.
- Behaviour changes (default-value tweaks, retry-budget changes,
  timeout adjustments).
- Bug fixes.
- Deprecations + removals.
- Security fixes (with CVE link if assigned).

**Stays out:**

- Internal refactors that don't change the public surface.
- Test-only changes.
- CI / workflow changes.
- Docs-only changes (unless docs were misleading customers).

## Open questions for team review

1. **Pre-1.0 SemVer interpretation** — strict (any breaking change
   bumps the MINOR — 0.1.6 → 0.2.0) vs loose (any breaking change
   in pre-1.0 is allowed, bump PATCH unless intent-changing)?
   Recommendation: strict. Pre-1.0 customers still want predictable
   upgrades.
2. **CVE-link policy** — only link real CVE IDs, or link OUR internal
   advisory IDs too (`DRIFT-2026-001` style)? Recommendation: real
   CVE IDs only; advisory IDs are internal.
3. **Yanking releases** — npm + PyPI both allow yanking. Policy:
   yank only on security-critical regression? Recommendation: yes;
   otherwise roll forward with a fix.

## Sub-slices

- **V-551 (THIS WAVE):** plan + format (this doc).
- **V-551.B:** retrofit each SDK's existing CHANGELOG.md to the
  Keep-a-Changelog format. Each retrofit lands in the SDK's extraction
  branch (`sdk-extract/<lang>`) before the V-525-driven push to the
  new public repo.
- **V-551.C:** wire `scripts/generate-changelog.sh` into a per-SDK
  release runbook + extend the script with the commit-prefix
  categorisation.

## Verification

- File written.
- Cross-references V-525 SDK extraction + V-544 changelog automation.
- V-205 + V-211 sweep: zero hits.
