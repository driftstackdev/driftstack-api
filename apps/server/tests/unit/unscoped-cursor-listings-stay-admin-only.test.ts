// A cursor-paginated repo listing with no account filter must stay staff-only.
//
// lib/keyset-cursor.ts rests its safety on one sentence: "The downstream
// `WHERE account_id = …` filter is independent of the cursor, so this is purely
// a robustness fix — it never widens what a caller can read." That is true for
// every listing that HAS an account filter. Three do not:
//
//   api-keys-repo.listAllApiKeys
//   rate-limit-overrides-repo.listAll
//   webhooks-repo.listDlqDeliveries
//
// All three are staff surfaces, and all three are gated in their service wrapper
// by `throwIfMissingScope(ctx, 'driftstack_internal_admin')` — verified by hand,
// including the one that looked alarming: `dlq` appears in routes/webhooks.ts,
// the CUSTOMER webhook routes, but only as a count field in a response shape,
// never as a listing call.
//
// The danger is the fourth one. A new cursor listing with no account filter,
// wired to a customer route, reads other tenants' rows — and the cursor guard's
// comment would still say the account filter makes that impossible.
//
// SCOPE, because I tried the more ambitious version first and it does not work.
// Statically mapping repo method → service caller → route is unreliable here:
// `listAll` exists on four different repos, and a name-based mapper matched
// pricing's while missing the two callers I had confirmed by hand. A
// service-layer rule ("a method calling .list*() must reference accountId or the
// admin scope") flagged 16 methods, most legitimate — pricing and incidents are
// global by design, and several scope through `effective.accountId` rather than
// the literal name. A guard with that false-positive rate gets weakened or
// deleted, which is worse than none.
//
// So this guards the half that IS reliable: discovery of unscoped cursor
// listings is single-file analysis and exact. The gate for each is recorded
// after hand-verification. A fourth listing fails here until someone checks it
// and writes down where it is gated.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const DB = resolve(SRC, 'db');
const SERVICES = resolve(SRC, 'services');

/**
 * Unscoped cursor listings, each with the service wrapper that gates it.
 * Verified by hand: every wrapper calls
 * `throwIfMissingScope(ctx, 'driftstack_internal_admin')` before the repo call.
 */
const KNOWN_UNSCOPED = new Map<string, { service: string; wrapper: string }>([
  ['api-keys-repo.ts:listAllApiKeys', { service: 'api-keys.ts', wrapper: 'listAll' }],
  [
    'rate-limit-overrides-repo.ts:listAll',
    { service: 'rate-limit-overrides.ts', wrapper: 'listAll' },
  ],
  // The wrapper is `listDlq`, NOT `listDlqDeliveries` — the latter is the repo
  // INTERFACE declared inside webhooks.ts, which is what a name-based lookup
  // finds first.
  ['webhooks-repo.ts:listDlqDeliveries', { service: 'webhooks.ts', wrapper: 'listDlq' }],
]);

/** The `{ … }` block that starts at or after `from`. */
function blockAt(src: string, from: number): string {
  const open = src.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Repo methods that take a cursor and never mention an account column. */
function unscopedCursorListings(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(DB).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(resolve(DB, file), 'utf8');
    for (const m of src.matchAll(/\n {2}async (\w+)\(([^)]*)\)/g)) {
      if (!/cursor/i.test(m[2] ?? '')) continue;
      // From the END of the signature: starting at the match index finds the
      // first `{` in the PARAMETER list (an inline type literal), not the body —
      // which classified listSessions, whose params are an object type, as
      // unscoped. The negative control below is what caught that.
      const body = blockAt(src, (m.index ?? 0) + m[0].length);
      if (!/accountId|account_id/.test(body)) out.push(`${file}:${m[1] ?? ''}`);
    }
  }
  return out.sort();
}

describe('cursor listings with no account filter stay staff-only', () => {
  const unscoped = unscopedCursorListings();

  it('CRITICAL the scan finds cursor listings at all, and can tell scoped from unscoped', () => {
    // Positive and negative control. A scan matching nothing would report an
    // empty unscoped set — the safest-looking possible answer, and wrong.
    const all: string[] = [];
    for (const file of readdirSync(DB).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(resolve(DB, file), 'utf8');
      for (const m of src.matchAll(/\n {2}async (\w+)\(([^)]*)\)/g)) {
        if (/cursor/i.test(m[2] ?? '')) all.push(`${file}:${m[1] ?? ''}`);
      }
    }
    expect(all.length, 'no cursor-taking repo methods found — the scan is broken').toBeGreaterThan(
      5,
    );
    expect(all, 'a known account-scoped cursor listing is missing from the scan').toContain(
      'sessions-repo.ts:listSessions',
    );
    expect(
      unscoped,
      'listSessions filters on accountId and must NOT be classified unscoped',
    ).not.toContain('sessions-repo.ts:listSessions');
  });

  it('CRITICAL no unscoped cursor listing exists that has not been checked', () => {
    const unknown = unscoped.filter((k) => !KNOWN_UNSCOPED.has(k)).sort();
    expect(
      unknown,
      'this repo method paginates by cursor and never filters on an account. If it is a staff ' +
        'surface, add it to KNOWN_UNSCOPED naming the service wrapper that calls ' +
        'throwIfMissingScope. If it is customer-reachable, it reads other tenants’ rows — the ' +
        'cursor guard cannot stop that, because its safety rests on an account filter existing',
    ).toEqual([]);
  });

  it('CRITICAL every recorded entry still names a real unscoped listing', () => {
    // A stale entry claims a listing was reviewed when it no longer exists, or
    // when it has since gained an account filter and needs no exemption.
    const stale = [...KNOWN_UNSCOPED.keys()].filter((k) => !unscoped.includes(k)).sort();
    expect(stale, 'a KNOWN_UNSCOPED entry no longer matches an unscoped cursor listing').toEqual(
      [],
    );
  });

  it.each([...KNOWN_UNSCOPED.entries()])(
    '%s is reached through a wrapper that requires internal-admin',
    (key, { service, wrapper }) => {
      // A LINE WINDOW, not brace matching. Locating the method body by braces
      // took four attempts here and failed three different ways — the first `{`
      // after the name is the interface declaration's parameter type, then the
      // return type `Promise<{ … }>`, then a multi-line `opts: {`. Each was
      // caught by an assertion, but a helper that subtle is a liability in a
      // guard whose job is to be obviously right.
      //
      // These wrappers are uniformly shaped: the scope check is the first
      // statement. Asserting it appears within a few lines of the declaration is
      // cruder and cannot silently read the wrong block.
      const lines = readFileSync(resolve(SERVICES, service), 'utf8').split('\n');
      // Match the IMPLEMENTATION, not the interface: these services declare the
      // repo interface in the same file, and its members are `name(opts: {`
      // while the class methods take ctx first and open the paren at end of line.
      const declAt = lines.findIndex((l) =>
        new RegExp(`^ {2}(?:async )?${wrapper}\\((\\s*$|ctx)`).test(l),
      );
      expect(declAt, `${service} no longer declares a ${wrapper} method`).toBeGreaterThan(-1);
      // Bound the window at the method's OWN closing brace. A fixed 12-line
      // window bled into the next member — `countDlq` follows `listDlq` and
      // carries an identical scope check, so deleting listDlq's gate still
      // "passed". The mutation caught it; a guard for a security property that
      // reads the neighbour's check is worse than none.
      const closeAt = lines.findIndex((l, i) => i > declAt && l === '  }');
      expect(closeAt, `could not find the end of ${wrapper} in ${service}`).toBeGreaterThan(declAt);
      const window = lines.slice(declAt, closeAt).join('\n');
      expect(
        window,
        `${service}:${wrapper} wraps ${key}, which has no account filter, so it is the only thing ` +
          'standing between a caller and every tenant’s rows. The internal-admin scope check must ' +
          'be right at the top of it',
      ).toContain("throwIfMissingScope(ctx, 'driftstack_internal_admin')");
    },
  );
});
