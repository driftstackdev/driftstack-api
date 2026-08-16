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

/** Function bodies, split on their declarations. Cheap, and enough to scope a mint. */
function functionsIn(source: string): string[] {
  const marks = [...source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+\w+/g)].map(
    (m) => m.index,
  );
  return marks.map((start, i) =>
    source.slice(start, i + 1 < marks.length ? marks[i + 1] : source.length),
  );
}

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
    for (const fn of functionsIn(source)) {
      if (!fn.includes('randomBytes(') || !fn.includes('base32Encode(')) continue;
      for (const m of fn.matchAll(/`([a-z][a-z0-9]*_)(?:[a-z0-9]+_)?\$\{/g)) {
        found.set(m[1] ?? '', file.slice(file.lastIndexOf('/') + 1));
      }
    }
  }
  return [...found]
    .map(([prefix, where]) => ({ prefix, where }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/** The redactor's prefixed-secret pattern, as source text. */
function allowlistSource(): string {
  const source = readFileSync(REDACTOR, 'utf-8');
  const decl = source.indexOf('const FREE_TEXT_PREFIXED_SECRET_RE');
  const end = source.indexOf(';', decl);
  return decl === -1 ? '' : source.slice(decl, end);
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
      .filter((m) => !allowlist.includes(m.prefix))
      .map((m) => `${m.prefix} (minted in ${m.where})`)
      .sort();

    expect(
      missing,
      'these are secret by construction and the log redactor does not recognise them, so they reach ' +
        'the log in full — add the prefix to FREE_TEXT_PREFIXED_SECRET_RE',
    ).toEqual([]);
  });
});
