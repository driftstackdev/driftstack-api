// Drift-guard (V-174 class): every scope literal passed to a scope-
// enforcement helper (`requireScope` / `throwIfMissingScope` / `hasScope`)
// must be a member of the canonical ApiKeyScopeSchema enum.
//
// Why this guard exists: enforcement is service-layer, scattered across
// many route/service files. A stale or mistyped scope literal at a call
// site (e.g. the pre-V-174 literal 'admin', or a typo like 'write:profile')
// does not fail type-checking — the helpers take a plain string — so it
// silently 403s every valid key that hits that path. Today such a bug is
// caught only where a per-endpoint 403 test happens to exercise the route;
// this scans ALL call sites in apps/server/src so a bad literal fails CI
// regardless of per-endpoint coverage.
//
// Scope: literal string arguments only. Calls that pass the scope via a
// variable can't be validated statically and are skipped (the helper's
// own typing covers the typed paths).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

const VALID_SCOPES = new Set<string>(ApiKeyScopeSchema._def.values as readonly string[]);

/** Recursively collect every .ts file under apps/server/src. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Every (file, scopeLiteral) pair where a scope-enforcement helper is
 * called with a string literal. `[^)]*?` lazily reaches the first quoted
 * literal after the open paren — the scope argument in the common
 * `helper(ctx, 'scope')` and `helper('scope')` shapes — and spans
 * multi-line calls (it excludes `)` but not newlines).
 */
function enforcementLiterals(): Array<{ file: string; scope: string }> {
  const re = /(?:requireScope|throwIfMissingScope|hasScope)\([^)]*?'([a-z][a-z_:-]*)'/g;
  const found: Array<{ file: string; scope: string }> = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const scope = m[1];
      if (scope !== undefined) found.push({ file: file.replace(`${SRC}/`, ''), scope });
    }
  }
  return found;
}

describe('scope-enforcement call-site literals ↔ ApiKeyScopeSchema', () => {
  const literals = enforcementLiterals();

  it('finds a healthy number of enforcement call sites (sanity)', () => {
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });

  it('every enforcement scope literal is a valid ApiKeyScopeSchema member', () => {
    const invalid = literals
      .filter((l) => !VALID_SCOPES.has(l.scope))
      .map((l) => `${l.file}: '${l.scope}'`);
    expect(invalid, `invalid scope literal(s): ${invalid.join('; ')}`).toEqual([]);
  });

  it("no enforcement call uses the bare legacy 'admin' literal (V-174: only legacy keys satisfy it; account_owner / driftstack_internal_admin do NOT)", () => {
    const bareAdmin = literals.filter((l) => l.scope === 'admin').map((l) => l.file);
    expect(bareAdmin, `bare 'admin' enforcement at: ${bareAdmin.join('; ')}`).toEqual([]);
  });
});
