#!/usr/bin/env bash
# V-525 — extract 3 SDK packages into standalone-repo-shaped branches.
#
# Uses `git subtree split` to rewrite each `packages/sdk-<lang>/` subtree
# into a branch where the SDK files sit at the branch root. Each branch
# can be pushed verbatim to a fresh remote and that remote becomes the
# new public SDK repo.
#
# Idempotent: re-running deletes existing extraction branches and re-splits.
# Safe: branches are local refs — never pushed by this script.
#
# Trigger from the Driftstack team tomorrow runs this script after the
# overnight wave window, then pushes each branch to its new GitHub repo
# manually (the push is the irreversible step; this script's output is
# fully reversible until then).
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Historical V-205 attribution-violator commits (V-368 force-push scrub
# is gated on V-528 privatization; until then, warn if these are still
# in the history reachable by the extracted SDK branches).
V205_VIOLATORS=(
  "63a20c1"
  "ef649a1"
)

SDKS=(
  "typescript:packages/sdk-typescript"
  "python:packages/sdk-python"
  "go:packages/sdk-go"
)

echo "============================================================"
echo "V-525 SDK extraction — generating 3 standalone-repo branches"
echo "============================================================"
echo ""

# Warn if violators are still reachable from HEAD (i.e., scrub hasn't
# run yet). They are intentionally left in tonight per the Track E
# sequencing — but the team should know before pushing to public.
for SHA in "${V205_VIOLATORS[@]}"; do
  if git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
    echo "⚠️  WARNING: V-205 violator commit ${SHA} still in history."
    echo "   This commit will be in the extracted branches' history if it"
    echo "   touched any SDK directory. V-368 force-push scrub is gated"
    echo "   on V-528 privatization — run scrub BEFORE pushing extracted"
    echo "   branches to public remotes."
    echo ""
  fi
done

for ENTRY in "${SDKS[@]}"; do
  LANG="${ENTRY%%:*}"
  PREFIX="${ENTRY##*:}"
  BRANCH="sdk-extract/${LANG}"

  echo "------------------------------------------------------------"
  echo "Extracting ${PREFIX} → ${BRANCH}"
  echo "------------------------------------------------------------"

  if [[ ! -d "$PREFIX" ]]; then
    echo "✗ source path missing: $PREFIX" >&2
    exit 1
  fi

  # Idempotent: delete existing branch.
  if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    echo "  (deleting existing ${BRANCH} to re-split)"
    git branch -D "${BRANCH}"
  fi

  # Subtree split. Quiet output unless errors.
  git subtree split --prefix="${PREFIX}" -b "${BRANCH}" >/dev/null

  SHA=$(git rev-parse "${BRANCH}")
  COUNT=$(git rev-list --count "${BRANCH}")
  echo "  branch: ${BRANCH}"
  echo "  HEAD:   ${SHA}"
  echo "  commits: ${COUNT}"
  echo ""

  # Warn if any V-205 violators touched this SDK's directory.
  for VIOLATOR in "${V205_VIOLATORS[@]}"; do
    if git cat-file -e "${VIOLATOR}^{commit}" 2>/dev/null; then
      if git log "${BRANCH}" --pretty=format:'%H' | grep -q "^$(git log -1 --format=%H ${VIOLATOR} -- ${PREFIX} 2>/dev/null || echo NONEXISTENT)$"; then
        echo "  ⚠️  V-205 violator ${VIOLATOR} touched ${PREFIX}; its rewritten counterpart is now in ${BRANCH}." >&2
      fi
    fi
  done
done

echo "============================================================"
echo "✓ Extraction complete. 3 local branches ready:"
echo "    sdk-extract/typescript"
echo "    sdk-extract/python"
echo "    sdk-extract/go"
echo ""
echo "Per V-525 plan: post-extraction LICENSE + manifest + CI changes"
echo "stage in a per-SDK setup commit on each branch BEFORE pushing to"
echo "the new GitHub repos. Pushing is the first irreversible step."
echo "============================================================"
