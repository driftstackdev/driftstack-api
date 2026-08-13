// The team-RBAC effective-account header is read in exactly one place.
//
// `X-Driftstack-Account` is how a team member acts on behalf of the owner
// account. Honouring it means answering a request with someone ELSE's data, so
// the membership check that authorises that substitution is the whole security
// property. `lib/effective-account-header.ts` owns the read —
// `readEffectiveAccountHeader` — and every route reaches the acting account
// through the resolver built on it.
//
// That is true today, across eighteen files that mention the header and fifteen
// that act on it, and nothing was checking it stays true. A route that reached
// into `request.headers['x-driftstack-account']` itself and looked the account
// up directly would compile, pass review as "the same thing the others do", and
// serve another account's data without ever consulting team membership. It is
// the privilege-escalation shape, and it is one line away at any time.
//
// The three files that name the header without resolving anything are named
// individually rather than pattern-matched, because each is a different
// deliberate decision and a reader deserves to know which:
//
//   lib/app.ts              the CORS allow-list — the header has to be
//                           permitted before a browser will send it at all
//   lib/openapi.ts          documents it as a request parameter
//   routes/billing-crypto.ts REJECTS it with a 400 rather than ignoring it,
//                           because "silently ignoring it would let a stale or
//                           bypassed dashboard buy for Self while claiming Team
//                           scope" — fail-closed, and the one place where
//                           NOT honouring the header is the security property
//
// `db/schema.ts` mentions it only in prose explaining whose id a column holds,
// so it is matched as a comment rather than exempted as code.
//
// Keyed on the header STRING rather than on a list of files, after the
// constant-time guard next door was found covering five of the fourteen files
// that actually compare secrets. A hardcoded roster describes the moment it was
// written; this describes the property.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

/**
 * The two modules that own the header, and the split between them matters.
 *
 * `lib/effective-account-header.ts` takes the value OFF the request and is the
 * only place allowed to touch `request.headers`. `services/auth.ts` turns that
 * value into an effective account, and it is where the membership check lives —
 * it names the header only in the two error messages it throws (an invalid
 * shape, and an account the caller is not a member of).
 *
 * A first version listed only the reader and this guard immediately reported
 * the resolver as unaccounted for, which is the right outcome: reading and
 * authorising are different jobs and both belong to the invariant.
 */
const OWNERS = new Set(['lib/effective-account-header.ts', 'services/auth.ts']);

/** The module allowed to take the header off the request object. */
const READER = 'lib/effective-account-header.ts';

/**
 * Files that name the header for a reason other than reading it.
 *
 * MEASURED at 3. Each is a distinct deliberate decision, described in the header
 * above; a fourth arriving without explanation is what this guard is for.
 */
const NON_READING_USES = new Set(['lib/app.ts', 'lib/openapi.ts', 'routes/billing-crypto.ts']);

const HEADER = 'x-driftstack-account';

interface Mention {
  file: string;
  line: number;
  code: string;
}

/** Every mention of the header in server source, comments excluded. */
function mentions(): Mention[] {
  const out: Mention[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const rel = full.slice(SERVER_SRC.length + 1);
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.toLowerCase().includes(HEADER)) return;
          const trimmed = line.trim();
          // Prose about the header is not a use of it. Only line comments are
          // stripped, by prefix rather than by a regex over the whole line: a
          // regex that hunts `//` anywhere would also cut a URL in a string.
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return;
          }
          out.push({ file: rel, line: i + 1, code: trimmed.slice(0, 120) });
        });
    }
  };
  walk(SERVER_SRC);
  return out;
}

describe('the effective-account header is read only through its resolver', () => {
  it('CRITICAL the scan found the header where it is known to be. Every assertion below reports an absence, so a scan that matched nothing would report the invariant held while having read no code at all — and this header appears in enough files that finding none is unmistakable.', () => {
    const found = mentions();

    // MEASURED: the owner module plus the three non-reading uses. Floored rather
    // than pinned exactly, because routes legitimately gain and lose mentions.
    expect(found.length, 'non-comment mentions of the header').toBeGreaterThanOrEqual(4);
    for (const owner of OWNERS) {
      expect(
        found.some((m) => m.file === owner),
        `the owning module ${owner} is among them`,
      ).toBe(true);
    }

    // The prose filter, on a case whose answer is not in doubt: schema.ts names
    // the header only in a comment explaining whose id a column holds.
    expect(
      found.some((m) => m.file === 'db/schema.ts'),
      'a comment-only mention is not counted as a use',
    ).toBe(false);
  });

  it('CRITICAL no file takes the header off the request itself. Honouring this header means answering with another account data, so the membership check authorising that substitution is the security property — a route reading `request.headers[...]` directly and looking the account up itself would compile, review cleanly, and skip it.', () => {
    const direct = mentions()
      .filter((m) => m.file !== READER)
      .filter((m) => /headers\s*(\[|\.)/.test(m.code))
      .map((m) => `${m.file}:${String(m.line)}: ${m.code}`);
    expect(direct.sort(), 'file(s) reading the header off the request outside its owner:').toEqual(
      [],
    );
  });

  it('CRITICAL every file naming the header is either the owner or a declared non-reading use. A new one is not necessarily wrong — it is unreviewed, and this is the header where unreviewed and unsafe are hard to tell apart.', () => {
    const unaccounted = [
      ...new Set(
        mentions()
          .map((m) => m.file)
          .filter((f) => !OWNERS.has(f) && !NON_READING_USES.has(f)),
      ),
    ].sort();
    expect(unaccounted, 'file(s) naming the header with no declared reason:').toEqual([]);
  });

  it('CRITICAL the declared non-reading uses still name the header. An exemption whose file has stopped mentioning it is stale, and a list carrying closed items is how the live entries stop being read.', () => {
    const naming = new Set(mentions().map((m) => m.file));
    const stale = [...NON_READING_USES].filter((f) => !naming.has(f)).sort();
    expect(stale, 'declared non-reading use(s) that no longer name the header:').toEqual([]);
  });
});
