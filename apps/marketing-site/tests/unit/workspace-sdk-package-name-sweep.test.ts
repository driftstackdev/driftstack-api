// W274.A — workspace-wide sweep guard. Every SDK code snippet must
// cite the canonical package name from packages/sdk-*:
//   • TypeScript: @driftstack/sdk     (NOT @driftstack/api or @driftstack/client)
//   • Python:     driftstack-sdk      (NOT driftstack-api or driftstack-client)
//   • Go:         github.com/driftstackdev/driftstack-api/packages/sdk-go
// Catches the regression class where the AI invents a plausible-
// looking but non-existent package handle.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const FORBIDDEN_PACKAGES: { pattern: RegExp; canonical: string }[] = [
  // No CLI package is published. The live device-code endpoints are an
  // internal desktop/browser-auth protocol, not evidence of a distributable.
  { pattern: /@driftstack\/cli\b/g, canonical: 'no published CLI package' },
  // TS — fictional npm scopes. Note: @driftstack/api-types is real,
  // so the negative-lookahead pins the bare /api form only.
  { pattern: /@driftstack\/api(?![-/\w])/g, canonical: '@driftstack/sdk' },
  { pattern: /@driftstack\/client(?![-/\w])/g, canonical: '@driftstack/sdk' },
  { pattern: /@driftstack\/node(?![-/\w])/g, canonical: '@driftstack/sdk' },
  // TS — directory-name-as-scope confusion. The npm package is
  // @driftstack/sdk; the per-language SUFFIX (sdk-typescript / sdk-python /
  // sdk-go) is the monorepo DIRECTORY, not a published scope.
  { pattern: /@driftstack\/sdk-(?:typescript|python|go|js|node)\b/g, canonical: '@driftstack/sdk' },
  // Python — fictional PyPI distributions
  { pattern: /\bpip install driftstack-api\b/g, canonical: 'pip install driftstack-sdk' },
  { pattern: /\bpip install driftstack-client\b/g, canonical: 'pip install driftstack-sdk' },
  // Python — bare IMPORT name used as the install target. The PyPI dist is
  // driftstack-sdk; `pip install driftstack` (or poetry/uv) installs the
  // wrong/nonexistent package. `(?!-sdk)` allows the correct form.
  { pattern: /\bpip install driftstack(?!-sdk)\b/g, canonical: 'pip install driftstack-sdk' },
  { pattern: /\bpoetry add driftstack(?!-sdk)\b/g, canonical: 'poetry add driftstack-sdk' },
  { pattern: /\buv add driftstack(?!-sdk)\b/g, canonical: 'uv add driftstack-sdk' },
  // Go — fictional module paths
  {
    pattern: /github\.com\/driftstack\/sdk-go/g,
    canonical: 'github.com/driftstackdev/driftstack-api/packages/sdk-go',
  },
  {
    pattern: /github\.com\/driftstack\/driftstack-go/g,
    canonical: 'github.com/driftstackdev/driftstack-api/packages/sdk-go',
  },
  // Repo URL — the GitHub org is `driftstackdev`, not `driftstack`. A
  // `github.com/driftstack/driftstack-api` link 404s (wrong org). The
  // `/driftstack/` (vs `/driftstackdev/`) discriminator only matches the
  // wrong form — `driftstackdev/` has no `/` after `driftstack`.
  {
    pattern: /github\.com\/driftstack\/driftstack-api/g,
    canonical: 'github.com/driftstackdev/driftstack-api',
  },
];

describe('W274.A workspace-wide SDK package-name sweep', () => {
  // ⛔ walk() returns [] for a MISSING root, and [] is also the pass condition for
  // every emptiness assertion below — so a renamed or moved root turns this whole
  // sweep silent and green in the same instant, reporting the corpus clean because
  // it read none of it.
  //
  // ⚠️ Asserted in its own arm rather than at the walk. `allFiles` is built at MODULE
  // scope, where a throw takes the entire file out of collection instead of failing a
  // test; and the guard inside walk() covers every recursive descent, so making THAT
  // throw would kill the walk on a vanishing subdirectory or a broken symlink — a
  // different failure from the one being caught.
  it('non-vacuous: the sweep read a real corpus, so an empty result is a finding and not a clean bill', () => {
    for (const dir of targets) {
      expect(existsSync(dir), `walk root missing — this sweep read nothing: ${dir}`).toBe(true);
    }
    expect(
      allFiles.length,
      'the walk found no files; an empty sweep is not a clean one',
    ).toBeGreaterThan(5);
  });

  for (const { pattern, canonical } of FORBIDDEN_PACKAGES) {
    it(`no page references a fictional SDK package — canonical is ${canonical}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        if (pattern.test(body)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
        pattern.lastIndex = 0;
      }
      expect(offenders).toEqual([]);
    });
  }
});
