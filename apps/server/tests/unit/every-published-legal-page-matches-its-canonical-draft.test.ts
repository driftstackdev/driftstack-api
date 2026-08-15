// A legal document ships twice, and both copies disclose the same things.
//
// `docs/legal/*.md` are the canonical drafts; the marketing site republishes
// them as Astro pages so customers can read them. V-254/V-255 recorded that
// split deliberately, and recorded the contract with it: "both update in
// lockstep… a future content-sync linter could enforce drift detection, but for
// now manual lockstep is fine (low touch frequency)."
//
// That linter was built for the sub-processor table (V-271,
// `scripts/check-subprocessor-mirror.mjs`) and never for the legal pages, so the
// only thing holding four documents in step was someone remembering. Manual
// lockstep has already slipped once: the privacy policy's retention row was
// corrected in one copy first, and the two published versions of that document
// currently differ by 342 lines of wording.
//
// WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It asserts STRUCTURE: the same sections, and for the retention schedule the
// same categories. That is the half where drift is unambiguously a bug — a
// section present in the canonical draft and missing from the published page
// means a disclosure customers never see, and a missing retention category means
// a data class with no stated retention period. Those are compliance facts, not
// style.
//
// It does NOT assert prose equality, and that is a decision rather than an
// omission. The two copies are adapted for their medium on purpose: the Astro
// page carries frontmatter, links resolve as routes (`/legal/dpa/`) instead of
// files (`dpa.md`), and the wording has been edited for a reader rather than a
// reviewer. Forcing byte parity would either break the published pages or
// require rewriting legal prose to satisfy a test — and reconciling the wording
// of a privacy policy is counsel's call, not a guard's.
//
// THE COVERAGE ARM IS THE POINT. A new canonical draft that nobody publishes,
// or a published page whose draft is gone, fails here — the pairing has to be
// stated, so a document cannot quietly exist on one side only. The exclusions
// carry their own justification and expire on their own: if `definitions.md`
// ever gets a published page, the arm asserting it has none fails and the
// exclusion has to be revisited.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DRAFTS = resolve(REPO_ROOT, 'docs/legal');
const PUBLISHED = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');

/**
 * Canonical draft → published page. The names are not mechanically derivable
 * (`acceptable-use-policy` publishes as `aup`), so the pairing is stated — and
 * the coverage arm below makes sure nothing is missing from it.
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['privacy-policy.md', 'privacy.md'],
  ['terms-of-service.md', 'terms.md'],
  ['acceptable-use-policy.md', 'aup.md'],
  ['dpa.md', 'dpa.md'],
];

/** Drafts with no published counterpart, each with the reason it has none. */
const UNPUBLISHED_DRAFTS: Readonly<Record<string, string>> = {
  'README.md': 'index for the drafts folder, not a legal document',
  'changes-log.md': 'revision history of the drafts, not itself a disclosure',
  'definitions.md': 'folded into the published Terms; the site links there for defined terms',
};

const headings = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^#{2,3} /.test(line))
    .map((line) => line.trim());

/** Leading cell of every markdown table row — the retention categories. */
const tableCategories = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^\|\s*[A-Z]/.test(line))
    .map((line) => (line.split('|')[1] ?? '').trim());

describe('every published legal page matches its canonical draft', () => {
  it('CRITICAL every pair actually exists on both sides. The comparisons below read two files each, and a pair naming a missing file would compare empty to empty — reporting perfect agreement between a document and nothing.', () => {
    // MEASURED: 4 pairs — privacy, terms, AUP, DPA.
    expect(PAIRS.length, 'canonical/published pairs').toBeGreaterThanOrEqual(4);
    const missing = PAIRS.flatMap(([draft, page]) => [
      ...(existsSync(resolve(DRAFTS, draft)) ? [] : [`draft missing: ${draft}`]),
      ...(existsSync(resolve(PUBLISHED, page)) ? [] : [`published missing: ${page}`]),
    ]);
    expect(missing, 'files named by a pair but absent:').toEqual([]);
    expect(
      headings(resolve(DRAFTS, 'privacy-policy.md')).length,
      'and the heading reader returns real headings',
    ).toBeGreaterThan(5);
  });

  it('CRITICAL every canonical draft is either published or explicitly not. A legal document that exists on one side only is the failure this pairing is written to catch — a draft nobody published is a disclosure customers cannot read, and it goes unnoticed precisely because nothing points at the gap.', () => {
    const drafts = readdirSync(DRAFTS).filter((f) => f.endsWith('.md'));
    const paired = new Set(PAIRS.map(([draft]) => draft));
    const unaccounted = drafts.filter((f) => !paired.has(f) && !(f in UNPUBLISHED_DRAFTS)).sort();
    expect(unaccounted, 'canonical draft(s) neither published nor explicitly excluded:').toEqual(
      [],
    );
  });

  it('CRITICAL each unpublished draft is still genuinely unpublished. The exclusions above are justified by there being no published page — if one is ever published, the justification is gone and the exclusion has to be revisited rather than silently kept.', () => {
    const wronglyExcluded = Object.keys(UNPUBLISHED_DRAFTS)
      .filter((draft) => existsSync(resolve(PUBLISHED, draft)))
      .sort();
    expect(wronglyExcluded, 'draft(s) excluded as unpublished that ARE published:').toEqual([]);
  });

  it('CRITICAL both copies of each document disclose the same sections. A section in the draft and missing from the published page is a disclosure customers never see — the compliance half of lockstep, as opposed to the wording, which is deliberately allowed to differ.', () => {
    const drifted = PAIRS.filter(([draft, page]) => {
      const a = headings(resolve(DRAFTS, draft));
      const b = headings(resolve(PUBLISHED, page));
      return a.length !== b.length || a.some((h, i) => h !== b[i]);
    }).map(([draft, page]) => `${draft} vs ${page}`);
    expect(drifted, 'document(s) whose published sections differ from the draft:').toEqual([]);
  });

  it('CRITICAL the retention schedule lists the same categories in both copies. A data class present in the draft and missing from the published policy is a category customers are given no retention period for.', () => {
    const a = tableCategories(resolve(DRAFTS, 'privacy-policy.md'));
    const b = tableCategories(resolve(PUBLISHED, 'privacy.md'));
    expect(a.length, 'retention categories found in the draft').toBeGreaterThan(5);
    expect(b, 'published retention categories').toEqual(a);
  });
});
