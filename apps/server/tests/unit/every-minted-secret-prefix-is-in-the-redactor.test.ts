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
// SECRET BY CONSTRUCTION is the discriminator, and it is what makes this
// checkable at all: a secret is `base32Encode(randomBytes(…))`, while a public
// id is `randomUUID()`. Both mints are function-scoped rather than line-scoped
// because `generateApiKey` splits the two calls across three lines —
// `const buf = randomBytes(…)`, `const body = base32Encode(buf)`, then
// `return \`ds_${env}_${body}\`` — so a single-line pattern sees `gck_` and
// `whsec_` and misses `ds_`, which is the most widely distributed credential of
// the three.
//
// Measured when this landed: 3 mint sites, 3 in the allowlist, 0 missing.
// A regression guard, not a fix.

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
    'BOTH the public OAuth client_id AND the secret authorization code, minted with one prefix in ' +
    'services/oauth.ts. Listed here because no prefix rule can separate them and scrubbing it would ' +
    'blind every OAuth debugging session to the client_id. The real fix is a distinct prefix for the ' +
    'code at its mint site, which changes values already issued.',
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
