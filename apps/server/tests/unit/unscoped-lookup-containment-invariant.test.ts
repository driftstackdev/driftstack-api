// Account-unscoped lookups must never reach a customer route.
//
// Two repository methods deliberately skip the account predicate:
// `findSessionUnscoped(id)` and `findApiKeyUnscoped(id)`, both documented
// "admin force-actions only". Their account-scoped siblings — `findSession(id,
// accountId)` and `findApiKey(id, accountId)` — are what every customer path
// uses, and the difference between the two is the entire cross-account
// isolation boundary for those resources.
//
// Today neither unscoped method has a single call site anywhere in `src/`: each
// appears exactly twice, as an implementation and an interface declaration.
// That is the safest possible state and also the most fragile one. They are
// pinned by several content-parity guards, so they will not be removed, and a
// future admin flow reaching for "the lookup by id" can pick the unscoped
// variant by autocomplete and silently serve one account's session to another.
// Nothing would fail: the parity guards assert the method EXISTS, not that it
// stays out of customer reach.
//
// So the boundary is enforced structurally instead of relied upon.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const ROUTES_DIR = resolve(SRC, 'routes');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every method whose NAME advertises that it skips account scoping. */
const UNSCOPED_METHOD_RE = /\b(?:async\s+)?([A-Za-z0-9_]*Unscoped)\s*\(/g;

/**
 * The complete set, pinned. A third unscoped lookup is a deliberate decision
 * about the isolation boundary and must not arrive as a drive-by addition.
 */
const EXPECTED_UNSCOPED_METHODS = ['findApiKeyUnscoped', 'findSessionUnscoped'] as const;

describe('account-unscoped lookups stay out of customer reach', () => {
  const srcFiles = tsFilesUnder(SRC);

  it('CRITICAL the set of account-unscoped lookups is exactly the two known admin-only ones. Each skips the account predicate that IS the cross-account isolation boundary for its resource, so a third arriving unnoticed is how that boundary erodes.', () => {
    const found = new Set<string>();
    for (const file of srcFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(UNSCOPED_METHOD_RE)) found.add(m[1]!);
    }
    expect([...found].sort()).toEqual([...EXPECTED_UNSCOPED_METHODS]);
  });

  it('CRITICAL no route handler calls an account-unscoped lookup. The scoped sibling (findSession(id, accountId) / findApiKey(id, accountId)) is the customer path; reaching for the unscoped one by autocomplete would serve one account the other account’s resource, and every existing guard would stay green because they assert the method EXISTS, not that it stays unreachable.', () => {
    // V-1561 — this arm reports an ABSENCE, and the previous arm cannot cover it:
    // that one walks SRC, this one walks ROUTES_DIR separately. Retargeting
    // ROUTES_DIR at an existing directory containing no `.ts` (measured with
    // `src/db/migrations`) left all three arms GREEN while nothing was scanned.
    // A missing directory throws and is loud; a directory that simply yields
    // nothing is silent, which is the case that matters.
    const routeFiles = tsFilesUnder(ROUTES_DIR);
    expect(routeFiles.length, 'route files walked for unscoped-lookup calls').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of routeFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(UNSCOPED_METHOD_RE)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${file.slice(SRC.length + 1)}:${line} → ${m[1]!}`);
      }
    }
    expect(offenders, 'Route(s) calling an account-unscoped lookup:').toEqual([]);
  });

  it('CRITICAL every unscoped lookup still has its account-scoped sibling, so the safe variant remains available and the unscoped one never becomes the only way to read the resource', () => {
    const all = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const unscoped of EXPECTED_UNSCOPED_METHODS) {
      const scoped = unscoped.replace(/Unscoped$/, '');
      expect(
        new RegExp(`\\basync\\s+${scoped}\\s*\\(\\s*id: string,\\s*accountId: string`).test(all),
        `${scoped}(id, accountId) — the account-scoped sibling of ${unscoped} — is missing`,
      ).toBe(true);
    }
  });
});
