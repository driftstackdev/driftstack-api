// Cross-source invariant: every `client.<resource>.<method>(` call shown in
// the customer docs must reference a real SDK method — in at least one of the
// three SDKs (TS camelCase, Python snake_case, Go PascalCase).
//
// Closes the bug class fixed in 2f9b8b81 / 3db6f2d9: docs documented SDK
// methods that don't exist anywhere (billing startPortalSession +
// createCryptoCheckout; account.cost). The per-page content-parity pins lock
// specific example strings but can themselves encode a wrong name; this sweep
// cross-checks the doc calls against the actual SDK source so a non-existent
// method name can't ship in a customer-facing example, in any language.
//
// "At least one SDK" rather than per-language on purpose: the three case
// conventions (camelCase / snake_case / PascalCase) already separate most
// calls, but a handful of all-lowercase names (e.g. `usage.current`) exist in
// one SDK and not another. Keying off the union catches the real failure mode
// — a method that exists in NO SDK — without false-flagging a valid example
// in one language just because another language spells that method
// differently. One-directional: doc calls ⊆ SDK methods.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_DIR = resolve(REPO_ROOT, 'apps/docs/src/pages');

function walkDocs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkDocs(p));
    else if (p.endsWith('.md') || p.endsWith('.astro')) out.push(p);
  }
  return out;
}

function addMatches(
  src: string,
  re: RegExp,
  key: (m: RegExpExecArray) => string,
  into: Set<string>,
): void {
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) into.add(key(m));
}

// Union of `<clientProp>.<method>` pairs across all three SDKs. Each SDK keeps
// its own naming convention (camel / snake / Pascal); a doc call is valid if it
// matches any one of them.
function buildUnionInventory(): Set<string> {
  const set = new Set<string>();

  // TS: kebab resource filename → camelCase client prop; 2-space-indented members.
  const tsDir = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
  for (const f of readdirSync(tsDir)) {
    if (!f.endsWith('.ts')) continue;
    const prop = f.replace(/\.ts$/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    addMatches(
      readFileSync(join(tsDir, f), 'utf8'),
      /^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\s*[(<]/gm,
      (m) => `${prop}.${m[1]}`,
      set,
    );
  }

  // Python: snake_case resource filename = client prop; 4-space-indented `def`.
  const pyDir = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources');
  for (const f of readdirSync(pyDir)) {
    if (!f.endsWith('.py') || f.startsWith('_')) continue;
    const prop = f.replace(/\.py$/, '');
    addMatches(
      readFileSync(join(pyDir, f), 'utf8'),
      /^ {4}def ([a-z][a-z0-9_]*)\(/gm,
      (m) => `${prop}.${m[1]}`,
      set,
    );
  }

  // Go: top-level *.go (not _test.go); `func (r *XResource) Method(` → X.Method.
  const goDir = resolve(REPO_ROOT, 'packages/sdk-go');
  for (const f of readdirSync(goDir)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    addMatches(
      readFileSync(join(goDir, f), 'utf8'),
      /^func \([a-z] \*([A-Za-z]+)Resource\) ([A-Z][a-zA-Z0-9]*)\(/gm,
      (m) => `${m[1]}.${m[2]}`,
      set,
    );
  }

  return set;
}

describe('docs ↔ SDK method-call cross-source invariant', () => {
  const inventory = buildUnionInventory();
  const files = walkDocs(DOCS_DIR);

  it('sanity: union SDK inventory + doc files are non-empty', () => {
    expect(inventory.size).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(10);
  });

  it('every client.<resource>.<method>() in the docs exists on a real SDK', () => {
    const callRe = /client\.([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\(/g;
    const missing: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      const re = new RegExp(callRe.source, 'g');
      while ((m = re.exec(body)) !== null) {
        scanned += 1;
        const key = `${m[1]}.${m[2]}`;
        if (!inventory.has(key)) missing.push(`${key}  (${file.slice(REPO_ROOT.length + 1)})`);
      }
    }
    // Guard against a vacuous pass if the call regex ever stops matching.
    expect(scanned, 'expected the docs to contain SDK method-call examples').toBeGreaterThan(20);
    expect(
      missing,
      `doc client.<resource>.<method>() calls with no matching SDK method (TS/Python/Go):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
