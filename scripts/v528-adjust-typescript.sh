#!/usr/bin/env bash
# V-656 — V-528 per-SDK adjustment: TypeScript.
#
# Run ON the `sdk-extract/typescript` branch BEFORE pushing to the new
# public repo. Idempotent: re-running produces the same tree.
#
# Adjustments per V-525 plan section "TypeScript SDK":
#   1. Copy LICENSE from /tmp/driftstack-api-LICENSE → ./LICENSE
#   2. Edit package.json:
#        - repository.url → driftstack-typescript-sdk
#        - drop repository.directory
#        - inline @driftstack/api-types (option (a) — bundle types into dist)
#   3. Add .github/workflows/ci.yml
#   4. Add .github/workflows/publish.yml
#
# Notes:
#   - This script MUST run on the extraction branch. It refuses to run
#     on main to avoid corrupting the parent repo.
#   - The api-types bundling step copies packages/api-types/src content
#     into a local src/_generated/ directory + rewrites the SDK's import
#     paths to point at the local copy. This avoids requiring api-types
#     to publish as a separate npm package.

set -euo pipefail

EXPECTED_BRANCH="sdk-extract/typescript"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  printf 'ERROR: must run on %s; currently on %s\n' "$EXPECTED_BRANCH" "$CURRENT_BRANCH" >&2
  exit 1
fi

# 1. LICENSE.
if [[ ! -f /tmp/driftstack-api-LICENSE ]]; then
  printf 'ERROR: /tmp/driftstack-api-LICENSE missing. Run scripts/v528-prestage.sh first.\n' >&2
  exit 1
fi
cp /tmp/driftstack-api-LICENSE LICENSE

# 2. package.json edits via Node one-liner (avoids fragile sed).
node --input-type=module -e "$(cat <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.repository = {
  type: 'git',
  url: 'git+https://github.com/driftstackdev/driftstack-typescript-sdk.git',
};
// Drop @driftstack/api-types — bundled via the build step instead.
if (pkg.dependencies && pkg.dependencies['@driftstack/api-types']) {
  delete pkg.dependencies['@driftstack/api-types'];
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
JS
)"

# Bundle api-types: copy the api-types source tree into src/_generated/
# so the SDK is self-contained. The extraction branch lost the
# packages/api-types/ tree because git-subtree split is per-prefix; we
# need to re-introduce the types from the main branch.
TMP_TYPES_DIR=$(mktemp -d)
git --git-dir=../../.git --work-tree=. show "main:packages/api-types/src" >/dev/null 2>&1 || true
# Use a worktree of main to copy api-types content into the extraction branch.
WORKTREE_DIR=$(mktemp -d)
git worktree add --quiet --detach "$WORKTREE_DIR" main
mkdir -p src/_generated
rsync -a --delete "$WORKTREE_DIR/packages/api-types/src/" src/_generated/
git worktree remove --force "$WORKTREE_DIR"

# Rewrite SDK imports: @driftstack/api-types → ./_generated/*
# (relies on src/ tree using `import { X } from '@driftstack/api-types'`)
find src -type f -name '*.ts' -not -path 'src/_generated/*' \
  -exec sed -i.bak -E "s|from '@driftstack/api-types'|from './_generated/index.js'|g" {} \;
find src -name '*.bak' -delete

# 3. CI workflow.
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test --if-present
YAML

# 4. Publish workflow.
cat > .github/workflows/publish.yml <<'YAML'
name: publish

on:
  push:
    tags: ['v*.*.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
YAML

# Stage + commit.
git add LICENSE package.json src/_generated .github/workflows/ci.yml .github/workflows/publish.yml
if find src -type f -name '*.ts' -newer .github/workflows/ci.yml 2>/dev/null | grep -q .; then
  git add src
fi
# Some edits may already be staged from previous runs; allow empty staged.
if git diff --cached --quiet; then
  printf 'NOTE: no changes — adjustments already applied.\n'
  exit 0
fi
git commit -m "V-528: TypeScript SDK standalone adjustments"
printf 'OK: TypeScript SDK adjustments applied + committed on %s\n' "$EXPECTED_BRANCH"
