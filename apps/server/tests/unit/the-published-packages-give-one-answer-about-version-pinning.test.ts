// Six published documents, one answer about version pinning.
//
// ⛔ WHAT THIS REPLACED. On 2026-09-20 a customer reading our own pages was
// told four different things by four documents they would plausibly read in
// the same afternoon:
//
//   packages/sdk-typescript/README.md  "Don't pin against an exact version yet."
//   packages/api-types/README.md       "Pin an exact package version in production"
//                                      — and again under ## Versioning.
//   apps/docs/.../sdk/installation.md  "Don't pin to an exact version yet."
//   apps/docs/.../sdk/versioning.md    "Production deployments SHOULD pin exact
//                                      versions" — three paragraphs below its own
//                                      caret / compatible-release / go.mod
//                                      recommendations, which say otherwise.
//
// Every one of those sentences was held in place by a content-parity guard, so
// the contradiction was not merely tolerated: it was MANDATORY in four places
// at once, and no guard read more than one document.
//
// THE ANSWER, and it is the same fact in every ecosystem's terms: while a
// package is `0.x`, a MINOR version may change the surface and a PATCH never
// does. So the ordinary install is already the right one — npm's default caret
// range resolves to patch releases only for a 0.x package, pip's `~=0.2.0`
// compatible-release specifier stops before the next minor, and the version
// `go get` writes into go.mod does not move until `go get -u`. Read the
// changelog before a new minor. Pin exactly only for a byte-for-byte
// reproducible build, which a lockfile already gives you.
//
// THIS GUARD READS ALL SIX. A per-document guard cannot see a contradiction
// between documents — that is why four of them could each be green.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Every document that TELLS A CUSTOMER how to depend on a Driftstack package.
 * Four ship inside the packages themselves (npm and PyPI render the README, and
 * pkg.go.dev renders the Go one); two are pages on docs.driftstack.io.
 */
const DOCUMENTS = [
  'packages/sdk-typescript/README.md',
  'packages/api-types/README.md',
  'packages/sdk-python/README.md',
  'packages/sdk-go/README.md',
  'apps/docs/src/pages/sdk/installation.md',
  'apps/docs/src/pages/sdk/versioning.md',
  // Not published, but it is the internal SOURCE the versioning page above is
  // derived from: left saying "SHOULD pin exact versions", it would carry the
  // contradiction back the next time someone syncs the two.
  'docs/architecture/sdk-versioning.md',
] as const;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/**
 * `text` with fenced code blocks removed and every run of whitespace collapsed,
 * so a sentence that a markdown hard-wrap split across three lines is ONE
 * string here.
 *
 * ⛔ THE WRAP IS THE WHOLE DIFFICULTY. A line-by-line scan of these files finds
 * "Pin an exact version only if you need a byte-for-byte" on one line and
 * "reproducible build" on the next, reads the first as an unconditional
 * instruction, and reports a document that says exactly the right thing. Code
 * fences go because an install command legitimately contains a version.
 */
export function prose(text: string): string {
  return text
    .replace(/^```[\s\S]*?^```/gmu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The sentences of `text`, after `prose()`. */
export function sentences(text: string): string[] {
  return prose(text)
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export interface Contradiction {
  kind: 'exact-pin-as-default' | 'told-not-to-pin';
  sentence: string;
}

/**
 * The sentences of `text` that give the retired advice.
 *
 * `exact-pin-as-default` — a sentence that tells the reader to pin exactly
 * WITHOUT a condition. "Pin an exact version only if you need a reproducible
 * build" is the guidance and is allowed; "Pin an exact version in production"
 * is the contradiction. The difference is the condition, so the condition is
 * what is looked for.
 *
 * `told-not-to-pin` — "don't pin", "do not pin", "never pin". Allowed nowhere:
 * a lockfile IS a pin, and telling a reader not to pin reads as advice against
 * reproducible builds.
 */
export function pinContradictions(text: string): Contradiction[] {
  const out: Contradiction[] = [];
  for (const sentence of sentences(text)) {
    if (/\b(?:don'?t|do not|never)\s+pin\b/iu.test(sentence)) {
      out.push({ kind: 'told-not-to-pin', sentence });
      continue;
    }
    const exact =
      /\bpin(?:ning|s|ned)?\b[^.]{0,60}?\bexact\b/iu.test(sentence) ||
      /\bexact\b[^.]{0,30}?\bpin(?:ning|s|ned)?\b/iu.test(sentence);
    if (!exact) continue;
    const conditional = /\bonly if\b|\bonly when\b|\bif you need\b|\bwhen you need\b/iu.test(
      sentence,
    );
    if (!conditional) out.push({ kind: 'exact-pin-as-default', sentence });
  }
  return out;
}

/** The one rule every document has to state, in whatever case it prefers. */
const THE_RULE = /minor version (?:can|may) change the surface and a patch never does/iu;

describe('the published packages give one answer about version pinning', () => {
  it('every document this guard claims to read is actually there — a missing path would make the scan below read nothing and report a clean sweep', () => {
    for (const doc of DOCUMENTS) {
      expect(existsSync(resolve(REPO_ROOT, doc)), `${doc} is gone or moved`).toBe(true);
      expect(
        prose(read(doc)).length,
        `${doc} is empty after stripping code fences`,
      ).toBeGreaterThan(500);
    }
  });

  it('CRITICAL no published document tells a reader to pin exactly as the default, or not to pin at all. Four of them did on 2026-09-20, each held there by its own content-parity guard, and none of those guards could see the other three', () => {
    const offenders: string[] = [];
    for (const doc of DOCUMENTS) {
      for (const c of pinContradictions(read(doc))) {
        offenders.push(`${doc}  [${c.kind}]  ${c.sentence.slice(0, 160)}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('CRITICAL every published document STATES the rule, so the arm above cannot be satisfied by saying nothing about versions at all — silence and agreement look identical to a detector that only forbids', () => {
    const silent = DOCUMENTS.filter((doc) => !THE_RULE.test(prose(read(doc))));
    expect(
      silent,
      `these documents no longer tell the reader what 0.x means: ${silent.join(', ')}`,
    ).toEqual([]);
  });

  it("CRITICAL each document says it in ITS OWN ecosystem's terms. One answer is not one sentence copied four times: an npm reader needs to know what a caret does for a 0.x package, a pip reader needs the compatible-release specifier, and a Go reader needs that go.mod does not move on its own", () => {
    const npmDocs = ['packages/sdk-typescript/README.md', 'packages/api-types/README.md'];
    for (const doc of npmDocs) {
      expect(prose(read(doc)), `${doc} does not explain the caret range`).toMatch(
        /caret[^.]{0,80}patch releases only/iu,
      );
    }
    expect(
      prose(read('packages/sdk-python/README.md')),
      'the Python README does not name the compatible-release specifier',
    ).toMatch(/compatible-release specifier `driftstack-sdk~=/u);
    expect(
      prose(read('packages/sdk-go/README.md')),
      'the Go README does not say that go.mod holds the version still',
    ).toMatch(/does not move until you run `go get -u`/u);

    const install = prose(read('apps/docs/src/pages/sdk/installation.md'));
    expect(install, 'the install page lost the npm answer').toMatch(/caret range/iu);
    expect(install, 'the install page lost the pip answer').toMatch(
      /compatible-release specifier/iu,
    );
    expect(install, 'the install page lost the Go answer').toMatch(/`go get -u`/u);
  });

  it('CRITICAL the escape hatch keeps its condition and names what actually makes a build reproducible. "Pin an exact version" with no reason attached is the advice this replaced; with "only if you need a byte-for-byte reproducible build" it is the same advice the lockfile paragraph gives', () => {
    for (const doc of DOCUMENTS) {
      const p = prose(read(doc));
      expect(p, `${doc} no longer says what reproducibility costs or who already has it`).toMatch(
        /reproducible build|reproducible, so there is nothing further to pin/iu,
      );
    }
  });

  // ── NEGATIVE CONTROLS ──────────────────────────────────────────────────
  //
  // Every arm above is a "nothing bad is present" claim, and that is exactly
  // what a detector matching nothing reports. These put the retired sentences
  // back — the REAL ones, verbatim from the files as they stood on 2026-09-20 —
  // and require each to be caught.

  it('NEGATIVE CONTROL the detector catches all four sentences this change removed, verbatim', () => {
    const retired = [
      "> **Status:** pre-1.0. Stable surface for the API contract; the SDK API may shift before 1.0. Don't pin against an exact version yet.",
      '> **Status:** pre-1.0. Pin an exact package version in production; all supported schemas and compatibility rules are documented below.',
      "**Status:** published on npm. Pre-1.0 — the API contract is stable but the SDK shape may shift before `1.0`. Don't pin to an exact version yet.",
      'Production deployments SHOULD pin exact versions\n(`"@driftstack/sdk": "0.2.0"`) and bump deliberately.',
      "`0.x.y` follows SemVer's pre-1.0 rules: breaking changes use a minor version and compatible fixes use a patch version. Pin an exact version in production and review the changelog before upgrading.",
    ];
    for (const sentence of retired) {
      expect(
        pinContradictions(sentence).length,
        `the detector does not catch: ${sentence.slice(0, 80)}`,
      ).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE CONTROL the detector does NOT catch the guidance that replaced them, including across a markdown hard-wrap — a detector that reports the right answer as a finding is a detector nobody can keep green', () => {
    const wrapped =
      'Read the [CHANGELOG](CHANGELOG.md) before moving to a new\nminor. Pin an exact version only if you need a byte-for-byte reproducible\nbuild, and note that your lockfile already gives you one.';
    expect(pinContradictions(wrapped)).toEqual([]);
    expect(
      pinContradictions(
        'Pin an exact version only when you need a byte-for-byte reproducible build.',
      ),
    ).toEqual([]);
    expect(pinContradictions('Commit `go.mod` and `go.sum` for reproducible deployments.')).toEqual(
      [],
    );

    // And the wrap really is what makes it hard, shown rather than asserted:
    // a naive line-by-line version of the same detector STRANDS the condition
    // on the next line and reports the correct guidance as a finding. This is
    // the false positive prose() exists to prevent, and a detector that cried
    // wolf here is one a future editor would delete.
    const hardCase =
      'Read the changelog before a new minor. Pin an exact version\nonly if you need a byte-for-byte reproducible build.';
    const lineByLine = hardCase.split('\n').flatMap((line) => pinContradictions(line));
    expect(
      lineByLine.map((c) => c.kind),
      'the naive line scan no longer strands the condition — re-derive this control rather than deleting it',
    ).toEqual(['exact-pin-as-default']);
    expect(pinContradictions(hardCase), 'prose() must join the wrap back together').toEqual([]);
  });

  it('NEGATIVE CONTROL the rule check discriminates: it passes on the sentence the documents carry and fails on a document that merely mentions versions', () => {
    expect(
      THE_RULE.test(
        'While the SDK is `0.x`, a minor version can change the surface and a patch never does.',
      ),
    ).toBe(true);
    expect(
      THE_RULE.test(
        'while a package is `0.x`, a MINOR version can change the surface and a PATCH never does',
      ),
    ).toBe(true);
    expect(THE_RULE.test('This package follows SemVer. See the CHANGELOG for details.')).toBe(
      false,
    );
  });

  // ── THE OTHER FILES THAT SHIP ──────────────────────────────────────────
  //
  // ⛔ THE ROSTER ABOVE IS NOT THE WHOLE PUBLISHED SURFACE. Three CHANGELOGs
  // travel to customers too, and each one already talks about version ranges:
  //
  //   packages/sdk-typescript/CHANGELOG.md  — `files` carries it into the npm
  //                                           tarball (measured: 10 files, it
  //                                           is one of them)
  //   packages/sdk-python/CHANGELOG.md      — `[tool.hatch.build.targets.sdist]
  //                                           include` carries it into the
  //                                           sdist
  //   packages/sdk-go/CHANGELOG.md          — tracked under packages/sdk-go, so
  //                                           it is in the module zip
  //
  // They are held to the FORBID half only. A changelog is a history, not a
  // guidance page: requiring it to state the 0.x rule would be requiring it to
  // repeat the README, and an arm nobody can satisfy honestly gets deleted. But
  // a changelog entry that tells a reader to pin exactly contradicts the
  // README in the same tarball, which is the whole failure this file exists
  // for — and no guard above would see it.
  it('CRITICAL the CHANGELOGs that ship inside the packages do not contradict the READMEs beside them. A customer reads the changelog before a new minor because every one of those READMEs now tells them to', () => {
    const SHIPPED_CHANGELOGS = [
      'packages/sdk-typescript/CHANGELOG.md',
      'packages/sdk-python/CHANGELOG.md',
      'packages/sdk-go/CHANGELOG.md',
    ];
    const offenders: string[] = [];
    for (const doc of SHIPPED_CHANGELOGS) {
      expect(
        existsSync(resolve(REPO_ROOT, doc)),
        `${doc} is gone or moved — the scan below would read nothing and report a clean sweep`,
      ).toBe(true);
      const text = read(doc);
      expect(prose(text).length, `${doc} is empty after stripping code fences`).toBeGreaterThan(
        500,
      );
      for (const c of pinContradictions(text))
        offenders.push(`${doc}  [${c.kind}]  ${c.sentence.slice(0, 160)}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
