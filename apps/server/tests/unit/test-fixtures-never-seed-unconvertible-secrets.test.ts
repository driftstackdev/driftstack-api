// No test fixture may seed a webhook secret the boot migration cannot convert.
//
// `encryptLegacySecrets` sweeps `webhook_endpoints` GLOBALLY for non-v2 secrets
// and calls `convertWebhookSecretToV2` on each. That converter validates the
// plaintext, so a row whose secret is neither a valid `whsec_<32 base32>` nor
// v2-shaped makes it THROW — and because the sweep is global, the throw lands
// on whichever test happened to call it, not on the test that seeded the row.
//
// This was a real intermittent CI failure, open for days. Five real-Postgres
// fixtures seeded `'whsec_test_secret'`, `'whsec_test'` and `'v2:secret'`; the
// webhook-concurrency file failed whenever it ran while one of those rows
// existed. Three plausible hypotheses were investigated and falsified first —
// connection exhaustion, lock contention, poll timing — because the failure
// never named its own cause until a failing run's log was preserved.
//
// A textual guard is the right shape here precisely because the defect is
// textual: these are literals in INSERT statements, and the cost of the bug is
// paid by a different file than the one containing it. A behavioural test
// cannot see it — the seeding file passes either way.
//
// Deliberately narrow. It guards the one column with a demonstrated failure
// rather than every envelope column in the schema, because the storage patterns
// differ per subsystem and a guard asserting rules it has not verified would be
// worse than none. The wider class — nine unwrapped boot migrations that all
// decrypt to validate — is recorded as assessment item 18, which is a founder
// decision about key compartmentalisation rather than a test fix.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = resolve(HERE, '..');

/** `whsec_` + 32 lowercase base32 chars — what the converter accepts. */
const VALID_PLAINTEXT = /^whsec_[a-z2-7]{32}$/;
/** The stored v2 envelope shape; rows matching it are excluded from the sweep. */
const VALID_V2 = /^driftstack:webhook-secret:v2:[A-Za-z0-9+/]{88}$/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Offender {
  readonly file: string;
  readonly literal: string;
}

/**
 * String literals sitting in the `secret` position of an INSERT into
 * `webhook_endpoints`.
 *
 * Column order is read from the statement's own column list rather than
 * assumed, so a fixture that lists columns differently is still checked — and
 * `secret_prefix` (legitimately 12 characters) is never mistaken for `secret`.
 */
/**
 * This file is excluded from its own scan. The parser case below contains a
 * deliberately bad literal as DOCUMENTATION of the shape being rejected, and a
 * guard that flags its own example reports a defect that does not exist —
 * which it did on the first run.
 */
const SELF = 'test-fixtures-never-seed-unconvertible-secrets.test.ts';

/** The parser, over one source text — so a test can drive it with a sample. */
function secretsInSource(src: string, label: string): Offender[] {
  const out: Offender[] = [];
  {
    for (const stmt of src.matchAll(
      /INSERT INTO webhook_endpoints\s*\(([^)]*)\)[\s\S]{0,600}?VALUES\s*\(([\s\S]{0,600}?)\)`/g,
    )) {
      const cols = stmt[1]!.split(',').map((c) => c.trim());
      const idx = cols.indexOf('secret');
      if (idx === -1) continue;
      const values = stmt[2]!.split(',').map((v) => v.trim());
      const raw = values[idx];
      if (raw === undefined) continue;
      const literal = /^'([^']*)'$/.exec(raw)?.[1];
      if (literal === undefined) continue; // interpolated — not a literal to judge
      if (VALID_PLAINTEXT.test(literal) || VALID_V2.test(literal)) continue;
      out.push({ file: label, literal });
    }
  }
  return out;
}

function seededSecrets(): Offender[] {
  return testFiles(TESTS_ROOT)
    .filter((file) => !file.endsWith(SELF))
    .flatMap((file) =>
      secretsInSource(readFileSync(file, 'utf8'), file.slice(TESTS_ROOT.length + 1)),
    );
}

describe('no fixture seeds a webhook secret the global boot migration cannot convert', () => {
  it('CRITICAL the scan actually parses INSERT statements. If the regex stopped matching, the check below would pass on an empty list forever — and the failure it guards is itself "nobody noticed", so a broken scan would hide exactly the same thing twice.', () => {
    let statements = 0;
    for (const file of testFiles(TESTS_ROOT)) {
      statements += [...readFileSync(file, 'utf8').matchAll(/INSERT INTO webhook_endpoints\s*\(/g)]
        .length;
    }
    expect(statements, 'webhook_endpoints INSERT statements found in fixtures').toBeGreaterThan(3);
  });

  it('CRITICAL the parser locates the `secret` column by NAME, not by position. Reading position 3 blindly would judge `secret_prefix` — legitimately 12 characters and never convertible — and report false offenders while missing real ones.', () => {
    const sample = `INSERT INTO webhook_endpoints (id, account_id, url, secret, secret_prefix, events)
        VALUES (\${id}, \${acc}, 'https://x.test/h', 'whsec_test_secret', 'whsec_test', ARRAY[]::x[])\``;
    // Drives the REAL parser rather than re-implementing it inline. An earlier
    // draft parsed the sample with its own copy of the regex, which meant
    // breaking the production lookup — swapping the name search for a fixed
    // index — left this case green. A mirror test asserts the mirror.
    const found = secretsInSource(sample, 'sample');
    expect(
      found.map((o) => o.literal),
      'the secret column is judged',
    ).toEqual(['whsec_test_secret']);

    // Same statement with the columns reordered: a positional parser reads the
    // URL here and reports it as a bad secret, or misses the real one.
    const reordered = `INSERT INTO webhook_endpoints (secret, id, account_id, url, secret_prefix, events)
        VALUES ('whsec_test_secret', \${id}, \${acc}, 'https://x.test/h', 'whsec_test', ARRAY[]::x[])\``;
    expect(
      secretsInSource(reordered, 'reordered').map((o) => o.literal),
      'column order does not change the verdict',
    ).toEqual(['whsec_test_secret']);
  });

  it('CRITICAL every seeded literal secret is convertible or v2-shaped. An unconvertible one makes the GLOBAL sweep throw inside a different test file, which is why this cost days: the failure never appears where the fixture lives.', () => {
    const offenders = seededSecrets()
      .map((o) => `${o.file}: '${o.literal}'`)
      .sort();
    expect(
      offenders,
      'fixture(s) seeding a webhook secret that convertWebhookSecretToV2 will reject — use a valid whsec_<32 base32> plaintext or a v2-shaped value:',
    ).toEqual([]);
  });
});
