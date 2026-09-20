// The version each SDK is about to publish, read from the package metadata.
//
// Several guards assert that a customer-facing page names a version — the pin
// a README recommends, the minimum an example needs. Spelling the number in the
// guard as a literal makes the guard agree with itself and with nothing else:
// on the day of a release the page and the package move and the guard stays
// green against the number both of them just left behind. (That is the shape
// the release of 2026-09-20 found: `sdk/versioning.md` and
// `architecture/sdk-versioning.md` both recommended `^0.1.5` months after npm
// had 0.1.6, and two content-parity guards required exactly that string.)
//
// So the number is DERIVED from the thing that decides it, once, here:
//
//   TypeScript  packages/sdk-typescript/package.json   "version"
//   Python      packages/sdk-python/pyproject.toml     [project] version
//   Go          packages/sdk-go/version.go             const Version
//
// A guard that reads a version from here fails the moment a page disagrees with
// the package, in either direction, and cannot be satisfied by editing only one
// of them. Each accessor THROWS when its file stops declaring a version rather
// than returning a default: an empty derived version would match nothing and
// read as a clean sweep.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

function extract(relPath: string, pattern: RegExp, what: string): string {
  const body = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  const match = pattern.exec(body);
  if (match === null || match[1] === undefined || match[1].trim() === '') {
    throw new Error(
      `${relPath} no longer declares ${what} — every guard deriving an SDK version from it ` +
        `would compare against an empty string and pass on anything. Fix the path or the pattern.`,
    );
  }
  return match[1];
}

/** `0.2.0` — what `npm publish` from packages/sdk-typescript will put on npm. */
export function typescriptSdkVersion(): string {
  return extract('packages/sdk-typescript/package.json', /"version":\s*"([^"]+)"/, 'a "version"');
}

/** `0.2.0` — what `python -m build` in packages/sdk-python will name the wheel. */
export function pythonSdkVersion(): string {
  return extract(
    'packages/sdk-python/pyproject.toml',
    /^version = "([^"]+)"$/m,
    '[project] version',
  );
}

/** `0.3.0` — the version the Go tag `packages/sdk-go/v<version>` must carry. */
export function goSdkVersion(): string {
  return extract('packages/sdk-go/version.go', /^const Version = "([^"]+)"$/m, 'const Version');
}

/** `driftstack-sdk` — the PyPI distribution, which is NOT the import name. */
export function pythonDistName(): string {
  return extract('packages/sdk-python/pyproject.toml', /^name = "([^"]+)"$/m, '[project] name');
}

/**
 * The exclusive upper bound of a pre-1.0 compatible-release range: `0.2.0` →
 * `0.3`. Pre-1.0 the MINOR is the compatibility unit, so the ceiling is the
 * next MINOR, not the next MAJOR.
 */
export function nextMinor(version: string): string {
  const parts = version.split('.');
  if (parts.length < 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) {
    throw new Error(`not a SemVer version: ${version}`);
  }
  return `${parts[0]}.${Number(parts[1]) + 1}`;
}
