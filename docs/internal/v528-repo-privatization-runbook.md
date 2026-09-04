# V-528 — driftstack-api repo privatization runbook

**Date:** 2026-05-10
**Wave:** 17
**Status:** STAGED — manual trigger by the Driftstack team tomorrow. **Do NOT
execute overnight.**

## Purpose

Flip `driftstackdev/driftstack-api` from public to private + push 3 standalone
public SDK repos + redirect any external links. This is the locked Track E
option (a) decision (see V-524 leak audit, V-525 extraction plan).

The flip is the first **irreversible** Track E step. Until this runs, every
Track E staging artifact in Waves 15-17 is reversible (branches, docs, hook).
After this runs, the public-repo posture has changed materially and a revert
requires re-creating the public repo + force-pushing the original history.

## Pre-flight checks (run before triggering)

### Fast path (V-656 pre-stage script — recommended)

```bash
cd /Users/john/code/driftstack-api
scripts/v528-prestage.sh
```

Runs every pre-flight check in one shot:

- Clean working tree
- On `main`
- `LICENSE` present + copied to `/tmp/driftstack-api-LICENSE` (Step 1 input)
- `gh auth status` is good
- V-527 commit-msg hook installed
- All 3 `sdk-extract/<lang>` branches exist (re-runs extract idempotently)
- `cleanup/v526-sanitize` state reported (commits ahead/behind)
- V-205 violator commits audited (`63a20c1`, `ef649a1`)
- Per-SDK adjustment scripts present + executable

Exit 0 only when every check passes. Total wall-clock ≈ 30s.

### Manual path (legacy — kept for reference)

```bash
cd /Users/john/code/driftstack-api

# 1. Confirm clean working tree.
git status

# 2. Confirm extraction branches exist + reflect current main.
git branch --list 'sdk-extract/*'

# 3. Re-run extraction to pick up any changes since Wave 16.
scripts/extract-sdk-repos.sh

# 4. Confirm V-526 sanitization branch is reviewed + merged.
git log cleanup/v526-sanitize..main --oneline

# 5. Verify commit-msg hook installed.
ls -la .git/hooks/commit-msg

# 6. Confirm gh auth status.
gh auth status
```

If any pre-flight check fails, stop and fix before proceeding.

## Step-by-step

### Step 1 — extract LICENSE to per-SDK branches

Before pushing the SDK branches, copy `LICENSE` into each branch (none of
the 3 SDK packages currently has a per-package LICENSE file — V-525 plan
flagged this).

```bash
cd /Users/john/code/driftstack-api
for LANG in typescript python go; do
  git checkout "sdk-extract/${LANG}"
  cp /tmp/driftstack-api-LICENSE LICENSE  # Pre-stage by: cp LICENSE /tmp/driftstack-api-LICENSE on main first
  git add LICENSE
  git commit -m "Add LICENSE (MIT)"
done
git checkout main
```

Per the V-527 commit-msg hook regex, these commit messages must contain
zero banned strings — `"Add LICENSE (MIT)"` passes (verified by dry-run).

### Step 2 — apply per-SDK adjustments (V-525 design doc)

V-656 pre-wrote three adjustment scripts that apply every V-525 change
deterministically. Each runs on its own extraction branch:

```bash
git checkout sdk-extract/typescript && scripts/v528-adjust-typescript.sh
git checkout sdk-extract/python     && scripts/v528-adjust-python.sh
git checkout sdk-extract/go         && scripts/v528-adjust-go.sh
git checkout main
```

Each script is idempotent (re-running on an already-adjusted branch
no-ops) and refuses to run on the wrong branch.

What each script does:

- **TS** (`scripts/v528-adjust-typescript.sh`): adds LICENSE, rewrites
  `package.json` repository.url, drops the `@driftstack/api-types`
  dependency, copies api-types source into `src/_generated/`, rewrites
  every `from '@driftstack/api-types'` import to point at the local
  generated copy, adds `.github/workflows/ci.yml` + `publish.yml` (npm).
- **Py** (`scripts/v528-adjust-python.sh`): adds LICENSE, rewrites
  `pyproject.toml` `[project.urls]` Repository URL, adds CI workflow
  (Python 3.10/3.11/3.12 matrix; ruff + mypy + pytest), adds publish
  workflow (`python -m build` + `twine upload` on tag).
- **Go** (`scripts/v528-adjust-go.sh`): adds LICENSE, rewrites
  `go.mod` module path (`github.com/driftstackdev/driftstack-api/
packages/sdk-go` → `github.com/driftstackdev/driftstack-go-sdk`),
  rewrites any in-tree imports referencing the old path, adds CI
  workflow (Go 1.21/1.22 matrix; vet + build + test). No publish
  workflow needed — Go modules publish via tag push.

Original V-525 diffs remain the source of truth; the scripts implement
them.

### Step 3 — create 3 new GitHub repos + push branches

```bash
# TypeScript
gh repo create driftstackdev/driftstack-typescript-sdk --public \
  --description "Official TypeScript SDK for the Driftstack API" \
  --homepage "https://driftstack.io"
git push git@github.com:driftstackdev/driftstack-typescript-sdk.git \
  sdk-extract/typescript:main

# Python
gh repo create driftstackdev/driftstack-python-sdk --public \
  --description "Official Python SDK for the Driftstack API" \
  --homepage "https://driftstack.io"
git push git@github.com:driftstackdev/driftstack-python-sdk.git \
  sdk-extract/python:main

# Go
gh repo create driftstackdev/driftstack-go-sdk --public \
  --description "Official Go SDK for the Driftstack API" \
  --homepage "https://driftstack.io"
git push git@github.com:driftstackdev/driftstack-go-sdk.git \
  sdk-extract/go:main
```

After this step:

- 3 new public repos exist with the correct branch as `main`.
- Commits on the SDK history are visible publicly. (V-205 violators — see
  Step 5 dependency before this point.)
- npm / PyPI / Go publish workflows in `.github/workflows/publish.yml`
  are ready but not yet tagged; no public release happens automatically.

### Step 4 — flip driftstack-api private

```bash
gh repo edit driftstackdev/driftstack-api --visibility private \
  --accept-visibility-change-consequences
```

After this step:

- driftstack-api is private. 911 files stop being public.
- Existing forks (if any) remain public; GitHub keeps forks even after the
  upstream goes private. Audit forks via `gh api repos/driftstackdev/driftstack-api/forks`.
- npm packages currently configured against `repository.url =
driftstack-api` keep working (npm doesn't validate the URL), but anyone
  clicking the "GitHub" link from npmjs.com gets a 404. Step 2 already
  updated each SDK's manifest to point at its new SDK repo, so a fresh
  publish from the new repos resolves this.

### Step 5 — run V-205 historical scrub (NOW SAFE on private repo)

The two V-205 violator commits (`63a20c1`, `ef649a1`) remain in
driftstack-api's history. Now that the repo is private, the force-push
scrub is safe — no public-visible blast radius.

```bash
# Dry-run first — prints replacements that would apply.
scripts/v528-scrub-violators.sh

# After Step 4 confirmed (repo is private), run with --confirm.
scripts/v528-scrub-violators.sh --confirm
# (script prompts for "scrub-violators" confirmation token)

# After history rewrite. The script does NOT push, and filter-repo removes
# the origin remote by default — so re-add it FIRST or the push below fails
# with "'origin' does not appear to be a git repository".
git remote add origin git@github.com:driftstackdev/driftstack-api.git
git push --force origin main
git push --force origin --tags  # if any tags carried violator messages
```

The script applies plain-text message replacements via filter-repo:

- AI-tooling proper-noun strings (`Claude` / `Anthropic` / etc.) →
  process-handoff / LLM-vendor framing per the sub-processor
  disclosure context.
- Personal-name / founder tokens → team / driftstack-team framing per
  V-211.

Replacements are minimal and surgical — code trees, author identity,
and pre-violator commit SHAs all preserved.

A pre-scrub backup bundle is created automatically at
`/tmp/pre-v528-scrub-<timestamp>.bundle` (an out-of-repo snapshot — an
in-repo tag would get remapped by filter-repo's own rewrite + gc, so it
can't be used for recovery) so a careful operator can recover via
`git clone <bundle> <dir>` if the rewrite is wrong; delete the bundle
after verification.

⚠️ **Run Step 5 ONLY AFTER Step 3** — if SDK extraction branches were
pushed to public remotes already, those public remotes carry the un-scrubbed
history. Force-push of driftstack-api alone doesn't clean the SDK
public-remote histories. The SDK extraction branches `git subtree split`
produced are subset-histories; they may or may not contain the violators
depending on whether the violator commits touched any SDK directory.

The V-525 extraction script's V-205-violator warning helps audit this
before Step 3 pushes.

### Step 6 — redirect external links

Update any external references that pointed at driftstack-api source:

- npm package badges in marketing site (if any) — point at SDK repos.
- "View source" links in docs.driftstack.io → SDK repos for SDK source,
  no link for control-plane source (now private).
- Status page references — none expected.

### Step 7 — enable SDK CI + publish workflows

For each of the 3 new SDK repos:

```bash
gh secret set NPM_TOKEN --repo driftstackdev/driftstack-typescript-sdk
gh secret set PYPI_API_TOKEN --repo driftstackdev/driftstack-python-sdk
# Go publishes via tag push; no registry secret needed.
```

Tag the first release on each new repo:

```bash
# Per repo:
git checkout main
git tag v0.1.7  # TS — bump from 0.1.6
git tag v0.1.6  # Py — bump from 0.1.5
git tag v0.1.0  # Go — first tagged release
git push --tags
```

The `publish.yml` workflow picks up the tag push and publishes.

## Rollback (Step 4 onwards is hard-to-reverse)

- **Pre-Step-4 (private flip not yet run):** delete the 3 new repos
  (`gh repo delete`), delete extraction branches locally (`git branch
-D sdk-extract/<lang>`), uninstall commit-msg hook (`rm
.git/hooks/commit-msg`), `git revert` Waves 15-17. Fully reversible.

- **Post-Step-4 (private flip done) but pre-publish:** flip driftstack-api
  back to public (`gh repo edit --visibility public`). The flip back is
  technically supported; the audit trail in GitHub's repo-history page
  records both flips. Anyone who forked the public version retains their
  fork.

- **Post-publish (Step 7 tags pushed):** npm / PyPI versions are
  immutable on those registries (npm allows unpublishing within 24h /
  72h depending on age + downloads; PyPI does not allow unpublishing).
  Roll forward — publish a deprecation note + a higher version that
  reverses the change.

## Estimated wall-clock time

With V-656 pre-stage:

- Pre-flight: 30 sec (`scripts/v528-prestage.sh`)
- Step 1 (LICENSE staging): handled by pre-stage script (0 min)
- Step 2 (per-SDK adjustments): 1-2 min per SDK via adjustment scripts
- Step 3 (repo creation + push): 10 min
- Step 4 (private flip): 1 min
- Step 5 (V-205 scrub + force push): 5 min (script-driven)
- Step 6 (external link redirect): 15 min
- Step 7 (CI secrets + first publish): 30 min

Total: ~30-40 min for a careful run (down from 2-3 hours pre-V-656).

## Open questions for the team

1. Do we want NPM / PyPI publishes to be manual-tag or automated on every
   merge to `main` of each SDK repo?
2. Bundle `@driftstack/api-types` into `@driftstack/sdk` (V-525 plan
   option a) OR publish it as a separate npm package first (option b)?
   Plan recommended (a); team confirms.
3. Should the privatization announcement go anywhere external (a blog
   post, status-site banner, etc.) or is silent the right posture?
