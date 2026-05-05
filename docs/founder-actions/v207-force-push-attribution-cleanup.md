# V-207 / V-212 — founder force-push: strip AI-attribution + rewrite author identity

**Status:** SURFACED — awaiting founder execution. Force-push to
`main` is founder-action-only.

> **V-212 update**: scope expanded from V-207. Original V-207 stripped
> only the `Co-Authored-By: Claude` trailer. V-212 adds a second pass
> in the same filter-repo invocation to **rewrite the author identity**
> on every existing commit from the prior personal name + email
> (`Joël Theunissen <joeltheunissen89@gmail.com>`) to the locked
> Driftstack-branded identity (`Driftstack <dev@driftstack.dev>`).
> Single filter-repo run does both rewrites.

## What this does

In a single `git filter-repo` invocation:

1. **Strips** the trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` from every commit message that carries it. Drops empty trailing lines that result.
2. **Rewrites the author name** on every commit from any prior personal name to `Driftstack`.
3. **Rewrites the author email** on every commit from any prior personal email to `dev@driftstack.dev`.
4. **Rewrites the committer** identity on every commit (same name + email).

After the rewrite + force-push, every existing commit on `origin/main` shows `Driftstack <dev@driftstack.dev>` as both author and committer, with clean commit messages free of AI attribution.

## Repo state at time of writing (commit `3e90b30`, post-V-211)

- **Total commits in history**: 232 (229 at V-207 surface + V-205 + V-206 + V-207 + V-208 + V-209 + V-210 + V-211).
- **Commits with `Co-Authored-By: Claude` trailer**: 218 (V-205 onwards land clean; pre-V-205 commits affected).
- **Commits authored as `Joël Theunissen <joeltheunissen89@gmail.com>`**: 226 (V-210 onwards land as `Driftstack <dev@driftstack.dev>` per local git config). Sanity-check via `git log --all --format='%an <%ae>' | sort -u` after rewrite — should return only `Driftstack <dev@driftstack.dev>`.
- **`🤖 Generated with [Claude Code]` footer**: 0 commits (never added in this flow; nothing to strip).
- **Tags**: 7 (`packages/sdk-go/v0.1.0` through `v0.1.6`). filter-repo rewrites tag refs to point at the rewritten commits — tag NAMES preserved, target SHAs change.
- **Forks**: 0.
- **Open PRs**: 7 (all dependabot bumps — they auto-recreate on next dependabot scan after force-push, or close-and-reopen manually).
- **External pinned references**: none known. SDK packages are not yet on npm / PyPI / Go registries; Go SDK tags exist locally + on GitHub but no `go get` consumers downstream.

## Pre-flight checklist

1. **Confirm**: `git status` is clean (no uncommitted work). Run from `/Users/john/code/driftstack-api`. The V-209 about.astro working-tree draft is OK to keep — it doesn't get rewritten because it isn't yet committed.
2. **Confirm**: working `git filter-repo` install. Verify with `which git-filter-repo` (installed at `/opt/homebrew/bin/git-filter-repo`).
3. **Confirm**: agent has stopped pushing new commits (the rewrite is point-in-time; new pre-rewrite commits arriving during the rewrite would land with the old trailer/identity and require a second pass).
4. **Confirm**: nobody else has the repo cloned and is mid-PR. Force-push invalidates their local refs.
5. **Confirm**: founder is OK with the chosen new author identity `Driftstack <dev@driftstack.dev>`. Pick a different form by editing the `NEW_NAME` / `NEW_EMAIL` shell vars below before running.

## Execute

```bash
cd /Users/john/code/driftstack-api

# 1. Backup branch (in case anything goes wrong, you can reset to it)
git branch backup-pre-attribution-rewrite-$(date +%Y%m%d) main

# 2. Pick the new author identity. Adjust if a different form is preferred.
NEW_NAME="Driftstack"
NEW_EMAIL="dev@driftstack.dev"

# 3. Run filter-repo. Three callbacks rewrite message + name + email.
#    --force allows the rewrite on a non-fresh clone.
git filter-repo --force \
  --message-callback '
import re
msg = message.decode("utf-8")
# Strip the trailer + the blank line preceding it.
msg = re.sub(
    r"\n\nCo-Authored-By: Claude[^\n]*\n?",
    "\n",
    msg,
)
# Strip any double-trailing-newline that resulted.
msg = msg.rstrip() + "\n"
return msg.encode("utf-8")
' \
  --name-callback "return b'${NEW_NAME}'" \
  --email-callback "return b'${NEW_EMAIL}'"

# 4. Inspect a few rewritten commits to verify the trailer + identity.
git log -3 --format='%H | %an <%ae> | %s'
git log -1 --format=%B   # Confirm no Co-Authored-By trailer.

# 5. Re-add the origin remote (filter-repo strips it as a safety
#    measure to prevent accidental push to the wrong place).
git remote add origin https://github.com/driftstackdev/driftstack-api.git

# 6. Force-push the rewritten branch + the rewritten tags.
git push --force --tags origin main

# 7. Verify on github.com — recent commits should show no Co-Authored-By
#    trailer + author shown as "Driftstack" not the personal name.
```

## After force-push

- **Dependabot PRs** (currently 7 open): invalid because they were branched off the pre-rewrite SHAs. Easiest recovery: close all 7 in the GitHub UI; dependabot recreates them on its next scan (within ~24h, or trigger manually via Insights → Dependency Graph → Dependabot → "Check for updates").
- **Local clones** (other agent / founder workstation if any): each needs `git fetch origin && git reset --hard origin/main`. A plain `git pull` will fail or merge incorrectly because history diverged.
- **CI cache invalidation**: GitHub Actions cache keys are sometimes SHA-derived. After force-push, the next CI run may re-execute full instead of cache-hit. Acceptable; one-time cost.
- **GitHub PR review history**: comments on closed PRs reference pre-rewrite SHAs. They become broken links in those comments. Acceptable trade-off.
- **GitHub author display**: GitHub maps commit author email → user account in the UI. After rewrite, commits show `Driftstack` (no avatar) because `dev@driftstack.dev` doesn't map to a GitHub account. Optional: configure `dev@driftstack.dev` as a verified email on a Driftstack-org bot account if avatar attribution is desired.

## Cross-repo coordination

The same policy applies to:

- `github.com/driftstackdev/driftstack` (Agent 1's repo)
- `github.com/driftstackdev/webkit-driftstack` (Agent 1's repo)

Each needs an independent filter-repo run + force-push using the same script body. Founder coordinates Agent 1's repos separately; this runbook is for `driftstack-api` only.

## Rollback

If the rewrite goes wrong **before** force-push:

```bash
git reset --hard backup-pre-attribution-rewrite-<date>
```

If the rewrite went wrong **after** force-push (the worst case): the backup branch on the local clone has the original history; force-push that branch to main:

```bash
git push --force origin backup-pre-attribution-rewrite-<date>:main
```

Then drop the backup branch when satisfied.

## Sanity check commands (run after force-push)

```bash
# Trailer count — should return 0.
git log --all --format=%B | grep -c "Co-Authored-By: Claude" || echo "clean"

# Author identity — should return only "Driftstack <dev@driftstack.dev>".
git log --all --format='%an <%ae>' | sort -u

# Committer identity — should match.
git log --all --format='%cn <%ce>' | sort -u
```
