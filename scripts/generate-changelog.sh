#!/usr/bin/env bash
# V-544 — generate a CHANGELOG.md fragment from commit messages between
# two refs.
#
# Usage:
#   scripts/generate-changelog.sh <from-ref> <to-ref> [--format md|plain]
#
# Example:
#   scripts/generate-changelog.sh v0.1.6 HEAD
#   scripts/generate-changelog.sh 5cf296c 8f5fa5e --format plain
#
# Output format (default `md`):
#   ## <to-ref-short> (YYYY-MM-DD)
#
#   - V-NNN — slice subject (commit SHA-short)
#   - ...
#
# Behaviour:
# - Walks `git log --reverse <from>..<to>` to get commits chronologically.
# - For each commit, extracts the subject line. If it matches the wave
#   commit pattern (e.g. `V-NNN / V-NNN: wave N — ...`), splits each
#   V-NNN out as its own bullet for readability. Otherwise, the whole
#   subject becomes one bullet.
# - Skips merge commits.
# - Strips V-NNN labels from non-wave subjects? No — keeps them; they're
#   internal artifacts that future cleanup (V-526.B / V-545) removes for
#   customer-facing publish.
#
# Exit codes:
#   0 — output written successfully.
#   1 — bad arguments or git invocation failure.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: $0 <from-ref> <to-ref> [--format md|plain]

  from-ref: git ref (tag, SHA, branch) marking the START of the range (exclusive).
  to-ref:   git ref marking the END of the range (inclusive).
  --format: 'md' (default; Markdown bullet list) or 'plain' (one line per slice).

Example:
  $0 v0.1.6 HEAD
  $0 5cf296c 8f5fa5e --format plain
EOF
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

FROM_REF="$1"
TO_REF="$2"
FORMAT="md"

if [[ $# -ge 3 ]]; then
  case "$3" in
    --format=md|--format=plain)
      FORMAT="${3#--format=}"
      ;;
    --format)
      FORMAT="${4:-}"
      if [[ -z "$FORMAT" ]]; then usage; fi
      ;;
    *)
      usage
      ;;
  esac
fi

if [[ "$FORMAT" != "md" && "$FORMAT" != "plain" ]]; then
  echo "error: --format must be 'md' or 'plain'" >&2
  exit 1
fi

# Verify both refs resolve.
if ! git rev-parse --verify --quiet "${FROM_REF}^{commit}" >/dev/null; then
  echo "error: from-ref '${FROM_REF}' does not resolve" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "${TO_REF}^{commit}" >/dev/null; then
  echo "error: to-ref '${TO_REF}' does not resolve" >&2
  exit 1
fi

TO_SHORT=$(git rev-parse --short "${TO_REF}")
TO_DATE=$(git show -s --format='%cs' "${TO_REF}")

# Markdown header.
if [[ "$FORMAT" == "md" ]]; then
  echo "## ${TO_SHORT} (${TO_DATE})"
  echo
fi

# Collect commits in chronological order, skipping merges.
# Format: SHA<TAB>subject
COMMITS=$(git log --reverse --no-merges --format='%h%x09%s' "${FROM_REF}..${TO_REF}")

if [[ -z "$COMMITS" ]]; then
  if [[ "$FORMAT" == "md" ]]; then
    echo "_No commits in range._"
  fi
  exit 0
fi

while IFS=$'\t' read -r SHA SUBJECT; do
  # If the subject matches the wave pattern (one or more V-NNN(.X)? tokens
  # separated by ' / ' followed by ': wave N — '), split each V-NNN out.
  if [[ "$SUBJECT" =~ ^(V-[0-9]+(\.[A-Z])?(\ /\ V-[0-9]+(\.[A-Z])?)*):\ wave\ [0-9]+\ —\ (.+)$ ]]; then
    VNNN_GROUP="${BASH_REMATCH[1]}"
    REST="${BASH_REMATCH[5]}"
    # Split VNNN_GROUP on ' / ' into individual VNNNs.
    IFS=' / ' read -ra VNNN_LIST <<<"$VNNN_GROUP"
    for vnnn in "${VNNN_LIST[@]}"; do
      if [[ -n "$vnnn" ]]; then
        if [[ "$FORMAT" == "md" ]]; then
          echo "- ${vnnn} — ${REST} (\`${SHA}\`)"
        else
          echo "${vnnn} ${REST} ${SHA}"
        fi
      fi
    done
  else
    # Non-wave commit — keep the full subject as one entry.
    if [[ "$FORMAT" == "md" ]]; then
      echo "- ${SUBJECT} (\`${SHA}\`)"
    else
      echo "${SUBJECT} ${SHA}"
    fi
  fi
done <<<"$COMMITS"
