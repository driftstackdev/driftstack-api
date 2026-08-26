// Security regression guard for provider-scoped account email identity.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalizeEmailForDedup } from '../../src/services/auth-flows.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MIGRATION = resolve(
  REPO_ROOT,
  'apps/server/src/db/migrations/0102_accounts_canonical_email_provider_scope.sql',
);

describe('provider-scoped email canonicalization', () => {
  // V-1725 — WHO is allowed to look an account up by its LITERAL email.
  //
  // The 2026-07-01 fix added `canonical_email`, `findAccountByCanonicalEmail` and
  // the `findAccountByEmailOrCanonical` helper, and moved four call sites in
  // services/auth-flows.ts onto it. One caller was missed: the OAuth-client
  // wiring in lib/bootstrap.ts, written 2026-05-15, six weeks before the column
  // existed. The miss is invisible from either file — the sweep that updated
  // auth-flows.ts had no reason to open bootstrap.ts — which is exactly why a
  // static arm and not a careful reviewer is the right instrument.
  //
  // This does NOT fix that caller: routing a collision into the merge flow
  // changes sign-in semantics and is held for the owner (V-1724, reproduced
  // against a live database). It stops a SECOND one appearing, which needs no
  // decision. The exemption carries its reason so the list cannot quietly grow.
  it('CRITICAL every literal-email account lookup outside auth-flows is exempted WITH a reason. canonical_email exists because a Gmail alias must collide with whichever literal was registered first; a caller consulting only the literal column misses that collision and reaches an insert the unique index refuses.', () => {
    const EXEMPT = new Map<string, string>([
      [
        'lib/bootstrap.ts',
        'V-1724 — the OAuth-client accounts wiring predates canonical_email (2026-05-15 vs ' +
          '2026-07-01). Consulting only the literal column turns a Gmail-alias sign-in into a ' +
          '500 instead of the Verdict-1 merge flow. The repair is one lookup plus widening the ' +
          'repo interface to return a row so the merge mail addresses the stored email; both ' +
          "change sign-in semantics on an auth path and are the owner's call.",
      ],
    ]);
    const SRC = resolve(REPO_ROOT, 'apps/server/src');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const files = walk(SRC);
    expect(files.length, 'the walk found no server sources at all').toBeGreaterThan(100);

    // The repo method itself and the service that pairs it with a canonical
    // lookup are the two legitimate homes; everything else must be exempted.
    const HOMES = ['db/auth-flows-repo.ts', 'services/auth-flows.ts'];
    const callers = files
      // Comments stripped: a file DISCUSSING the literal lookup — this repo is
      // full of such comments — is not a file performing it, and a text match
      // would read the ledger's own prose as a violation.
      .filter((f) => /\.findAccountByEmail\(/.test(codeOnly(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !HOMES.includes(rel))
      .sort();
    expect(
      callers.length,
      'no caller found — the detector would pass on an empty set',
    ).toBeGreaterThan(0);

    expect(
      callers.filter((rel) => !EXEMPT.has(rel)),
      'literal-email lookups with no recorded reason — use findAccountByEmailOrCanonical, or add the file here with why it cannot',
    ).toEqual([]);

    // A roster must not outlive its reasons: an exemption for a file that no
    // longer performs the lookup is a stale claim about live code.
    expect(
      [...EXEMPT.keys()].filter((rel) => !callers.includes(rel)),
      'exemptions naming a file that no longer looks up by literal email',
    ).toEqual([]);
    for (const [rel, why] of EXEMPT) {
      expect(why.length, `${rel} is exempted without a usable reason`).toBeGreaterThan(80);
    }
  });

  it('folds Gmail aliases but preserves plus and dot characters for other providers', () => {
    expect(canonicalizeEmailForDedup('f.o.o+tag@gmail.com')).toBe('foo@gmail.com');
    expect(canonicalizeEmailForDedup('f.o.o+tag@googlemail.com')).toBe('foo@googlemail.com');
    expect(canonicalizeEmailForDedup('f.o.o+tag@example.com')).toBe('f.o.o+tag@example.com');
  });

  it('backfills only non-Gmail canonical values to the stored literal email', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/SET "canonical_email" = lower\("email"\)/);
    expect(sql).toMatch(
      /WHERE lower\(split_part\("email", '@', 2\)\) NOT IN \('gmail\.com', 'googlemail\.com'\)/,
    );
    expect(sql).toMatch(/"canonical_email" IS DISTINCT FROM lower\("email"\)/);
  });
});
