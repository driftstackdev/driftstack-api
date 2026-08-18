// The scope names in the docs are exactly the scopes the server accepts.
//
// Scopes are a vocabulary customers type. They pick them from the docs when
// minting a key, so drift hurts in both directions and neither is loud:
//
//   documented but not real   the mint request fails validation, and the
//                             customer is holding a page that told them to send
//                             it. Nothing on our side logs "a doc lied";
//   real but not documented   a capability exists that nobody can discover.
//                             `read:audit` is not guessable.
//
// Both sides are read from source: the enum out of ApiKeyScopeSchema, the docs
// out of the backticked form the pages use. Today they are equal at 19, which is
// why this can assert equality rather than a subset — a weaker check would let
// the next granular scope ship undocumented.
//
// The enum parse strips comment lines first, and that is not cosmetic. Reading
// the block raw, a naive quoted-string match picks up the prose inside it —
// `apps/server/src/lib/errors-helpers.ts` sits in a comment there, quotes and
// all — which yielded a 8-scope vocabulary containing a bare `s` and a comma,
// and made all thirteen granular scopes look undocumented. Every one of them is
// real.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '..', '..', '..', 'docs', 'src', 'pages');

/**
 * Scope names the docs put in front of a customer.
 *
 * Backticked only. The pages write scopes as code spans, and matching bare words
 * would pick up every sentence containing "read" or "write".
 */
const SCOPE_IN_DOCS =
  /`((?:read|write|admin|account_owner|gui_control|driftstack_internal_admin)(?::[a-z_.-]+)?)`/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.mdx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function documentedScopes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of walk(DOCS)) {
    for (const m of readFileSync(file, 'utf8').matchAll(SCOPE_IN_DOCS)) {
      const name = m[1] ?? '';
      out.set(name, [...(out.get(name) ?? []), file.slice(DOCS.length + 1)]);
    }
  }
  return out;
}

describe('the documented scope vocabulary matches the server', () => {
  // Imported, not parsed: the schema is the authority, and a test that re-parsed
  // its source could disagree with what the server actually validates against.
  const real = new Set<string>(ApiKeyScopeSchema.options);
  const docs = documentedScopes();

  it('CRITICAL both vocabularies were actually read', () => {
    // This file asserts two set differences are empty. Either scan coming back
    // empty produces that for free, so both are floored and probed. The probes
    // are one broad and one granular, because the parse bug this file records
    // returned the broad ones and mangled the granular ones.
    expect(real.size, 'the scope enum did not load').toBeGreaterThanOrEqual(15);
    expect(
      docs.size,
      'no scopes found in the docs — the backticked form changed',
    ).toBeGreaterThanOrEqual(15);
    for (const probe of ['read', 'write:sessions'] as const) {
      expect(real, `${probe} is in the enum but the import did not surface it`).toContain(probe);
      expect([...docs.keys()], `${probe} is documented but the doc scan missed it`).toContain(
        probe,
      );
    }
  });

  it('CRITICAL no documented scope is one the server would reject', () => {
    const unreal = [...docs.entries()]
      .filter(([s]) => !real.has(s))
      .map(([s, files]) => `${s} (${[...new Set(files)].sort().join(', ')})`)
      .sort();
    expect(
      unreal,
      'a docs page names a scope the API-key schema does not accept. A customer following that ' +
        'page gets a validation error on mint, with nothing to tell them the page is wrong',
    ).toEqual([]);
  });

  it('CRITICAL no real scope is left undocumented', () => {
    const hidden = [...real].filter((s) => !docs.has(s)).sort();
    expect(
      hidden,
      'the server accepts a scope no docs page names. Granular scopes are not guessable, so an ' +
        'undocumented one is a capability customers cannot use — document it, or remove it from ' +
        'the enum',
    ).toEqual([]);
  });
});
