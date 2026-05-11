#!/usr/bin/env bash
# V-656 — V-528 per-SDK adjustment: Python.
#
# Run ON the `sdk-extract/python` branch BEFORE pushing.
#
# Adjustments per V-525 plan section "Python SDK":
#   1. Copy LICENSE.
#   2. Edit pyproject.toml: project.urls.Repository → new repo URL.
#   3. Add .github/workflows/ci.yml.
#   4. Add .github/workflows/publish.yml.

set -euo pipefail

EXPECTED_BRANCH="sdk-extract/python"
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

# pyproject.toml edit — replace any existing Repository URL OR add it
# if missing. Same script handles both.
python3 - <<'PY'
import re
from pathlib import Path

p = Path("pyproject.toml")
text = p.read_text()

new_url = "https://github.com/driftstackdev/driftstack-python-sdk"

if 'Repository = "' in text:
    text = re.sub(
        r'Repository\s*=\s*"[^"]+"',
        f'Repository = "{new_url}"',
        text,
    )
elif "[project.urls]" in text:
    text = text.replace(
        "[project.urls]",
        f'[project.urls]\nRepository = "{new_url}"',
        1,
    )
else:
    text += f'\n[project.urls]\nRepository = "{new_url}"\n'

p.write_text(text)
print("OK: pyproject.toml Repository URL set to", new_url)
PY

mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - run: pip install -e .[dev]
      - run: ruff check .
      - run: mypy .
      - run: pytest
YAML

cat > .github/workflows/publish.yml <<'YAML'
name: publish

on:
  push:
    tags: ['v*.*.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install build twine
      - run: python -m build
      - name: Upload to PyPI
        env:
          TWINE_USERNAME: __token__
          TWINE_PASSWORD: ${{ secrets.PYPI_API_TOKEN }}
        run: python -m twine upload dist/*
YAML

git add LICENSE pyproject.toml .github/workflows/ci.yml .github/workflows/publish.yml
if git diff --cached --quiet; then
  printf 'NOTE: no changes — adjustments already applied.\n'
  exit 0
fi
git commit -m "V-528: Python SDK standalone adjustments"
printf 'OK: Python SDK adjustments applied + committed on %s\n' "$EXPECTED_BRANCH"
