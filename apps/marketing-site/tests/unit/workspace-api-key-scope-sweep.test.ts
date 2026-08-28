// W278.A — workspace-wide sweep guard for ApiKeyScopeSchema. The
// scopes table on marketing-site / docs / dashboard must never cite
// a scope that isn't in the live enum. Catches drift where docs
// invent plausible-but-fake scopes like `read:sessions:all` or
// `write:account`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
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
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const liveScopes = new Set(ApiKeyScopeSchema.options);

// Cite-pattern: a granular scope is `verb:resource` where verb ∈
// {read, write, admin} and resource is a lowercased noun. Inspect
// only tokens that match that shape AND are inside a code or
// inline-code marker (` or <code>).
const scopeRe = /(?:`|<code>)((?:read|write|admin):[a-z][a-z-]+)(?:`|<\/code>)/g;

describe('W278.A workspace-wide ApiKeyScopeSchema sweep', () => {
  // ⛔ Non-vacuity floor, added 2026-08-26. `walk` returns [] for a missing
  // root, so a renamed corpus directory turns this entire sweep green while
  // examining nothing. Mutation-proved: with both roots repointed at paths
  // that do not exist, the verdict was byte-identical to the clean run.
  //
  // Asserted PER ROOT on purpose. A floor on the combined count still passes
  // when ONE of the two directories disappears — which is the likelier
  // accident — because the survivor alone clears any threshold worth setting.
  // No count is pinned, so this cannot rot as pages are added or removed.
  it('every corpus root contributes files to the sweep', () => {
    for (const d of targets) {
      expect(walk(d).filter((f) => /\.(astro|md)$/.test(f)).length, d).toBeGreaterThan(0);
    }
  });

  it('every cited verb:resource scope is a real schema member', () => {
    const offenders: { file: string; scope: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(scopeRe)];
      for (const m of matches) {
        const scope = m[1]!;
        if (!liveScopes.has(scope as never)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), scope });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
