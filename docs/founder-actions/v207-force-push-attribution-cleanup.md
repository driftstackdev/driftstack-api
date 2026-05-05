# V-207 — founder force-push: strip AI-attribution trailer from history

**Status:** SURFACED — awaiting founder execution. Agent 2 will not run
this; force-push to `main` is founder-action-only.

## What this does

Rewrites every commit message in this repo's history to strip the
trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
Drops empty trailing lines that result from the strip.

After the rewrite + force-push, every existing commit on
`origin/main` no longer carries AI-tooling attribution. Pairs with
V-205 (no new commits attribute to AI tooling) and V-206 (cleaned
the live customer-facing surfaces).

## Repo state at time of writing (commit `42a78a0`)

- **Total commits in history**: 229
- **Commits affected by the rewrite**: 218 (carry the
  `Co-Authored-By: Claude` trailer)
- **`🤖 Generated with [Claude Code]` footer**: 0 commits (never
  added in this flow; nothing to strip).
- **Tags**: 7 (`packages/sdk-go/v0.1.0` through `v0.1.6`). filter-repo
  rewrites tag refs to point at the rewritten commits — tag NAMES
  preserved, target SHAs change.
- **Forks**: 0.
- **Open PRs**: 7 (all dependabot bumps — they auto-recreate on next
  dependabot scan after force-push, or close-and-reopen manually).
- **External pinned references**: none known. SDK packages are not
  yet on npm / PyPI / Go registries; Go SDK tags exist locally + on
  GitHub but no `go get` consumers downstream.

## Pre-flight checklist

1. **Confirm**: `git status` is clean (no uncommitted work). Run from
   `/Users/john/code/driftstack-api`.
2. **Confirm**: working `git filter-repo` install. Verify with
   `which git-filter-repo` (already installed at `/opt/homebrew/bin/git-filter-repo`).
3. **Confirm**: agent has stopped pushing new commits (the rewrite
   is point-in-time; new pre-rewrite commits arriving during the
   rewrite would land with the old trailer and require a second
   pass).
4. **Confirm**: nobody else has the repo cloned and is mid-PR. Force-
   push invalidates their local refs.

## Execute

```bash
cd /Users/john/code/driftstack-api

# 1. Backup branch (in case anything goes wrong, you can reset to it)
git branch backup-pre-attribution-rewrite-$(date +%Y%m%d) main

# 2. Run filter-repo. The --message-callback rewrites every commit
#    message: strips the Co-Authored-By trailer + any trailing blank
#    line that results.
git filter-repo --force --message-callback '
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
'

# 3. Inspect a few rewritten commits to verify the trailer is gone.
git log -3 --format=%B

# 4. Re-add the origin remote (filter-repo strips it as a safety
#    measure to prevent accidental push to the wrong place).
git remote add origin https://github.com/driftstackdev/driftstack-api.git

# 5. Force-push the rewritten branch + the rewritten tags.
git push --force --tags origin main

# 6. Verify on github.com — recent commits should show no Co-Authored-By
#    trailer.
```

## After force-push

- **Dependabot PRs** (currently 7 open): invalid because they were
  branched off the pre-rewrite SHAs. Easiest recovery: close all 7
  in the GitHub UI; dependabot recreates them on its next scan
  (within ~24h, or trigger manually via Insights → Dependency Graph
  → Dependabot → "Check for updates").
- **Local clones** (other agent / founder workstation if any): each
  needs `git fetch origin && git reset --hard origin/main`. A plain
  `git pull` will fail or merge incorrectly because history diverged.
- **CI cache invalidation**: GitHub Actions cache keys are sometimes
  SHA-derived. After force-push, the next CI run may re-execute
  full instead of cache-hit. Acceptable; one-time cost.
- **GitHub PR review history**: comments on closed PRs reference
  pre-rewrite SHAs. They become broken links in those comments.
  Acceptable trade-off.

## Cross-repo coordination

The same policy applies to:

- `github.com/driftstackdev/driftstack` (Agent 1's repo)
- `github.com/driftstackdev/webkit-driftstack` (Agent 1's repo)

Each needs an independent filter-repo run + force-push using the same
script body. Founder coordinates Agent 1's repos separately; Agent 2
only runs against driftstack-api.

## Rollback

If the rewrite goes wrong before force-push:

```bash
git reset --hard backup-pre-attribution-rewrite-<date>
```

If the rewrite went wrong AFTER force-push (the worst case): the
backup branch on the local clone has the original history; force-
push that branch to main:

```bash
git push --force origin backup-pre-attribution-rewrite-<date>:main
```

Then drop the backup branch when satisfied.

## Sanity check command (run after force-push)

```bash
# Should return zero hits.
git log --all --format=%B | grep -c "Co-Authored-By: Claude" || echo "clean"
```
