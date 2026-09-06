// An auth-token fixture on the SHARED database may not expire in the past.
//
// `deleteStaleAuthTokens` (`apps/server/src/db/auth-flows-repo.ts:238`) has NO
// account predicate. It deletes EVERY row of the kind's table that is either
// consumed before the window or UNCONSUMED with `expiresAt < expiredBefore`. On
// the shared test database that means one file's sweep reaches into every other
// file's rows.
//
// Observed, not imagined (N-AUTH-TOKEN-FLAKE). `auth-token-family-repo-contract`
// anchored its clock to `new Date('2026-08-20T12:00:00.000Z')`, so its EXPIRES
// sat an hour into a day that had already passed — permanently stale. When
// `db-auth-flows-stale-token-sweep-drizzle` ran against the same database, its
// sweep deleted the family test's unconsumed rows mid-run, and the failure
// surfaced in the family file, which had done nothing wrong. The cost of that
// shape is not a red test; it is a red test in the WRONG FILE, which is why it
// was written off as a flake instead of a defect.
//
// Isolating the account fixture per worker does not fix it — the DELETE is not
// scoped by account, so there is nothing for a per-worker account to protect.
// Two shapes are accepted:
//
//   wall-clock anchor   `const NOW = new Date()` — every derived expiry is then
//                       in the future, so the unconsumed branch cannot match.
//   own database        the file calls `ensureIsolatedDatabase` /
//                       `assertIsolatedDatabase`, so no other suite's sweep can
//                       reach it however its clock is written.
//
// What this rejects is the third shape: a fixed past literal on the shared
// database. The rule is stated WITHOUT reference to the current date on purpose
// — any hardcoded anchor is eventually in the past, so "is it stale yet" would
// make this guard turn red one day with no code change and green again if the
// literal were bumped. The defect is the fixed literal itself.
//
// Scope note: this deliberately only covers files that seed AUTH TOKENS, the
// rows `deleteStaleAuthTokens` can reach. Fixed date literals elsewhere are
// legitimate and common (`rate-limit-overrides-repo-contract` uses 2099 and
// 2000 as explicit far-future/far-past bounds); flagging those would be noise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = resolve(HERE, '..', 'integration');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Seeds rows that `deleteStaleAuthTokens` can reach.
const SEEDS_AUTH_TOKENS = /password_reset_tokens|email_verify_tokens|insertAuthToken/;
// Proves it is on its own database, so no other suite's sweep reaches it.
const ISOLATED = /ensureIsolatedDatabase|assertIsolatedDatabase/;
// `const NAME = new Date('…')` — a hardcoded anchor.
const LITERAL_ANCHOR = /const\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\('/g;
// `const NAME = new Date(OTHER.getTime() + …)` — an anchor derived from another.
const DERIVED_ANCHOR =
  /const\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\s*([A-Za-z_$][\w$]*)\.getTime\(\)/g;
// `expiresAt: NAME` — the field the sweep's unconsumed branch compares.
const EXPIRES_AT = /expiresAt:\s*([A-Za-z_$][\w$]*)/g;

/** Names bound, directly or transitively, to a hardcoded date literal. */
function literalAnchoredNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(LITERAL_ANCHOR)) names.add(m[1] as string);
  // Resolve chains (`LATER = new Date(NOW.getTime() + …)`). Four passes is far
  // more than any real fixture needs and terminates regardless.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const m of body.matchAll(DERIVED_ANCHOR)) {
      if (names.has(m[2] as string)) names.add(m[1] as string);
    }
  }
  return names;
}

/** The offending expiry constants in one file's source, or [] if it is fine. */
export function staleExpiryFixtures(body: string): string[] {
  if (!SEEDS_AUTH_TOKENS.test(body)) return [];
  if (ISOLATED.test(body)) return [];
  const anchored = literalAnchoredNames(body);
  const flagged = new Set<string>();
  for (const m of body.matchAll(EXPIRES_AT)) {
    const name = m[1] as string;
    if (anchored.has(name)) flagged.add(name);
  }
  return [...flagged].sort();
}

// The exact pre-fix shape, inline rather than read from a file: a fixture on
// disk could be edited (or deleted) and this arm would then pass on absence.
const KNOWN_POSITIVE = `
const NOW = new Date('2026-08-20T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);
const EXPIRES = new Date(NOW.getTime() + 3_600_000);
await repo.insertAuthToken({ kind: KIND, tokenHash: hash, expiresAt: EXPIRES });
`;

describe('a shared-database auth-token fixture may not expire in the past', () => {
  const files = walk(INTEGRATION);

  it('the walk found the integration suite — a zero below is a finding, not an empty scan', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.filter((f) => SEEDS_AUTH_TOKENS.test(readFileSync(f, 'utf8'))).length,
    ).toBeGreaterThan(3);
  });

  it('CRITICAL no non-isolated integration file anchors an auth-token expiry to a fixed date literal', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const flagged = staleExpiryFixtures(readFileSync(f, 'utf8'));
      if (flagged.length > 0) {
        offenders.push(`${f.slice(f.indexOf('apps/'))} → ${flagged.join(', ')}`);
      }
    }
    expect(
      offenders,
      'anchor the fixture clock to `new Date()`, or give the file its own database with ' +
        '`ensureIsolatedDatabase` — a fixed literal is eventually in the past, and the sweep ' +
        'deletes those rows out from under whichever file happens to own them',
    ).toEqual([]);
  });

  it('CRITICAL vacuity control — the detector still finds the shape it was written for', () => {
    expect(staleExpiryFixtures(KNOWN_POSITIVE)).toEqual(['EXPIRES']);
  });

  it('the wall-clock form of the same fixture is NOT flagged', () => {
    expect(
      staleExpiryFixtures(KNOWN_POSITIVE.replace(/new Date\('[^']*'\)/, 'new Date()')),
    ).toEqual([]);
  });

  it('an isolated file is exempt even with a fixed literal — its rows are out of reach', () => {
    expect(
      staleExpiryFixtures(`await ensureIsolatedDatabase(client, N);${KNOWN_POSITIVE}`),
    ).toEqual([]);
  });

  it('a file that seeds no auth tokens is out of scope — far-future/far-past bounds stay legal', () => {
    expect(
      staleExpiryFixtures(`
        const FAR = new Date('2099-01-01T00:00:00.000Z');
        await repo.upsertOverride({ accountId: a, expiresAt: FAR });
      `),
    ).toEqual([]);
  });
});
