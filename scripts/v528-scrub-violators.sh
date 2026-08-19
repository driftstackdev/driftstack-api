#!/usr/bin/env bash
# V-656 — V-528 Step 5: V-205 historical scrub via git-filter-repo.
#
# Run ONLY AFTER V-528 Steps 3 + 4 (repo flipped private). Rewrites
# history LOCALLY and prints the two force-push commands to run
# afterwards — it does NOT push. Public-visible blast radius is zero
# post-Step-4.
#
# V-817 — the line above read "Force-pushes rewritten history". The only
# --force here is git-filter-repo's own flag for running on a non-fresh
# clone. Reading it as "the script publishes the scrub" is the dangerous
# direction: the operator ticks the runbook step off and the violator
# commits stay live on the remote.
#
# Two violator commits remain in history:
#   - 63a20c1 "Handoff: Postmark approval requested + seamless-handoff bootstrap"
#     Body references the AI assistant by name in 5 places ("switching X
#     accounts", "Code's auto-memory", "/.X/projects/", "the new X session").
#     Replacement framing: process-handoff / handoff-tooling.
#   - ef649a1 "V-492 / V-493 / V-508: wave 9 — SDK coverage parity test + ..."
#     Body references the LLM vendor by name in the sub-processor-audit
#     context ("Anthropic-only", "matches DPA Annex 3 + the rest of the
#     marketing surface"). Replacement framing: LLM-vendor.
#
# Both commits ALSO carry "founder" tokens (V-211 anonymity violator).
# Replacement framing: team / driftstack-team.
#
# Pre-flight:
#   - git-filter-repo must be installed (`pip install git-filter-repo`
#     or `brew install git-filter-repo`).
#   - Repo MUST be private at this point (Step 4 done).
#   - Working tree clean, on main.
#
# This script is destructive — it rewrites history. The runbook guard
# below requires --confirm. Without it, the script dry-runs (prints the
# rewrites it would apply but doesn't touch history).

set -euo pipefail

CONFIRM=0
if [[ ${1:-} == "--confirm" ]]; then
  CONFIRM=1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

if ! command -v git-filter-repo >/dev/null 2>&1; then
  printf 'ERROR: git-filter-repo not installed.\n' >&2
  printf '  brew install git-filter-repo  # or pip install git-filter-repo\n' >&2
  exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
  printf 'ERROR: working tree dirty — clean before scrub.\n' >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  printf 'ERROR: must run on main, currently on %s\n' "$CURRENT_BRANCH" >&2
  exit 1
fi

# Confirm both violator SHAs exist before attempting the rewrite.
for SHA in 63a20c1 ef649a1; do
  if ! git rev-parse --verify --quiet "$SHA" >/dev/null; then
    printf 'INFO: %s not in current history (already scrubbed?). Skipping.\n' "$SHA"
  fi
done

CALLBACK_FILE=$(mktemp)
trap 'rm -f "$CALLBACK_FILE"' EXIT

# git-filter-repo commit-callback receives a `commit` object (Python).
# We do plain text replacements on commit.message; safer than regex on
# the wire format because filter-repo handles binary-vs-text framing.
cat > "$CALLBACK_FILE" <<'PY'
# V-528 Step 5 — V-205 + V-211 message scrub.
#
# Replacements applied to every commit message body. Comparable to the
# V-368 sister-repo pattern. Only the message text is rewritten; tree
# content, author identity, and commit SHAs upstream of the scrubbed
# commits are preserved (downstream SHAs naturally change).

import re

text = commit.message.decode("utf-8", errors="replace")

# V-205 — AI-tooling proper-noun strings.
ai_tool_replacements = [
    ("Claude Code's auto-memory", "the handoff-tooling auto-memory"),
    ("Claude Code", "the handoff tooling"),
    ("Claude accounts", "session accounts"),
    ("Claude session", "session"),
    ("the new Claude", "the new"),
    ("Claude", "the assistant"),
    ("Anthropic-only", "LLM-vendor-only"),
    ("Anthropic", "LLM-vendor"),
    ("/.claude/projects/", "/.handoff/projects/"),
    (".claude/projects", ".handoff/projects"),
]
for src, dst in ai_tool_replacements:
    text = text.replace(src, dst)

# V-211 — personal-name / founder anonymity.
anonymity_replacements = [
    ("Founder switching", "Team switching"),
    ("Founder ", "Team "),
    ("founder action", "team action"),
    ("founder ", "team "),
    ("Founder", "Team"),
    ("founder", "team"),
]
for src, dst in anonymity_replacements:
    text = text.replace(src, dst)

commit.message = text.encode("utf-8")
PY

if [[ $CONFIRM -eq 0 ]]; then
  printf '== DRY RUN — no history rewrite ==\n'
  printf '\nReplacements that WOULD apply across every commit message:\n\n'
  awk '/^# /{next} /^[ \t]*$/{next} /text\.replace/{print "  " $0}' "$CALLBACK_FILE"
  printf '\nTo execute, re-run with --confirm AND only after V-528 Step 4 done.\n'
  printf 'Nothing is pushed: the rewrite is LOCAL and the push commands are printed\n'
  printf 'for you to run by hand afterwards.\n'
  exit 0
fi

# Hard confirmation guard (extra prompt — destructive).
printf '\n⚠️  V-205 historical scrub REWRITES LOCAL HISTORY IRREVERSIBLY.\n'
printf '   It does NOT push. The remote is untouched until you push by hand.\n'
printf '   Repo must already be PRIVATE (V-528 Step 4 done).\n'
printf '   Type EXACTLY: scrub-violators\n'
read -r REPLY
if [[ "$REPLY" != "scrub-violators" ]]; then
  printf 'Aborted.\n' >&2
  exit 1
fi

# Back up pre-scrub history to an OUT-OF-REPO bundle, not an in-repo tag.
# git-filter-repo rewrites every ref it finds reachable in THIS repo
# (branches AND tags) and then runs its default gc, which prunes the
# original objects entirely — an in-repo tag would get remapped right
# along with main and end up pointing at the NEW rewritten commit, not
# the pre-scrub state it's meant to preserve.
BACKUP_BUNDLE="/tmp/pre-v528-scrub-$(date +%s).bundle"
git bundle create "$BACKUP_BUNDLE" --all
printf 'Out-of-repo backup bundle created: %s\n' "$BACKUP_BUNDLE"

git filter-repo --commit-callback "$(cat "$CALLBACK_FILE")" --force

printf '\nHistory rewritten. New HEAD: %s\n' "$(git rev-parse HEAD)"
printf 'To complete, run — note filter-repo REMOVED the origin remote, so re-add it first:\n'
printf '  git remote add origin <url>   # filter-repo drops it by default\n'
printf '  git push --force origin main\n'
printf '  git push --force origin --tags  # if any tags carried violator messages\n'
printf '\nPre-scrub backup remains at %s; recover via:\n' "$BACKUP_BUNDLE"
printf '  git clone %s <dir>\n' "$BACKUP_BUNDLE"
printf "  # or: git fetch %s 'refs/*:refs/*'\n" "$BACKUP_BUNDLE"
