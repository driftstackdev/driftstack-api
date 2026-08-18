// `uuidFromPrefixedId` is defined TWELVE times, once per route file, and the
// copies do not all agree.
//
// It is the function that turns a customer-supplied path segment into a database
// key — `whk_<uuid>` → `<uuid>` — so every templated route in the product depends
// on some copy of it. Twelve copies is twelve chances for one to drift, and the
// drift is invisible: each file's own tests pass against its own copy.
//
// Measured 2026-08-18 by normalising whitespace and hashing each body: 12
// definitions, THREE distinct variants.
//
//   x10  the canonical form. Checks the uuid shape AND that the value carries the
//        prefix the route expects, then throws BadRequestError (400,
//        errors.driftstack.dev/bad-request).
//   x1   profile-snapshots.ts — identical except the local is named `m` instead of
//        `match`. Behaviourally the same; it is why "count the variants" is not by
//        itself a finding.
//   x1   admin-status-subscribers.ts — takes NO expectedPrefix and therefore never
//        checks one, and throws ValidationError rather than BadRequestError.
//
// ⚠️ What the odd one actually costs, measured rather than assumed. It accepts
// `prof_<uuid>` or `key_<uuid>` where only `sub_<uuid>` is meaningful, extracts the
// uuid, and looks it up — which misses, so the answer is 404 rather than 400. Not a
// cross-resource read: ids are per-table uuids, so a profile id cannot name a
// subscriber. What it IS: the same customer mistake gets a different problem `type`
// on this route than on the other eleven, and a wrong-prefix id is reported as
// "not found" instead of "you sent the wrong kind of id".
//
// This file does NOT rewrite that route. Changing an admin route's status and
// problem type is a contract change with its own blast radius, and the copies being
// allowed to disagree is the thing worth stopping first. So the invariant asserted
// here is the one every copy already satisfies — reject a value that is not a
// uuid at all — plus a pin on the prefix-checking majority, so a NEW copy cannot
// join the lax side by accident and the divergence cannot grow.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

interface Copy {
  file: string;
  signature: string;
  body: string;
}

/** Every `uuidFromPrefixedId` definition, with its brace-matched body. */
function idParserCopies(): Copy[] {
  const out: Copy[] = [];
  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    for (const m of src.matchAll(/function uuidFromPrefixedId\(/g)) {
      const open = src.indexOf('{', m.index + m[0].length);
      if (open === -1) continue;
      let depth = 0;
      let k = open;
      for (; k < src.length; k++) {
        if (src[k] === '{') depth += 1;
        else if (src[k] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push({
        file,
        signature: src.slice(m.index, open).trim(),
        body: src.slice(open, k + 1),
      });
    }
  }
  return out;
}

/** The lax copy, named so its exemption is a statement rather than a silence. */
const KNOWN_PREFIX_UNCHECKED = new Set(['admin-status-subscribers.ts']);

describe('twelve copies of the id parser must agree', () => {
  it('CRITICAL every copy REFUSES a value that is not a uuid at all. This is the invariant all twelve already satisfy and the one that matters most: it is what stands between a pasted string and a database key, and it is the check V-716 found missing elsewhere — a loose id test that let a malformed id become a 500.', () => {
    const copies = idParserCopies();
    expect(
      copies.length,
      'no id-parser copies were found — the scan, not the routes',
    ).toBeGreaterThanOrEqual(10);

    const permissive = copies.filter((c) => !/PUBLIC_ID_RE\.exec\(value\)/.test(c.body));
    expect(
      permissive.map((c) => c.file),
      'id-parser copies that do not test the value against PUBLIC_ID_RE:',
    ).toEqual([]);

    const noThrow = copies.filter((c) => !/throw new \w*Error/.test(c.body));
    expect(
      noThrow.map((c) => c.file),
      'id-parser copies that accept an unparseable id instead of throwing:',
    ).toEqual([]);
  });

  it('CRITICAL every copy but the one named here also checks the PREFIX, so a wrong-kind id is refused rather than looked up. A copy that skips it reports "not found" for what is actually "wrong sort of id" — and a NEW copy joining the lax side is how one divergence becomes the convention.', () => {
    const copies = idParserCopies();
    const unchecked = copies
      .filter((c) => !/value\.startsWith\(/.test(c.body))
      .map((c) => c.file)
      .filter((f) => !KNOWN_PREFIX_UNCHECKED.has(f));
    expect(
      unchecked,
      'id-parser copies that never check the expected prefix, and are not the known one:',
    ).toEqual([]);
  });

  it('the known-lax list cannot rot — the file it names must still exist and must still be lax. An exemption for a copy that was fixed keeps a solved problem on the books, and one for a file that is gone excuses nothing while hiding the next divergence behind it.', () => {
    const copies = idParserCopies();
    for (const file of KNOWN_PREFIX_UNCHECKED) {
      const found = copies.filter((c) => c.file === file);
      expect(found.length, `${file} no longer defines uuidFromPrefixedId`).toBeGreaterThan(0);
      expect(
        found.some((c) => !/value\.startsWith\(/.test(c.body)),
        `${file} now checks the prefix — remove it from KNOWN_PREFIX_UNCHECKED`,
      ).toBe(true);
    }
  });

  it('CRITICAL the copies collapse to a small, known number of behaviours. Twelve hand-maintained copies of the same function will drift; what makes that survivable is noticing when the count of DISTINCT behaviours grows. Three today: the canonical form, a rename-only twin, and the lax one above.', () => {
    const copies = idParserCopies();
    // Normalise whitespace and local names so a rename does not read as a new
    // behaviour — the profile-snapshots copy differs only by `m` vs `match`, and
    // counting that as drift would train a reader to ignore this arm.
    const shapes = new Set(
      copies.map((c) =>
        `${c.signature} ${c.body}`
          .replace(/\bmatch\b/g, 'm')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    );
    expect(
      [...shapes].length,
      `distinct id-parser behaviours grew past the recorded 2 (rename-normalised). Copies:\n  ${copies
        .map((c) => c.file)
        .join('\n  ')}`,
    ).toBeLessThanOrEqual(2);
  });
});
