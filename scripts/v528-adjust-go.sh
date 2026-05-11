#!/usr/bin/env bash
# V-656 — V-528 per-SDK adjustment: Go.
#
# Run ON the `sdk-extract/go` branch BEFORE pushing.
#
# Adjustments per V-525 plan section "Go SDK":
#   1. Copy LICENSE.
#   2. Edit go.mod: module path → github.com/driftstackdev/driftstack-go-sdk.
#   3. Rewrite any in-tree import that referenced the old module path.
#   4. Add .github/workflows/ci.yml.
#   (No publish workflow needed — Go modules publish via tag push +
#    proxy.golang.org auto-indexes.)

set -euo pipefail

EXPECTED_BRANCH="sdk-extract/go"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  printf 'ERROR: must run on %s; currently on %s\n' "$EXPECTED_BRANCH" "$CURRENT_BRANCH" >&2
  exit 1
fi

if [[ ! -f /tmp/driftstack-api-LICENSE ]]; then
  printf 'ERROR: /tmp/driftstack-api-LICENSE missing. Run scripts/v528-prestage.sh first.\n' >&2
  exit 1
fi
cp /tmp/driftstack-api-LICENSE LICENSE

OLD_MODULE="github.com/driftstackdev/driftstack-api/packages/sdk-go"
NEW_MODULE="github.com/driftstackdev/driftstack-go-sdk"

# Update go.mod module declaration.
if [[ -f go.mod ]]; then
  sed -i.bak -E "s|^module ${OLD_MODULE}|module ${NEW_MODULE}|" go.mod
  rm -f go.mod.bak
else
  printf 'ERROR: go.mod missing on extraction branch.\n' >&2
  exit 1
fi

# Rewrite in-tree imports referencing the old module path. V-525 plan
# notes none currently exist, but defensive — covers future SDK
# expansion that adds internal sub-packages.
find . -type f -name '*.go' \
  -exec sed -i.bak -E "s|\"${OLD_MODULE}|\"${NEW_MODULE}|g" {} \;
find . -name '*.go.bak' -delete

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
    strategy:
      matrix:
        go-version: ['1.21', '1.22']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go-version }}
      - run: go vet ./...
      - run: go build ./...
      - run: go test ./...
YAML

git add LICENSE go.mod .github/workflows/ci.yml
# Stage any .go file the import-rewrite touched.
if find . -type f -name '*.go' -newer go.mod 2>/dev/null | grep -q .; then
  git add '*.go'
fi
if git diff --cached --quiet; then
  printf 'NOTE: no changes — adjustments already applied.\n'
  exit 0
fi
git commit -m "V-528: Go SDK standalone adjustments"
printf 'OK: Go SDK adjustments applied + committed on %s\n' "$EXPECTED_BRANCH"
