// W532.C — drift guard for packages/sdk-python/pyproject.toml.
// Python SDK manifest + ruff + mypy + pytest config. Drift here either
// changes the published package identity (would break `pip install
// driftstack-sdk`), drops a Python-version classifier (would silently
// drop support claims), or weakens the strict-mypy posture (would let
// type holes into the SDK consumers depend on).
//
//   • Build system: hatchling >= 1.21.
//   • Package: driftstack-sdk + 'Driftstack Python SDK — stealth iPhone
//     Safari automation. Import as `driftstack`.'.
//   • Python: requires-python: >=3.10.
//   • 5 keywords: driftstack + browser-automation + ios + safari + stealth.
//   • Python 3.10/11/12/13/14 classifiers (5-version compat claim).
//   • Typed classifier.
//   • Runtime deps: httpx + pydantic[email].
//   • Dev deps: pytest + pytest-asyncio + respx + ruff + mypy +
//     datamodel-code-generator[http].
//   • Hatch wheel: src/driftstack.
//   • Pytest: testpaths tests + asyncio_mode auto + warnings-as-errors
//     with pydantic+_generated allow-list.
//   • Ruff: line-length 100 + target py310 + select [E,F,I,B,UP,PT].
//   • Mypy: strict + per-file _generated/* ignore_errors.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W532.C packages/sdk-python/pyproject.toml content parity', () => {
  const body = read(LIB);

  it('Build-system + project identity framing pinned: \'requires = ["hatchling>=1.21"]\' + \'build-backend = "hatchling.build"\' + \'name = "driftstack-sdk"\' + \'description = "Driftstack Python SDK — stealth iPhone Safari automation. Import as `driftstack`."\' + \'requires-python = ">=3.10"\' + \'license = { text = "MIT" }\' — pinned so the hatchling build-backend + driftstack-sdk PyPI name + import-as-driftstack convention (PyPI name has -sdk suffix but import path is bare `driftstack`) + Python-3.10-minimum + MIT-license commitment survives', () => {
    expect(body).toMatch(/requires = \["hatchling>=1\.21"\]/);
    expect(body).toMatch(/build-backend = "hatchling\.build"/);
    expect(body).toMatch(/name = "driftstack-sdk"/);
    expect(body).toMatch(
      /description = "Driftstack Python SDK — stealth iPhone Safari automation\. Import as `driftstack`\."/,
    );
    expect(body).toMatch(/requires-python = ">=3\.10"/);
    expect(body).toMatch(/license = \{ text = "MIT" \}/);
  });

  it('5-keyword SEO + Python-version-classifier framing pinned: \'keywords = ["driftstack", "browser-automation", "ios", "safari", "stealth"]\' + classifiers including Python 3.10 + 3.11 + 3.12 + 3.13 + 3.14 + \'Typing :: Typed\' + \'Development Status :: 3 - Alpha\' — pinned so the 5-keyword + 5-Python-version-compat-claim + Typed classifier (signals py.typed marker present) + alpha-status commitment survives (drift to dropping a Python-version classifier without parallel drop from CI test matrix would create a support-claim/test-matrix divergence)', () => {
    expect(body).toMatch(
      /keywords = \["driftstack", "browser-automation", "ios", "safari", "stealth"\]/,
    );
    expect(body).toMatch(/"Development Status :: 3 - Alpha",/);
    expect(body).toMatch(/"Programming Language :: Python :: 3\.10",/);
    expect(body).toMatch(/"Programming Language :: Python :: 3\.11",/);
    expect(body).toMatch(/"Programming Language :: Python :: 3\.12",/);
    expect(body).toMatch(/"Programming Language :: Python :: 3\.13",/);
    expect(body).toMatch(/"Programming Language :: Python :: 3\.14",/);
    expect(body).toMatch(/"Typing :: Typed",/);
  });

  it('Runtime + dev deps framing pinned: \'dependencies = ["httpx>=0.27,<1.0", "pydantic[email]>=2.5,<3.0"]\' + dev deps pytest>=8.0 + pytest-asyncio>=0.23 + respx>=0.21 + ruff PINNED at ==0.15.13 (a formatter behind a --check gate cannot float: an unpinned range let a ruff release reformat files and redden CI with no Python having changed, 2026-08-23) + mypy>=1.10 + datamodel-code-generator[http]>=0.25 — pinned so the 2-runtime-dep (httpx HTTP client + pydantic[email] validation with email-extra for EmailStr) + 6-dev-dep commitment survives (drift to dropping httpx <1.0 upper bound would silently break on httpx 1.0 release; drift to dropping pydantic[email] extra would break EmailStr fields in models)', () => {
    expect(body).toMatch(/"httpx>=0\.27,<1\.0",/);
    expect(body).toMatch(/"pydantic\[email\]>=2\.5,<3\.0",/);
    expect(body).toMatch(/"pytest>=8\.0",/);
    expect(body).toMatch(/"pytest-asyncio>=0\.23",/);
    expect(body).toMatch(/"respx>=0\.21",/);
    expect(body).toMatch(/"ruff==0\.15\.13",/);
    expect(body).toMatch(/"mypy>=1\.10",/);
    expect(body).toMatch(/"datamodel-code-generator\[http\]>=0\.25",/);
  });

  it('Hatch wheel + project URLs framing pinned: \'packages = ["src/driftstack"]\' (wheel content: src/driftstack only) + sdist include 3-path /src/driftstack + /README.md + /pyproject.toml + Homepage:driftstack.dev + Repository:github.com/driftstackdev/driftstack-api + Issues:.../issues — pinned so the wheel-content + 3-sdist-allowlist + 3-URL commitment survives', () => {
    expect(body).toMatch(/packages = \["src\/driftstack"\]/);
    expect(body).toMatch(
      /include = \[\s*\n?\s*"\/src\/driftstack",\s*\n?\s*"\/README\.md",\s*\n?\s*"\/pyproject\.toml",\s*\n?\s*\]/,
    );
    expect(body).toMatch(/Homepage = "https:\/\/driftstack\.dev"/);
    expect(body).toMatch(/Repository = "https:\/\/github\.com\/driftstackdev\/driftstack-api"/);
    expect(body).toMatch(/Issues = "https:\/\/github\.com\/driftstackdev\/driftstack-api\/issues"/);
  });

  it('pytest config framing pinned: \'testpaths = ["tests"]\' + \'asyncio_mode = "auto"\' (every async def test auto-marked) + \'filterwarnings = ["error", "default::DeprecationWarning:pydantic", "default::DeprecationWarning:driftstack._generated"]\' — pinned so the warnings-as-errors-default + pydantic+_generated allow-list rationale (\'Pydantic emits deprecation warnings for some patterns we generate via datamodel-code-generator; tolerate them so tests don\'t fail on codegen output we don\'t fully control.\') commitment survives', () => {
    expect(body).toMatch(/testpaths = \["tests"\]/);
    expect(body).toMatch(/asyncio_mode = "auto"/);
    expect(body).toMatch(
      /filterwarnings = \[\s*\n?\s*"error",\s*\n?\s*# Pydantic emits deprecation warnings for some patterns we generate\s*\n?\s*# via datamodel-code-generator; tolerate them so tests don't fail on\s*\n?\s*# codegen output we don't fully control\.\s*\n?\s*"default::DeprecationWarning:pydantic",\s*\n?\s*"default::DeprecationWarning:driftstack\._generated",\s*\n?\s*\]/,
    );
  });

  it('Ruff + mypy strict + codegen-override framing pinned: ruff \'line-length = 100\' + \'target-version = "py310"\' + \'extend-exclude = ["src/driftstack/_generated"]\' + \'select = ["E", "F", "I", "B", "UP", "PT"]\' + per-file-ignores tests:[B,PT011] + mypy \'python_version = "3.10"\' + \'strict = true\' + override module driftstack._generated.* ignore_errors:true with codegen-not-strict-clean rationale — pinned so the 6-ruff-rule-set + strict-mypy-on-hand-written + permissive-mypy-on-_generated commitment survives (drift to mypy strict on _generated/ would fail CI on every codegen run; drift to dropping ruff codegen exclude would lint generated files)', () => {
    expect(body).toMatch(/line-length = 100/);
    expect(body).toMatch(/target-version = "py310"/);
    expect(body).toMatch(/extend-exclude = \["src\/driftstack\/_generated"\]/);
    expect(body).toMatch(/select = \["E", "F", "I", "B", "UP", "PT"\]/);
    expect(body).toMatch(/"tests\/\*\*" = \["B", "PT011"\]/);
    expect(body).toMatch(/\[tool\.mypy\]/);
    expect(body).toMatch(/python_version = "3\.10"/);
    expect(body).toMatch(/strict = true/);
    expect(body).toMatch(/module = "driftstack\._generated\.\*"/);
    expect(body).toMatch(
      /# Codegen output isn't always strict-clean — `conint\(\.\.\.\)` \/\s*\n?\s*# `constr\(\.\.\.\)` factory calls aren't valid type annotations to mypy\s*\n?\s*# even though Pydantic v2 accepts them at runtime\. Skip type-checking\s*\n?\s*# for the codegen module entirely; the wrapper layer that customers\s*\n?\s*# actually touch stays strict, and the generated models are runtime-\s*\n?\s*# tested via tests\/test_generated_models\.py\./,
    );
    expect(body).toMatch(/ignore_errors = true/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
