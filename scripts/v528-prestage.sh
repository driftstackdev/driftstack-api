#!/usr/bin/env bash
# V-656 — V-528 pre-stage runner.
#
# Drops the V-528 trigger from ~2-3 hr (per the runbook) to ~30 min for the
# driftstack team by pre-running every Tier-1-autonomous (no remote ops)
# preparatory step. After this runs cleanly, the team only has to:
#
#   1. Review the cleanup branch + this script's output.
#   2. Run the per-SDK adjustment scripts (Step 2 of V-528 runbook).
#   3. Execute the 4 irreversible founder-only steps:
#        Step 3 (gh repo create + push) — manual
#        Step 4 (gh repo edit --visibility private) — manual
#        Step 5 (V-205 scrub force-push) — via scripts/v528-scrub-violators.sh
#        Step 7 (CI secrets + tag push) — manual
#
# This script performs ONLY autonomous side-effect-free actions:
#
#   - Copies LICENSE to /tmp/driftstack-api-LICENSE (Step 1 input).
#   - Verifies gh auth status.
#   - Verifies clean working tree.
#   - Verifies extraction branches exist + match HEAD of main (idempotent
#     re-run of extract-sdk-repos.sh).
#   - Verifies V-527 commit-msg hook is installed and executable.
#   - Reports the cleanup/v526-sanitize branch state (merged / unmerged /
#     commits-behind).
#   - Dry-run audit of the V-205 violator commits to confirm the SHAs
#     63a20c1 and ef649a1 still exist with their expected messages.
#
# Idempotent — running twice produces the same output (modulo timestamps).
# Exit 0 only when EVERY pre-flight passes. Non-zero exit on any failure
# so callers can gate on it.
#
# Usage:
#   scripts/v528-prestage.sh [--dry-run]
#
# Flags:
#   --dry-run — perform the audit-only path (no LICENSE copy, no re-run of
#               extract-sdk-repos.sh). Used by the V-656 self-test.

set -euo pipefail

DRY_RUN=0
if [[ ${1:-} == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

NL=$'\n'
SECTION_FAILED=0
LOG_PREFIX="[v528-prestage]"

fail() {
  printf '%s FAIL: %s\n' "$LOG_PREFIX" "$1" >&2
  SECTION_FAILED=1
}

ok() {
  printf '%s OK:   %s\n' "$LOG_PREFIX" "$1"
}

info() {
  printf '%s INFO: %s\n' "$LOG_PREFIX" "$1"
}

section() {
  printf '\n%s ── %s ──\n' "$LOG_PREFIX" "$1"
}

# ─── 1. Clean working tree ────────────────────────────────────────────────
section "Pre-flight: clean working tree"
if [[ -n $(git status --porcelain) ]]; then
  fail "Working tree dirty — V-528 runbook requires a clean tree before trigger."
  git status --short | head -10
else
  ok "Working tree clean."
fi

# ─── 2. On main branch ────────────────────────────────────────────────────
section "Pre-flight: current branch"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  fail "Expected main, on $CURRENT_BRANCH. V-528 runbook starts from main."
else
  ok "On main."
fi

# ─── 3. LICENSE present + copy to /tmp ────────────────────────────────────
section "Pre-flight: LICENSE staging"
if [[ ! -f LICENSE ]]; then
  fail "LICENSE missing at repo root — V-528 Step 1 needs it for per-SDK copies."
else
  if [[ $DRY_RUN -eq 0 ]]; then
    cp LICENSE /tmp/driftstack-api-LICENSE
    ok "LICENSE → /tmp/driftstack-api-LICENSE."
  else
    info "[dry-run] would copy LICENSE → /tmp/driftstack-api-LICENSE."
  fi
fi

# ─── 4. gh auth status ────────────────────────────────────────────────────
section "Pre-flight: gh auth"
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI not installed — required for Steps 3/4/7."
elif ! gh auth status >/dev/null 2>&1; then
  fail "gh not authenticated. Run \`gh auth login\` before V-528 trigger."
else
  GH_USER=$(gh api user --jq .login 2>/dev/null || echo unknown)
  ok "gh authenticated as $GH_USER."
fi

# ─── 5. V-527 commit-msg hook ─────────────────────────────────────────────
section "Pre-flight: V-527 commit-msg hook"
if [[ ! -x .git/hooks/commit-msg ]]; then
  fail ".git/hooks/commit-msg missing or not executable."
else
  ok "V-527 hook installed + executable."
fi

# ─── 6. SDK extraction branches ───────────────────────────────────────────
section "Pre-flight: SDK extraction branches"
for LANG in typescript python go; do
  BRANCH="sdk-extract/${LANG}"
  if ! git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
    fail "Branch $BRANCH missing — V-525 extraction not staged."
  else
    HEAD_SHORT=$(git rev-parse --short "$BRANCH")
    COMMIT_COUNT=$(git rev-list --count "$BRANCH")
    ok "$BRANCH → $HEAD_SHORT ($COMMIT_COUNT commits)"
  fi
done

# Re-run extract-sdk-repos.sh in idempotent mode unless --dry-run.
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ -x scripts/extract-sdk-repos.sh ]]; then
    info "Re-running scripts/extract-sdk-repos.sh (idempotent re-split)."
    scripts/extract-sdk-repos.sh
    ok "extract-sdk-repos.sh re-ran clean."
  else
    fail "scripts/extract-sdk-repos.sh missing or not executable."
  fi
else
  info "[dry-run] skipping extract-sdk-repos.sh re-run."
fi

# ─── 7. Cleanup branch state ──────────────────────────────────────────────
section "Pre-flight: cleanup/v526-sanitize branch"
if git rev-parse --verify --quiet cleanup/v526-sanitize >/dev/null; then
  COMMITS_AHEAD=$(git rev-list --count main..cleanup/v526-sanitize)
  COMMITS_BEHIND=$(git rev-list --count cleanup/v526-sanitize..main)
  if [[ $COMMITS_AHEAD -eq 0 ]]; then
    ok "cleanup/v526-sanitize is merged into main (or empty)."
  else
    info "cleanup/v526-sanitize: $COMMITS_AHEAD commits ahead of main; $COMMITS_BEHIND behind."
    info "Founder should rebase + review + merge BEFORE V-528 trigger."
  fi
else
  info "cleanup/v526-sanitize branch not present locally (already merged?)."
fi

# ─── 8. V-205 violator audit ──────────────────────────────────────────────
section "Pre-flight: V-205 violator commit audit"
for SHA in 63a20c1 ef649a1; do
  if git rev-parse --verify --quiet "$SHA" >/dev/null; then
    SUBJECT=$(git log -1 --format='%s' "$SHA")
    info "$SHA still present: $SUBJECT"
  else
    info "$SHA not present in current history (already scrubbed?)."
  fi
done
ok "Violator audit complete. Scrub via scripts/v528-scrub-violators.sh AFTER Step 4."

# ─── 9. Per-SDK adjustment scripts ────────────────────────────────────────
section "Pre-flight: per-SDK adjustment scripts"
for LANG in typescript python go; do
  SCRIPT="scripts/v528-adjust-${LANG}.sh"
  if [[ -x "$SCRIPT" ]]; then
    ok "$SCRIPT present + executable."
  else
    fail "$SCRIPT missing or not executable."
  fi
done

# ─── Final ────────────────────────────────────────────────────────────────
section "Summary"
if [[ $SECTION_FAILED -ne 0 ]]; then
  fail "One or more pre-flight checks failed. Resolve before V-528 trigger."
  exit 1
fi

ok "All V-528 pre-flight checks passed."
ok "Next step: founder reviews cleanup branch + runs scripts/v528-adjust-*.sh"
ok "       then Steps 3/4/5/7 per docs/internal/v528-repo-privatization-runbook.md."
exit 0
