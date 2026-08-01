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

# Say so when git will not read what we just wrote.
#
# `core.hooksPath` overrides .git/hooks entirely. This repo sets it to
# `.husky/_` via the package.json `prepare` script, so every hook copied above
# is inert, and this script previously reported success anyway. That is how the
# V-205 attribution hook came to sit in .git/hooks unread while both CLAUDE.md
# and AGENTS.md described it as enforcing: a message carrying a tool co-author
# trailer committed cleanly.
#
# Not an error — husky's `.husky/<hook>` files are the ones that run, and they
# delegate back to the same canonical sources. But someone repairing enforcement
# by running this script needs to be told it is not the lever.
HOOKS_PATH=$(git -C "$REPO_ROOT" config --get core.hooksPath || true)
if [[ -n "$HOOKS_PATH" ]]; then
  echo ""
  echo "⚠ core.hooksPath is set to '$HOOKS_PATH' — git does NOT read $DST."
  echo "  The hooks that actually run are the ones under .husky/, which"
  echo "  delegate to $SRC. Verify with:"
  echo "    printf 'x\\n\\n<a banned trailer>\\n' > /tmp/m && bash '$HOOKS_PATH/commit-msg' /tmp/m"
fi
