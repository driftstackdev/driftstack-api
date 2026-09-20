// The guide and the quickstarts name the SDK version their examples need.
//
// `guides/run-ai-tasks-from-code.md` teaches the whole agent-session surface,
// and none of it exists in the packages that were on npm, PyPI and the Go
// proxy when it was written: @driftstack/sdk 0.1.6 has four resources and no
// `agentSessions` at all. A customer who follows the install line, pastes the
// program and gets a type error is not reading a guide, they are debugging
// one. So each page says the minimum version its examples need.
//
// The number is DERIVED from the package that decides it, never spelled in
// this file:
//
//   TypeScript  packages/sdk-typescript/package.json   "version"
//   Python      packages/sdk-python/pyproject.toml     [project] version
//   Go          packages/sdk-go/version.go             const Version
//
// That makes the guard bidirectional. A release that bumps a package and
// forgets a page is red; a page edited to a version no package publishes is
// red. A literal here would have been satisfied by whatever was true the day
// it was written — which is exactly how `sdk/versioning.md` came to recommend
// `^0.1.5` for four months with 0.1.6 on npm, with two content-parity guards
// green over it the whole time.
//
// `versionsNamedFor` is the whole check, and the last `describe` runs it
// against documents built to fail it — a stale version and a page that names
// none — plus one built to pass, so a green here means the instrument
// discriminates rather than that it is blind.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goSdkVersion, pythonSdkVersion, typescriptSdkVersion } from './_helpers/sdk-versions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const GUIDE = 'apps/docs/src/pages/guides/run-ai-tasks-from-code.md';
const TS_QUICKSTART = 'apps/docs/src/pages/sdk/typescript-quickstart.md';
const PY_QUICKSTART = 'apps/docs/src/pages/sdk/python-quickstart.md';
const GO_QUICKSTART = 'apps/docs/src/pages/sdk/go-quickstart.md';

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

/**
 * How each package is named next to a version on a customer page. One capture
 * group, holding the version.
 *
 * The TypeScript and Python patterns cannot collide: the npm package is
 * `@driftstack/sdk` (a slash) and the PyPI distribution is `driftstack-sdk`
 * (a hyphen), and both are spelled inside backticks.
 */
const NAMES_VERSION = {
  typescript: /`@driftstack\/sdk`\s+v?(\d+\.\d+\.\d+)/g,
  python: /`driftstack-sdk`\s+v?(\d+\.\d+\.\d+)/g,
  // Sentence-initial on the quickstart, mid-sentence in the guide.
  go: /[Tt]he Go module at `v(\d+\.\d+\.\d+)`/g,
} as const;

/** Every version a page names for one package, in the order it names them. */
function versionsNamedFor(body: string, pattern: RegExp): string[] {
  return [...body.matchAll(new RegExp(pattern.source, 'g'))].map((m) => m[1] ?? '');
}

/**
 * The complaint a page earns, or `null` when it is correct. Naming NO version
 * is a failure of its own: a page that quietly stopped making the claim would
 * otherwise satisfy an "every version named is the current one" check
 * vacuously.
 */
function whyStale(body: string, pattern: RegExp, expected: string): string | null {
  const named = versionsNamedFor(body, pattern);
  if (named.length === 0) return 'names no version for this package at all';
  const wrong = named.filter((v) => v !== expected);
  if (wrong.length > 0) return `names ${wrong.join(', ')} where the package publishes ${expected}`;
  return null;
}

describe('the guide and the quickstarts name the SDK version their examples need', () => {
  it('the four pages exist at the paths this guard reads', () => {
    for (const p of [GUIDE, TS_QUICKSTART, PY_QUICKSTART, GO_QUICKSTART]) {
      expect(existsSync(resolve(REPO_ROOT, p)), `${p} is missing`).toBe(true);
    }
  });

  it('CRITICAL the AI guide names the minimum version of all three SDKs, and each one is the version its package publishes', () => {
    const body = read(GUIDE);

    expect(body, 'the guide no longer carries an SDK-versions line').toContain('**SDK versions.**');
    expect(whyStale(body, NAMES_VERSION.typescript, typescriptSdkVersion())).toBeNull();
    expect(whyStale(body, NAMES_VERSION.python, pythonSdkVersion())).toBeNull();
    expect(whyStale(body, NAMES_VERSION.go, goSdkVersion())).toBeNull();
  });

  it('CRITICAL the guide says why an earlier release cannot be used, not only which one to install', () => {
    const body = read(GUIDE);
    expect(body).toMatch(/Earlier releases have\s*no agent sessions at all/);
  });

  it('CRITICAL the TypeScript quickstart names the @driftstack/sdk version its examples are written against', () => {
    const body = read(TS_QUICKSTART);
    const ts = typescriptSdkVersion();

    expect(body).toContain(`\`@driftstack/sdk\` ${ts} or newer.`);
    expect(whyStale(body, NAMES_VERSION.typescript, ts)).toBeNull();
  });

  it('CRITICAL the Python quickstart names the driftstack-sdk version its examples are written against', () => {
    const body = read(PY_QUICKSTART);
    const py = pythonSdkVersion();

    expect(body).toContain(`\`driftstack-sdk\` ${py} or newer.`);
    expect(whyStale(body, NAMES_VERSION.python, py)).toBeNull();
  });

  it('CRITICAL the Go quickstart names the module version its examples are written against', () => {
    const body = read(GO_QUICKSTART);
    const go = goSdkVersion();

    expect(body).toContain(`The Go module at \`v${go}\` or newer.`);
    expect(whyStale(body, NAMES_VERSION.go, go)).toBeNull();
  });

  // ─── Negative control ─────────────────────────────────────────
  //
  // Every assertion above is a `toBeNull()`, which a checker that can only
  // ever return null would also satisfy. These run the same function over
  // documents written to fail it, and one written to pass.

  describe('the guard itself: a stale page is reported, a correct one is not', () => {
    const CORRECT = '- `@driftstack/sdk` 4.5.6 or newer. Examples are written against it.\n';
    const STALE = '- `@driftstack/sdk` 1.2.3 or newer. Examples are written against it.\n';
    const SILENT = '- Install it with `npm install @driftstack/sdk`.\n';

    it('a page naming the version the package publishes is reported as correct', () => {
      expect(whyStale(CORRECT, NAMES_VERSION.typescript, '4.5.6')).toBeNull();
    });

    it('a page left on the previous version is reported, naming both versions', () => {
      const why = whyStale(STALE, NAMES_VERSION.typescript, '4.5.6');
      expect(why).not.toBeNull();
      expect(why).toContain('1.2.3');
      expect(why).toContain('4.5.6');
    });

    it('a page that names no version at all is reported rather than passing vacuously', () => {
      expect(whyStale(SILENT, NAMES_VERSION.typescript, '4.5.6')).toBe(
        'names no version for this package at all',
      );
    });

    it('the Python pattern does not match the npm package, whose name contains a slash not a hyphen', () => {
      expect(versionsNamedFor(CORRECT, NAMES_VERSION.python)).toEqual([]);
      expect(versionsNamedFor('- `driftstack-sdk` 9.9.9 or newer.', NAMES_VERSION.python)).toEqual([
        '9.9.9',
      ]);
    });
  });
});
