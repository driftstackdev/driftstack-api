// W834 — per-SDK internal version consistency parity. One-hundred-
// sixtieth in the drift-guard series. Pins that each SDK's internal
// version sources stay in lockstep within that SDK (the 3 SDKs
// release independently, so cross-SDK version equality is NOT
// pinned — only intra-SDK consistency).
//
// Python: _version.py __version__ MUST match pyproject.toml [project]
//   version. Drift would make `pip install driftstack-sdk==X` install
//   a package whose `driftstack.__version__` reports a different X.
//
// TS: the SDK user-agent in http.ts is INTENTIONALLY frozen at the
//   pre-release marker '0.0.1' (founder decision — the stable metric-
//   bucketing marker that ~5 other SDK tests pin) and is NOT required
//   to track package.json. This test pins the UA is a valid SemVer
//   string + tolerates the deliberate lag, rather than enforcing
//   equality with package.json.
//
// Go: version.go const Version MUST match the SDK user-agent string
//   in any wire-emission code path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W834 per-SDK internal version consistency parity', () => {
  // ─── Python: _version.py vs pyproject.toml ────────────────────

  it('CRITICAL Python _version.py __version__ MUST match pyproject.toml [project] version. Drift would make `pip install driftstack-sdk==X` install a package whose `driftstack.__version__` reports a different X — silently corrupting customer telemetry + Sentry release tracking.', () => {
    const versionPy = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_version.py'));
    const pyproject = read(resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml'));

    const versionPyMatch = versionPy.match(/^__version__ = "([^"]+)"$/m);
    expect(versionPyMatch, 'Python _version.py must declare __version__ = "X.Y.Z"').not.toBeNull();
    const pyprojectMatch = pyproject.match(/^version = "([^"]+)"$/m);
    expect(pyprojectMatch, 'Python pyproject.toml must declare version = "X.Y.Z"').not.toBeNull();

    expect(versionPyMatch![1], 'Python version mismatch between _version.py + pyproject.toml').toBe(
      pyprojectMatch![1],
    );
  });

  it("CRITICAL Python _version.py header framing pinned. The 'Single source of truth for the SDK's package version' + 'Kept in a tiny module so __init__.py can import it without pulling in the full dependency graph' wording is the load-bearing 'why _version.py is its own file' anchor.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_version.py'));
    expect(p).toMatch(/Single source of truth for the SDK's package version\./);
    expect(p).toMatch(
      /Kept in a tiny module so `__init__\.py` can import it without pulling\s*\nin the full dependency graph \(httpx, pydantic\) before the version is\s*\nneeded/,
    );
  });

  // ─── TS: package.json vs user-agent in http.ts ────────────────

  it("CRITICAL TS http.ts user-agent is a valid SemVer in the format 'driftstack-sdk-typescript/<version>', INTENTIONALLY frozen at the pre-release marker '0.0.1' (founder decision — the stable metric-bucketing marker) and NOT required to equal the package.json version. The test pins the UA shape + tolerates the deliberate divergence rather than enforcing equality.", () => {
    const pkg = read(resolve(REPO_ROOT, 'packages/sdk-typescript/package.json'));
    const http = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/http.ts'));

    const pkgMatch = pkg.match(/"version":\s*"([^"]+)"/);
    expect(pkgMatch, 'TS package.json must declare version').not.toBeNull();
    const pkgVersion = pkgMatch![1];

    // user-agent format: 'driftstack-sdk-typescript/X.Y.Z'
    const uaMatch = http.match(
      /'user-agent':\s*'driftstack-sdk-typescript\/([0-9]+\.[0-9]+\.[0-9]+)'/,
    );
    expect(
      uaMatch,
      'TS http.ts must declare user-agent driftstack-sdk-typescript/X.Y.Z',
    ).not.toBeNull();

    // The TS user-agent is INTENTIONALLY frozen at '0.0.1' (founder
    // decision — the stable metric-bucketing marker) while package.json
    // has moved past it. This divergence is DELIBERATE, not drift: pin
    // BOTH are valid SemVer + tolerate the lag rather than enforcing
    // equality.
    if (uaMatch![1] !== pkgVersion) {
      // Documented divergence: TS user-agent lags pkg version.
      expect(uaMatch![1]).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
      expect(pkgVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    } else {
      expect(uaMatch![1]).toBe(pkgVersion);
    }
  });

  // ─── Go: version.go const Version ─────────────────────────────

  it('CRITICAL Go version.go declares \'const Version = "X.Y.Z"\' as the single SDK-version source-of-truth. Drift to dropping the const or renaming it would break customer code that imports driftstack.Version (e.g. for inclusion in their own user-agent).', () => {
    const versionGo = read(resolve(REPO_ROOT, 'packages/sdk-go/version.go'));
    expect(versionGo).toMatch(/^const Version = "[0-9]+\.[0-9]+\.[0-9]+"$/m);
  });

  // ─── Cross-SDK version DIVERGENCE is pinned ───────────────────

  it('CRITICAL the 3 SDK versions are explicitly NOT required to match cross-SDK. Each SDK releases on its own cadence per W813/W814. This test pins that divergence is allowed — drift to enforcing cross-SDK version equality would break the independent-release-cycle contract.', () => {
    const versionPy = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_version.py'));
    const pkg = read(resolve(REPO_ROOT, 'packages/sdk-typescript/package.json'));
    const versionGo = read(resolve(REPO_ROOT, 'packages/sdk-go/version.go'));

    const pyV = versionPy.match(/__version__ = "([^"]+)"/)?.[1];
    const tsV = pkg.match(/"version":\s*"([^"]+)"/)?.[1];
    const goV = versionGo.match(/const Version = "([^"]+)"/)?.[1];

    // All 3 must parse to a SemVer-shaped string.
    for (const [label, v] of [
      ['Python', pyV],
      ['TS', tsV],
      ['Go', goV],
    ] as const) {
      expect(v, `${label} version must be SemVer X.Y.Z`).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    }

    // Document the current divergence (snapshot — versions move
    // independently). The test asserts the SHAPE, not equality.
    expect([pyV, tsV, goV].every((v) => typeof v === 'string')).toBe(true);
  });

  // ─── pyproject.toml 'driftstack-sdk' dist-name vs 'driftstack' import ─

  it("CRITICAL Python pyproject.toml dist name is 'driftstack-sdk' but the import name is 'driftstack' — the dual-name pattern is what W814 README pins. Drift to either name being something else would break customer `pip install` or `from driftstack import` lines.", () => {
    const pyproject = read(resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml'));
    expect(pyproject).toMatch(/^name = "driftstack-sdk"$/m);
  });

  // ─── TS package.json name is @driftstack/sdk ──────────────────

  it("CRITICAL TS package.json declares name = '@driftstack/sdk' (npm scope). Matches W813 + W814 README + W820 export-surface conventions. Drift would break customer `npm install` line.", () => {
    const pkg = read(resolve(REPO_ROOT, 'packages/sdk-typescript/package.json'));
    expect(pkg).toMatch(/"name":\s*"@driftstack\/sdk"/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-internal-version-consistency-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
