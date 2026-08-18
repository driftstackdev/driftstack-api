// The pair that turns a customer path segment into a database key — `PUBLIC_ID_RE`
// and `uuidFromPrefixedId` — is copied into thirteen and twelve route files.
//
// ⛔⛔ CORRECTION, 2026-08-18, to the version of this file written one fire earlier.
//
// It claimed `admin-status-subscribers.ts` "takes NO expectedPrefix and therefore
// never checks one", and reasoned from that to a cost: `prof_<uuid>` accepted, looked
// up, missed, answered 404 instead of 400. **The premise was false and so was the
// cost.** That file's regex is `/^sub_(<uuid>)$/` — the prefix is pinned IN THE
// REGEX, which is exactly why its function needs no prefix argument. It is the
// STRICTEST of the three copies, not the laxest, and `prof_<uuid>` gets a 400 there
// like everywhere else.
//
// I read one half of a two-part check and drew a conclusion about the whole. The
// original guard then encoded that conclusion as an exemption, which is the failure
// this repo keeps finding in other people's pins — a passing test protecting a false
// claim — authored by me, one commit old.
//
// ── what is actually true, measured ───────────────────────────────────────────
//
// The prefix IS checked by every copy. It is checked in different PLACES:
//
//   x11  `PUBLIC_ID_RE = /^[a-z]{3}_(<uuid>)$/` + `value.startsWith(prefix_)` in the
//        function. Exactly three letters, case-sensitive.
//   x1   profile-snapshots.ts — `/^[a-z]+_(<uuid>)$/i` + the same startsWith. It
//        NEEDS `[a-z]+`: its prefixes are `prof` (4) and `psnap` (5), both of which
//        the canonical `[a-z]{3}` would reject outright.
//   x1   admin-status-subscribers.ts — `/^sub_(<uuid>)$/`, prefix in the regex, so
//        the function takes no prefix argument.
//
// So "count the variants" was never the finding. The property worth guarding is the
// one that would break a route outright: **a file's regex must be able to match
// every prefix that file asks for.** A route whose prefix outgrows its own regex
// cannot accept its own ids at all — every request 400s, on ids the API itself
// issued. Measured today: no file is in that state, and the flexible copy exists
// precisely because `psnap` would have put it there.
//
// The real divergence left is smaller and named below: profile-snapshots.ts is the
// only copy with `/i`, so an uppercase id works there and 400s on the other twelve.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

interface RouteIdParser {
  file: string;
  /** Source text of the `PUBLIC_ID_RE` literal, or null when the file has none. */
  regex: string | null;
  /** Bodies of every `uuidFromPrefixedId` in the file. */
  parsers: string[];
  /** Prefixes the file passes to `uuidFromPrefixedId`. */
  prefixesAsked: string[];
  /** Prefixes the file MINTS, from its `` `xxx_${…}` `` id templates. */
  prefixesMinted: string[];
}

function brace(src: string, from: number): string {
  const open = src.indexOf('{', from);
  if (open === -1) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, k + 1);
    }
  }
  return '';
}

function routeIdParsers(): RouteIdParser[] {
  const out: RouteIdParser[] = [];
  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const rx = /const PUBLIC_ID_RE = (\/.*?\/i?);/.exec(src);
    const parsers = [...src.matchAll(/function uuidFromPrefixedId\(/g)].map((m) =>
      brace(src, m.index + m[0].length),
    );
    if (rx === null && parsers.length === 0) continue;
    out.push({
      file,
      regex: rx?.[1] ?? null,
      parsers,
      prefixesAsked: [
        ...new Set(
          [...src.matchAll(/uuidFromPrefixedId\([^,)]+,\s*'([a-z]+)'/g)].map((m) => m[1] as string),
        ),
      ].sort(),
      prefixesMinted: [
        ...new Set([...src.matchAll(/`([a-z]+)_\$\{/g)].map((m) => m[1] as string)),
      ].sort(),
    });
  }
  return out;
}

/**
 * The regex accepts a prefix of this length, or null when it pins a literal.
 *
 * `[a-z]{3}_` accepts exactly 3; `[a-z]+_` accepts any; `sub_` pins one literal and
 * is handled separately, because "can this regex match that prefix" is then a string
 * comparison rather than a length one.
 */
function acceptsPrefix(regex: string, prefix: string): boolean {
  const literal = /\^([a-z]+)_\(/.exec(regex);
  if (literal !== null) return literal[1] === prefix;
  if (/\^\[a-z\]\+_/.test(regex)) return true;
  const exact = /\^\[a-z\]\{(\d+)\}_/.exec(regex);
  if (exact !== null) return prefix.length === Number(exact[1]);
  return false;
}

/**
 * The one remaining real divergence, named so it is a statement and not a silence.
 *
 * profile-snapshots.ts carries `/i`, so `PROF_<UUID>` parses there and 400s on the
 * other twelve. Left alone rather than tightened: an id the API accepts today cannot
 * start being refused without a deprecation, and Postgres normalises uuid case so the
 * lookup resolves the same row either way. Recorded because "same id, different
 * answer depending on the route" is worth someone deciding on rather than
 * rediscovering.
 */
const KNOWN_CASE_INSENSITIVE = new Set(['profile-snapshots.ts']);

describe('the copied id parsers must agree', () => {
  it('CRITICAL every file’s regex can match every prefix that file asks for. This is the property that breaks a route outright rather than subtly: a prefix that outgrows its own regex means the route cannot accept the ids the API itself issued, and every request 400s. profile-snapshots.ts carries the flexible regex precisely because `psnap` would have put it there.', () => {
    const files = routeIdParsers();
    expect(
      files.length,
      'no route id parsers were found — the scan, not the routes',
    ).toBeGreaterThanOrEqual(10);

    const broken: string[] = [];
    let pairsChecked = 0;
    for (const f of files) {
      if (f.regex === null) continue;
      for (const prefix of f.prefixesAsked) {
        pairsChecked += 1;
        if (!acceptsPrefix(f.regex, prefix))
          broken.push(`${f.file} asks '${prefix}' but ${f.regex}`);
      }
    }
    expect(
      pairsChecked,
      'no (regex, prefix) pairs were compared — the prefix scan matched nothing, so this arm would pass on an empty set',
    ).toBeGreaterThanOrEqual(10);
    expect(broken, 'route file(s) whose regex cannot match a prefix they pass:').toEqual([]);
  });

  it('CRITICAL every file’s regex also accepts every prefix that file MINTS. The round trip: an id the API hands out must be parseable by the route that hands it out. admin-incidents.ts minted `incu_<uuid>` under an exactly-three-letter regex — latent, because nothing parsed one back, and a 400 on the API’s own id the moment something did. This arm is also the only one that can check a file whose prefix lives in the regex rather than in a call, because such a file passes no prefix at all.', () => {
    const files = routeIdParsers();
    const broken: string[] = [];
    let pairsChecked = 0;
    for (const f of files) {
      if (f.regex === null) continue;
      for (const prefix of f.prefixesMinted) {
        pairsChecked += 1;
        if (!acceptsPrefix(f.regex, prefix))
          broken.push(`${f.file} mints '${prefix}_' but ${f.regex} cannot parse it`);
      }
    }
    expect(
      pairsChecked,
      'no (regex, minted prefix) pairs were compared — the mint scan matched nothing, so this arm would pass on an empty set',
    ).toBeGreaterThanOrEqual(15);
    expect(broken, 'route file(s) that mint an id their own regex cannot parse:').toEqual([]);
  });

  it('CRITICAL every copy REFUSES a value that is not a uuid at all. The check that stands between a pasted string and a database key, and the one V-716 found missing elsewhere — a loose id test that let a malformed id become a 500.', () => {
    const files = routeIdParsers();
    const parsers = files.flatMap((f) => f.parsers.map((body) => ({ file: f.file, body })));
    expect(parsers.length, 'no uuidFromPrefixedId copies were found').toBeGreaterThanOrEqual(10);

    expect(
      parsers.filter((p) => !/PUBLIC_ID_RE\.exec\(value\)/.test(p.body)).map((p) => p.file),
      'copies that do not test the value against PUBLIC_ID_RE:',
    ).toEqual([]);
    expect(
      parsers.filter((p) => !/throw new \w*Error/.test(p.body)).map((p) => p.file),
      'copies that accept an unparseable id instead of throwing:',
    ).toEqual([]);
  });

  it('CRITICAL every file pins the prefix SOMEWHERE — in the function or in the regex. The superseded version of this arm looked only in the function and concluded admin-status-subscribers.ts checked nothing; its regex pins `sub_`. Checking both places is what makes the claim true, and what stops a copy that pins it in NEITHER from passing as the third convention.', () => {
    for (const f of routeIdParsers()) {
      if (f.parsers.length === 0) continue;
      const inFunction = f.parsers.some((body) => /value\.startsWith\(/.test(body));
      const inRegex = f.regex !== null && /\^[a-z]+_\(/.test(f.regex);
      expect(
        inFunction || inRegex,
        `${f.file} pins the id prefix neither in uuidFromPrefixedId nor in PUBLIC_ID_RE`,
      ).toBe(true);
    }
  });

  it('only the named copy is case-insensitive. An uppercase id parses on that route and 400s on the other twelve — a small divergence, but "same id, different answer depending on the route" should be somebody’s decision rather than a rediscovery. A NEW copy going case-insensitive is the drift this catches.', () => {
    const unexpected = routeIdParsers()
      .filter((f) => f.regex !== null && f.regex.endsWith('/i'))
      .map((f) => f.file)
      .filter((f) => !KNOWN_CASE_INSENSITIVE.has(f));
    expect(unexpected, 'unexpectedly case-insensitive id regex in:').toEqual([]);
  });

  it('the case-insensitive exemption cannot rot — the file it names must still exist and must still be case-insensitive. An exemption for a copy that was tightened keeps a solved problem on the books and hides the next divergence behind it.', () => {
    const files = routeIdParsers();
    for (const name of KNOWN_CASE_INSENSITIVE) {
      const f = files.find((x) => x.file === name);
      expect(f, `${name} no longer defines PUBLIC_ID_RE`).toBeDefined();
      expect(
        f?.regex?.endsWith('/i'),
        `${name} is no longer case-insensitive — remove it from KNOWN_CASE_INSENSITIVE`,
      ).toBe(true);
    }
  });
});
