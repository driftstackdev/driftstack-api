// Every credential prefix this system MINTS must be one the log redactor
// recognises.
//
// `redactText` scrubs prefixed secrets from free text using an ALLOWLIST —
// `ds_live_`, `ds_test_`, `gck_`, `whsec_`, plus Stripe's `sk_`/`rk_` which
// arrive in upstream error text. The allowlist is the right design and its own
// file says why: this system mints a great many prefixed identifiers (`acc_`,
// `prof_`, `ses_`, `agt_`, `key_`) that are PUBLIC and belong in a log, so a
// generic `word_<random>` rule would scrub the ids people debug with.
//
// The gap is the other direction. `redact-text-scrubs-every-minted-credential-
// shape` checks the shapes it knows about, from a hardcoded list. Nothing
// compares the allowlist against what the code actually mints, so a FOURTH
// secret prefix — a new credential type, minted the same way as the other three
// — would be logged in full and every redaction test would stay green.
//
// The pairing here is DERIVED on both sides: mint sites are found by their
// construction, and the allowlist is read out of the regex source. Adding a
// credential to either side is picked up without editing this file.
//
// CSPRNG-MINTED is the discriminator, and the scan is FILE-scoped. Both of those
// are V-1452 corrections to a narrower first version, and the narrowing was not
// visible from its own output.
//
// It read "a secret is `base32Encode(randomBytes(…))`, a public id is
// `randomUUID()`", and scoped each mint to the enclosing `function` declaration.
// Both were true of the three credentials it knew about and false of OAuth's,
// which mint `randomBytes(32).toString('base64url')` inside CLASS METHODS. Either
// narrowing alone hid all four OAuth prefixes: widening only the encoding still
// found nothing in `services/oauth.ts`, widening only the scope still rejected
// them on the encoding. It reported "3 mint sites, 3 in the allowlist, 0 missing"
// the entire time, and `oas_` and `oat_` were reaching the log in clear.
//
// The cost of the wider scan is that `randomBytes` in a file no longer implies
// the prefix beside it is secret — an order id and an OAuth client_id are both
// CSPRNG-minted and both belong in a log. PUBLIC_PREFIXES carries those with a
// reason each, so the judgement is written down rather than encoded in how narrow
// a regex happens to be. A prefix in neither list fails.
//
// Measured now: 9 minted prefixes — 6 redacted (ds_, gck_, whsec_, oas_, oat_,
// oag_), 3 declared public (ord_, oaa_, oac_).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const REDACTOR = resolve(HERE, '..', '..', 'src', 'lib', 'redact-url.ts');
const ROOTS = [join(REPO, 'apps', 'server', 'src'), join(REPO, 'packages')];

const SKIP_DIR = /^(node_modules|dist|build|coverage|tests?|__tests__|migrations)$/;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (!SKIP_DIR.test(entry)) walk(p, out);
    } else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(p);
    }
  }
}

// The function-body splitter that used to scope each mint is gone with V-1452.
// It read as a cheap way to keep a prefix and its CSPRNG call in the same scope,
// and it was — but it split on `function` declarations only, so a mint inside a
// class method sat in no chunk at all and could not be seen. File scope is
// coarser and cannot be blind in that direction; the cost is that `randomBytes`
// in a file no longer implies the prefix beside it is secret, which is what
// PUBLIC_PREFIXES above now settles explicitly instead of by accident.

/**
 * A file that mints something from a CSPRNG, in any of the encodings this repo
 * uses. `randomUUID()` is deliberately absent: it is the public-id idiom.
 */
const MINTS_A_SECRET = (src: string): boolean =>
  src.includes('randomBytes(') &&
  (src.includes('base32Encode(') ||
    src.includes(".toString('base64url')") ||
    src.includes(".toString('hex')"));

/**
 * Minted prefixes that are PUBLIC, with the reason each is not a secret.
 *
 * Widening the scan the way V-1452 does means `randomBytes` alone no longer
 * implies secrecy, and it does not: an order id and an OAuth client_id are both
 * minted from a CSPRNG and both belong in a log. The original narrow predicate
 * avoided this by accident, at the cost of missing two real credentials.
 *
 * So the guard demands a decision rather than a judgement call: every minted
 * prefix is either in the redactor or written down here with why. A new one is
 * in neither, and fails.
 */
const PUBLIC_PREFIXES: Record<string, string> = {
  ord_: 'crypto order id — appears in receipts and customer-facing order URLs',
  oaa_: 'one-time authorization_id for the consent flow; a handle the consent UI carries, not a bearer credential',
  oac_:
    'OAuth client_id — public by the OAuth spec and the value every debugging session starts from. ' +
    'It also named the authorization CODE until V-1453, which is why the redactor could not scrub ' +
    'the code without blinding logs to the client_id; the code is `oag_` now, so this prefix is ' +
    'unambiguously public.',
};

/**
 * Prefixes of credentials that are secret BY CONSTRUCTION.
 *
 * The head is taken up to the first interpolation, so `ds_${env}_${body}`
 * contributes `ds_` — which is what the allowlist spells as `ds_(?:live|test)_`.
 */
function mintedSecretPrefixes(): Array<{ prefix: string; where: string }> {
  const files: string[] = [];
  for (const root of ROOTS) walk(root, files);
  const found = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    // V-1452 — scoped to the FILE, and the encoding test widened.
    //
    // Both of the previous narrowings were silent, and each hid the same four
    // credentials on its own:
    //
    //   `base32Encode(` required   — OAuth mints `randomBytes(32).toString('base64url')`.
    //                                Same secrecy, different encoding.
    //   function-scoped            — `functionsIn` splits on `function` declarations
    //                                and `services/oauth.ts` mints inside CLASS METHODS,
    //                                so those bodies were never in any chunk.
    //
    // Widening only the first still found nothing in oauth.ts; widening only the
    // second still rejected it on the encoding. Together they surface `oas_`,
    // `oat_`, `oac_` and `oaa_`, of which two were reaching the log in clear.
    if (!MINTS_A_SECRET(source)) continue;
    for (const m of source.matchAll(/`([a-z][a-z0-9]*_)(?:[a-z0-9]+_)?\$\{/g)) {
      found.set(m[1] ?? '', file.slice(file.lastIndexOf('/') + 1));
    }
  }
  return [...found]
    .map(([prefix, where]) => ({ prefix, where }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/** The redactor's prefixed-secret pattern, as source text. */
function allowlistSource(): string {
  const source = readFileSync(REDACTOR, 'utf-8');
  // Spans BOTH prefixed-secret patterns: the OAuth secrets need their own
  // because their base64url bodies carry `-` and `_`, and reading only the first
  // declaration would report oas_/oat_ as missing while they are redacted.
  const parts = ['const FREE_TEXT_PREFIXED_SECRET_RE', 'const FREE_TEXT_OAUTH_SECRET_RE'].map(
    (name) => {
      const decl = source.indexOf(name);
      return decl === -1 ? '' : source.slice(decl, source.indexOf(';', decl));
    },
  );
  return parts.join('\n');
}

describe('every minted secret prefix is in the redactor', () => {
  it('CRITICAL both sides were read and are non-trivial, so an absence is measured against a real set', () => {
    const minted = mintedSecretPrefixes();
    expect(
      minted.length,
      'no secret mint found — the base32Encode(randomBytes()) idiom changed, or the function splitter broke',
    ).toBeGreaterThanOrEqual(3);
    expect(allowlistSource().length, 'the redactor allowlist was not found').toBeGreaterThan(40);
    // The mint scan must reach the multi-line case, not just the inline ones.
    expect(
      minted.map((m) => m.prefix),
      'generateApiKey splits randomBytes and base32Encode across lines; a line-scoped scan misses it',
    ).toContain('ds_');
  });

  // V-1453 — the arm that keeps the collision from coming back.
  //
  // Neither guard above can see it. The shape test's sample is a hardcoded
  // `oag_` literal, so it stays green whatever the mint says; and this file's own
  // census would find `oac_`, look it up in PUBLIC_PREFIXES, and exempt it.
  // Measured: reverting the mint to `oac_` left both passing. So the invariant
  // has to be stated about the two mint SITES rather than about either list.
  it('CRITICAL the OAuth authorization code and the client_id are minted with DIFFERENT prefixes, and only the code is redacted. Sharing one prefix is what made the code unscrubbable — a prefix rule cannot separate a secret from a public id wearing the same one, and the public id is the value every OAuth debugging session starts from.', () => {
    const oauth = readFileSync(resolve(REPO, 'apps/server/src/services/oauth.ts'), 'utf-8');
    const prefixOf = (decl: string): string =>
      new RegExp(`const ${decl} = \`([a-z][a-z0-9]*_)\\$\\{`).exec(oauth)?.[1] ?? '';

    const clientId = prefixOf('client_id');
    const code = prefixOf('code');
    expect(clientId, 'the client_id mint is no longer readable').not.toBe('');
    expect(code, 'the authorization-code mint is no longer readable').not.toBe('');
    expect(
      code,
      'the authorization code shares its prefix with the public client_id again',
    ).not.toBe(clientId);

    const allowlist = allowlistSource();
    expect(
      allowlist.includes(code),
      `the authorization code is minted as ${code} and the redactor does not scrub it`,
    ).toBe(true);
    expect(
      allowlist.includes(clientId),
      `${clientId} is the public client_id and must stay readable in logs — redacting it blinds every OAuth debugging session`,
    ).toBe(false);
  });

  it('CRITICAL a credential minted as base32Encode(randomBytes()) has a prefix the redactor scrubs', () => {
    const allowlist = allowlistSource();
    const missing = mintedSecretPrefixes()
      .filter((m) => !allowlist.includes(m.prefix) && !(m.prefix in PUBLIC_PREFIXES))
      .map((m) => `${m.prefix} (minted in ${m.where})`)
      .sort();

    expect(
      missing,
      'these are secret by construction and the log redactor does not recognise them, so they reach ' +
        'the log in full — add the prefix to FREE_TEXT_PREFIXED_SECRET_RE',
    ).toEqual([]);
  });
});
