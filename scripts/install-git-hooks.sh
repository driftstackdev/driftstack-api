#!/usr/bin/env bash
# V-527 — install git hooks from canonical source.
#
# .git/hooks/ is per-clone (not tracked). This script copies the
# canonical, version-controlled hooks from scripts/git-hooks/ into
# the active clone's .git/hooks/ directory and marks them executable.
#
# Run once after cloning, and again whenever scripts/git-hooks/
# changes. Idempotent: overwrites existing hooks of the same name.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC="$REPO_ROOT/scripts/git-hooks"
DST="$REPO_ROOT/.git/hooks"

if [[ ! -d "$SRC" ]]; then
  echo "✗ source dir not found: $SRC" >&2
  exit 1
fi

if [[ ! -d "$DST" ]]; then
  echo "✗ destination dir not found: $DST (run from a git clone)" >&2
  exit 1
fi

shopt -s nullglob
INSTALLED=0
for HOOK in "$SRC"/*; do
  NAME=$(basename "$HOOK")
  cp "$HOOK" "$DST/$NAME"
  chmod +x "$DST/$NAME"
  echo "✓ installed: $NAME"
  INSTALLED=$((INSTALLED + 1))
done

if [[ $INSTALLED -eq 0 ]]; then
  echo "(no hooks found in $SRC)"
else
  echo ""
  echo "✓ $INSTALLED hook(s) installed into $DST"
fi
