// A secrecy assertion must name the SECRET, not a public prefix of it.
//
// Three separate instances of one mistake turned up while auditing customer
// docs, and each looked correct in review:
//
//   - `not.toContain('sk-ant')` against a key whose value was
//     `sk-ant-api03-<entropy>`. The prefix is public — it is in Anthropic's own
//     documentation — so a response echoing everything AFTER it satisfies the
//     assertion while leaking the whole secret.
//   - `expect(k.plaintext).toBeUndefined()` on api-key list rows. That is a
//     FIELD-NAME check; the key leaking as `key`, `token` or inside a debug
//     field passes it.
//   - guards asserting a function NAME appears rather than the property that
//     function is supposed to have.
//
// This pins the mechanical half of that family, which is the half a test can
// check: when a test asserts a secret is absent, the asserted string must not
// be a PROPER PREFIX of a secret the same file defines. Measured against the
// existing suite before being written — 56 secrecy absence-assertions, and this
// rule flags exactly one (now fixed) with no false positives.
//
// It cannot catch the field-name or name-not-property variants; those need
// judgement. It catches the one that is decidable, so that variant stops
// recurring.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/**
 * Every root that holds tests which can make a secrecy assertion.
 *
 * `tests/unit` and `scripts/tests` were absent until 2026-08-16, and the corpus
 * outside the scan was LARGER than the corpus inside it — 162 unit files use
 * `.not.toContain(`, several of them on constants named SECRET or TOKEN. The
 * header's "56 secrecy absence-assertions" was therefore a count over two of the
 * four places such an assertion can live.
 *
 * Widening flagged nothing, so no prefix-anchored assertion exists in the new
 * roots today. The point is that one written tomorrow is now covered.
 */
const TEST_ROOTS = [
  'apps/server/tests/integration',
  'apps/server/tests/e2e',
  'apps/server/tests/unit',
  'scripts/tests',
];

/** String constants long enough to plausibly be a credential. */
const SECRET_CONST = /const\s+([A-Za-z_][\w]*)\s*=\s*(?:`|')([^`'\n]{8,})(?:`|')/g;
const ABSENCE = /\.not\.toContain\(\s*'([^']{3,60})'\s*\)/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  asserted: string;
  constName: string;
}

function prefixAnchoredAssertions(): Finding[] {
  const found: Finding[] = [];
  for (const root of TEST_ROOTS) {
    const dir = resolve(REPO_ROOT, root);
    for (const file of tsFilesUnder(dir)) {
      const src = readFileSync(file, 'utf8');
      const consts = new Map<string, string>();
      for (const m of src.matchAll(SECRET_CONST)) consts.set(m[1]!, m[2]!);
      for (const m of src.matchAll(ABSENCE)) {
        const asserted = m[1]!;
        for (const [name, value] of consts) {
          // A proper prefix: the assertion covers only the leading, and often
          // publicly-known, part of a secret this same file uses.
          if (asserted !== value && value.startsWith(asserted)) {
            found.push({
              file: file.slice(REPO_ROOT.length + 1),
              line: src.slice(0, m.index).split('\n').length,
              asserted,
              constName: name,
            });
          }
        }
      }
    }
  }
  return found;
}

describe('secrecy assertions anchor on the secret, not a prefix of it', () => {
  it('CRITICAL the scan finds real absence-assertions to judge. A regex matching nothing would make the check below trivially true, which is the failure mode this whole family is about.', () => {
    let absences = 0;
    for (const root of TEST_ROOTS) {
      for (const file of tsFilesUnder(resolve(REPO_ROOT, root))) {
        absences += [...readFileSync(file, 'utf8').matchAll(ABSENCE)].length;
      }
    }
    expect(
      absences,
      'no `.not.toContain(...)` assertions found — the scan is broken',
    ).toBeGreaterThan(20);
  });

  it('CRITICAL every directory that holds tests is DECLARED, so the scan cannot be narrowed silently', () => {
    // The arm below catches a declared root that went empty (a moved directory).
    // It cannot catch a root being REMOVED from the list — which is exactly the
    // regression that left `tests/unit` outside this guard, and which I verified
    // by re-running the old roots against an injected violation: green.
    //
    // So assert the other direction too: every directory under apps/server/tests
    // that actually holds test files must appear in TEST_ROOTS. Narrowing the
    // list now fails and names the directory it dropped.
    const testsDir = resolve(REPO_ROOT, 'apps/server/tests');
    const holdsTests = readdirSync(testsDir)
      .filter((entry) => statSync(resolve(testsDir, entry)).isDirectory())
      .map((entry) => `apps/server/tests/${entry}`)
      .filter((rel) =>
        tsFilesUnder(resolve(REPO_ROOT, rel)).some((f) => /\.(test|spec)\.ts$/.test(f)),
      );
    for (const rel of holdsTests) {
      expect(
        TEST_ROOTS,
        `${rel} holds tests but is not in TEST_ROOTS — a secrecy assertion there would be unscanned`,
      ).toContain(rel);
    }
    expect(holdsTests.length, 'the directory scan itself found nothing').toBeGreaterThan(1);
  });

  it('CRITICAL every declared root actually contributes, so dropping one cannot go unnoticed', () => {
    // The floor above is a total, and a total cannot tell that a whole root
    // stopped being scanned — which is exactly how `tests/unit` sat outside this
    // guard while contributing more absence-assertions than the roots inside it.
    // Asserting PER ROOT makes a narrowed scan fail with the root's name.
    let totalFiles = 0;
    let totalAbsences = 0;
    for (const root of TEST_ROOTS) {
      const files = tsFilesUnder(resolve(REPO_ROOT, root));
      const absences = files.reduce(
        (n, file) => n + [...readFileSync(file, 'utf8').matchAll(ABSENCE)].length,
        0,
      );
      expect(
        files.length,
        `${root} contributed no test files — is it still a test root?`,
      ).toBeGreaterThan(0);
      expect(
        absences,
        `${root} contributed no absence-assertions — it is in TEST_ROOTS but adds nothing`,
      ).toBeGreaterThan(0);
      totalFiles += files.length;
      totalAbsences += absences;
    }

    // V-1028 — the per-root floors above only ask whether a root still exists.
    // `apps/server/tests/unit` alone holds 1938 files, so a walk that collapsed
    // to one file per root satisfies every assertion in this loop while the
    // absence-scan below examines almost nothing. These are the corpus-wide
    // ratchets; they rise when the suite grows, in the same commit.
    expect(
      totalFiles,
      'test files walked across every root — a collapse here makes the absence scan vacuous',
    ).toBeGreaterThanOrEqual(2300);
    expect(
      totalAbsences,
      'absence-assertions found across every root — the population this guard polices (387 at V-1028; the floor catches collapse, not drift)',
    ).toBeGreaterThanOrEqual(350);
  });

  it('CRITICAL no test asserts a secret is absent using only a PREFIX of that secret. The prefix of a credential is routinely public — `sk-ant-api03-` is in the vendor docs — so such an assertion passes while the entropy leaks.', () => {
    const findings = prefixAnchoredAssertions().map(
      (f) => `${f.file}:${f.line} asserts '${f.asserted}' but ${f.constName} starts with it`,
    );
    expect(
      [...new Set(findings)].sort(),
      'Secrecy assertion(s) anchored on a prefix rather than the secret:',
    ).toEqual([]);
  });
});
