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

```bash
cd /Users/john/code/driftstack-api

# 1. Confirm clean working tree.
git status
# Expected: nothing to commit, working tree clean (on `main`).

# 2. Confirm extraction branches exist + reflect current main.
git branch --list 'sdk-extract/*'
# Expected: 3 branches: sdk-extract/typescript, sdk-extract/python, sdk-extract/go

# 3. Re-run extraction to pick up any changes since Wave 16.
scripts/extract-sdk-repos.sh
# Verifies branches reflect HEAD of main; idempotent.

# 4. Confirm V-526 sanitization branch is reviewed + merged (or merged
#    on its own pre-flip).
git log cleanup/v526-sanitize..main --oneline
# Expected: either empty (branch merged) or short list of accepted changes.

# 5. Verify commit-msg hook installed.
ls -la .git/hooks/commit-msg
# Expected: present + executable.

# 6. Confirm gh auth status.
gh auth status
# Expected: authenticated as a user with admin rights on driftstackdev org.
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

On each `sdk-extract/<lang>` branch, apply the per-SDK adjustments listed
in `docs/internal/v525-sdk-extraction-plan.md`:

- **TS:** update `package.json` repository.url + bundle api-types.
- **Py:** update `pyproject.toml` URLs.
- **Go:** update `go.mod` module path (`github.com/driftstackdev/driftstack-go-sdk`).
- **All:** add `.github/workflows/ci.yml` and `.github/workflows/publish.yml`.

Detailed diffs in V-525 plan; can be applied manually or via a follow-up
script.

### Step 3 — create 3 new GitHub repos + push branches

```bash
# TypeScript
gh repo create driftstackdev/driftstack-typescript-sdk --public \
  --description "Official TypeScript SDK for the Driftstack API" \
  --homepage "https://driftstack.dev"
git push git@github.com:driftstackdev/driftstack-typescript-sdk.git \
  sdk-extract/typescript:main

# Python
gh repo create driftstackdev/driftstack-python-sdk --public \
  --description "Official Python SDK for the Driftstack API" \
  --homepage "https://driftstack.dev"
git push git@github.com:driftstackdev/driftstack-python-sdk.git \
  sdk-extract/python:main

# Go
gh repo create driftstackdev/driftstack-go-sdk --public \
  --description "Official Go SDK for the Driftstack API" \
  --homepage "https://driftstack.dev"
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
git filter-repo --commit-callback '
  if commit.message.find(b"Claude") != -1 or commit.message.find(b"founder") != -1:
    # Apply targeted message rewrites; keep code unchanged
    commit.message = ...rewritten message...
' --force
git push --force origin main
```

(Specific filter-repo invocation TBD — exact rewrites per the violators'
message content. The V-368 pattern from sister-repo cleanups is the
reference; copy the approach.)

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
- "View source" links in docs.driftstack.dev → SDK repos for SDK source,
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

- Pre-flight: 5 min
- Step 1 (LICENSE per branch): 5 min
- Step 2 (per-SDK adjustments): 30-60 min depending on api-types bundling
  decision
- Step 3 (repo creation + push): 10 min
- Step 4 (private flip): 1 min
- Step 5 (V-205 scrub + force push): 15-30 min
- Step 6 (external link redirect): 15 min
- Step 7 (CI secrets + first publish): 30 min

Total: ~2-3 hours for a careful run.

## Open questions for the team

1. Do we want NPM / PyPI publishes to be manual-tag or automated on every
   merge to `main` of each SDK repo?
2. Bundle `@driftstack/api-types` into `@driftstack/sdk` (V-525 plan
   option a) OR publish it as a separate npm package first (option b)?
   Plan recommended (a); team confirms.
3. Should the privatization announcement go anywhere external (a blog
   post, status-site banner, etc.) or is silent the right posture?
