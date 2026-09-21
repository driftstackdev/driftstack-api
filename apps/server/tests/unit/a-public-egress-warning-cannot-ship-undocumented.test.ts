// A code a customer can receive in `egress_capabilities.warnings` is documented
// in EVERY place customers read, or this fails.
//
// ⛔ WHY A GUARD AND NOT A CONVENTION. The vocabulary lives in FIVE places by
// necessity: the mapping function produces it, the api-types doc comment is what
// a TypeScript consumer reads on hover, the Zod `.describe()` becomes the
// OpenAPI `description` (rendered reference and committed spec snapshot), the
// generated Pydantic docstring is what a PYTHON consumer reads, and the docs
// page is what a customer finds by searching. Five copies with no guard is five
// copies that drift, and the drift is invisible because each one keeps looking
// complete on its own.
//
// ⚠️ THE FIFTH WAS WRITTEN AS PART OF THE FOURTH AND IS NOT. This header
// originally counted four and folded `models.py` into the OpenAPI bullet, as
// though re-dumping the spec updated it. It does not: the spec dump and the
// codegen are two commands, and only the first of them had a guard. Measured by
// mutation — see `PY_MODELS` below.
//
// ⛔ THE DIRECTION. This asserts vocabulary ⊆ documentation, which is the
// direction that matters: an UNDOCUMENTED public code is a string a customer
// cannot look up. The reverse is asserted too but as a WEAKER arm — documenting
// a code that was removed is untidy rather than dangerous, so it names the
// stragglers instead of failing on the first one.
//
// ⛔ WHOLE-TOKEN MATCHING, NOT `includes`. `safeguard_failed` is a substring of
// `safeguard_failed:direct_internet_block`, so a plain substring search would
// report the bare code as documented by the presence of a longer one — a
// detector whose shape assumption passes on a population it never sees. Every
// check below matches the code INSIDE BACKTICKS, which is how all three
// documents write it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import {
  PUBLIC_EGRESS_WARNINGS,
  PUBLIC_SAFEGUARD_LAYERS,
} from '../../src/services/customer-safe-egress-warnings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const API_TYPES = resolve(REPO_ROOT, 'packages/api-types/src/egress.ts');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md');
const SPEC_SNAPSHOT = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
/**
 * The generated Pydantic model. Its `warnings` docstring is the vocabulary as a
 * PYTHON customer reads it — on hover, and from `help(EgressCapabilities)`.
 *
 * ⛔ IT IS THE ONE COPY NOTHING ELSE HOLDS. Measured by mutation: delete this
 * docstring outright and all twelve guards that read this file stay green —
 * `sdk-python-openapi-snapshot-sync` compares the committed spec to the LIVE
 * spec and never opens models.py, and the two `sdk-python-models-*` guards
 * match field DECLARATIONS, not descriptions. So the chain
 * Zod `.describe()` → openapi.json → models.py is guarded on its first hop and
 * not its second, and the way it breaks is mundane: someone adds a code, fixes
 * the four places this file already named, re-runs `sdk:python:dump-spec`, and
 * does not re-run the codegen. The spec and the SDK then disagree with nothing
 * to say so.
 */
const PY_MODELS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py');
/** This repo's public API changelog — where a renamed code is announced. */
const CHANGELOG = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The code as all three documents write it: inside backticks, whole. */
function documents(text: string, code: string): boolean {
  return text.includes(`\`${code}\``);
}

/**
 * Every `description` string the published document attaches to a `warnings`
 * property, found by walking rather than by naming a path: the field appears on
 * seven operations and two component schemas today, and a hand-written path
 * would go stale the moment an eighth is added.
 */
function warningsDescriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) warningsDescriptions(item, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      key === 'warnings' &&
      value !== null &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).description === 'string'
    ) {
      out.push((value as Record<string, unknown>).description as string);
    }
    warningsDescriptions(value, out);
  }
  return out;
}

describe('every published egress warning code is documented where customers read', () => {
  const apiTypes = read(API_TYPES);
  const docsPage = read(DOCS_PAGE);

  it('POSITIVE CONTROL — the three sources were really read and really contain the field', () => {
    expect(PUBLIC_EGRESS_WARNINGS.length).toBeGreaterThanOrEqual(10);
    expect(apiTypes).toContain('EgressCapabilitiesSchema');
    expect(apiTypes).toContain('EGRESS_WARNINGS_DESCRIPTION');
    expect(docsPage).toContain('`egress_capabilities.warnings`');
    // A control on the matcher itself: a code that does NOT exist must not be
    // reported as documented, or every arm below is vacuous.
    expect(documents(apiTypes, 'not_a_real_warning_code')).toBe(false);
    expect(documents(docsPage, 'not_a_real_warning_code')).toBe(false);
  });

  it('CRITICAL the api-types doc comment documents every public code', () => {
    const missing = PUBLIC_EGRESS_WARNINGS.filter((code) => !documents(apiTypes, code));
    expect(missing, 'undocumented in packages/api-types/src/egress.ts').toEqual([]);
  });

  it('CRITICAL the customer docs page documents every public code', () => {
    const missing = PUBLIC_EGRESS_WARNINGS.filter((code) => !documents(docsPage, code));
    expect(missing, 'undocumented in apps/docs/src/pages/api/sessions.md').toEqual([]);
  });

  it('CRITICAL the LIVE OpenAPI description documents every public code, on every operation that carries the field', () => {
    const descriptions = warningsDescriptions(generateOpenApiSpec());
    // The field is on seven documented operations/schemas; fewer than two would
    // mean the walk stopped matching and the arm below proves nothing.
    expect(descriptions.length, 'no warnings description found in the built spec').toBeGreaterThan(
      1,
    );
    for (const description of descriptions) {
      const missing = PUBLIC_EGRESS_WARNINGS.filter((code) => !documents(description, code));
      expect(missing, 'undocumented in the generated OpenAPI description').toEqual([]);
    }
  });

  it('CRITICAL the COMMITTED spec snapshot carries the same description — a stale snapshot is what the SDKs are generated from', () => {
    const descriptions = warningsDescriptions(JSON.parse(read(SPEC_SNAPSHOT)));
    expect(descriptions.length).toBeGreaterThan(1);
    for (const description of descriptions) {
      const missing = PUBLIC_EGRESS_WARNINGS.filter((code) => !documents(description, code));
      expect(
        missing,
        'undocumented in packages/sdk-python/openapi.json — re-run `npm run sdk:python:dump-spec`',
      ).toEqual([]);
    }
  });

  it('the documentation advertises no code the function cannot produce (weak direction — names stragglers)', () => {
    // Every code written in the docs page's WARNINGS SECTION must be
    // producible. A doc-only code sends a customer looking for a branch that
    // never fires.
    //
    // ⚠️ SCOPED TO THE SECTION, deliberately. Scanning the whole page picks up
    // backticked words from unrelated prose (`dns` in the proxy-settings
    // section was the first false positive), which is a detector reporting a
    // finding about a population it was never pointed at.
    const sectionStart = docsPage.indexOf('### `egress_capabilities.warnings`');
    expect(sectionStart, 'the warnings section heading moved').toBeGreaterThan(-1);
    const afterStart = docsPage.slice(sectionStart + 1);
    const sectionEnd = afterStart.indexOf('\n## ');
    const section = sectionEnd === -1 ? afterStart : afterStart.slice(0, sectionEnd);
    // The table's FIRST COLUMN is the published list; prose in the same section
    // legitimately names the field itself (`egress_capabilities`), which is not
    // a code.
    const advertised = new Set(
      // \s around the cell, not a single space: prettier pads markdown table
      // cells to a common width, so a literal-space pattern matches until the
      // next time the file is formatted and then silently matches nothing.
      [...section.matchAll(/^\|\s*`([a-z0-9_]+(?::[a-z0-9_]+)?)`\s*\|/gm)].map(
        (m) => m[1] as string,
      ),
    );
    // `safeguard_failed` alone appears in prose about the prefix; that is the
    // bare code and it IS producible, so nothing is excluded here.
    const orphans = [...advertised].filter((code) => !PUBLIC_EGRESS_WARNINGS.includes(code));
    expect(advertised.size, 'the docs-page scan matched nothing').toBeGreaterThan(5);
    expect(orphans, 'the docs page advertises a code the mapper cannot produce').toEqual([]);
  });

  it('CRITICAL no published layer word names an internal mechanism', () => {
    // The customer-copy rule of this product: say WHAT, never HOW. A layer word
    // is a published string, so it is held to it here rather than in review.
    const forbidden = [
      'fleet',
      'node',
      'harness',
      'control_plane',
      'observer',
      'vantage',
      'interpose',
      'webkit',
      'dyld',
      'pf_',
      'tcc',
      'spawn',
      'founder',
      'undetectable',
    ];
    for (const [internal, word] of Object.entries(PUBLIC_SAFEGUARD_LAYERS)) {
      for (const term of forbidden) {
        expect(word, `the customer word for ${internal} says HOW`).not.toContain(term);
      }
      // And it is not simply the internal name passed through.
      expect(word, `${internal} was published under its internal name`).not.toBe(internal);
    }
    for (const code of PUBLIC_EGRESS_WARNINGS) {
      for (const term of forbidden) {
        expect(code, `the public code ${code} says HOW`).not.toContain(term);
      }
    }
  });

  it('CRITICAL the GENERATED Python model documents every public code — the chain Zod .describe() → openapi.json → models.py is guarded on its first hop and this is the second', () => {
    const models = read(PY_MODELS);
    const start = models.indexOf('class EgressCapabilities(BaseModel):');
    expect(start, 'the EgressCapabilities model was renamed or removed').toBeGreaterThan(-1);
    const after = models.slice(start);
    const end = after.indexOf('\nclass ', 1);
    const block = end === -1 ? after : after.slice(0, end);

    // POSITIVE CONTROL on the slice, in the same breath: an arm that reads an
    // empty block passes every containment check it makes.
    expect(block, 'the sliced block does not carry the field').toContain('warnings:');
    expect(documents(block, 'not_a_real_warning_code')).toBe(false);

    const missing = PUBLIC_EGRESS_WARNINGS.filter((code) => !documents(block, code));
    expect(
      missing,
      'undocumented in the generated Pydantic docstring — re-run ' +
        '`bash packages/sdk-python/scripts/generate.sh` after `npm run sdk:python:dump-spec`',
    ).toEqual([]);
  });

  it('CRITICAL the customer PROSE that documents these codes says WHAT, never HOW — the vocabulary arm above holds the codes, and a code is not where this rule is most easily broken', () => {
    // ⛔ WHY THE PROSE AND NOT ONLY THE CODES. A rename has to be ANNOUNCED,
    // and the natural way to announce one is to print the old string — which
    // is precisely the string that was renamed for naming an internal
    // mechanism. Nothing else in this repo scans marketing or docs prose for
    // internal vocabulary: `scripts/scan-shipped-text.mjs` covers the four
    // published SDK packages only, and it reads `packages/*/dist`, where
    // `removeComments` has already dropped every line comment.
    //
    // ⚠️ WORD-BOUNDED, and narrower than the code list above. `node` and
    // `spawn` are substring rules that are safe against a lowercase code token
    // and would misfire on prose ("Node.js", "spawn a session"), so they are
    // not here. Every word below has no legitimate customer-facing sense in
    // this product.
    const internalWords: readonly (readonly [string, RegExp])[] = [
      ['harness', /\bharness(?:es|ed|ing)?\b/i],
      ['fleet', /\bfleets?\b/i],
      ['control plane', /\bcontrol[- ]planes?\b/i],
      ['observer', /\bobservers?\b/i],
      ['vantage', /\bvantages?\b/i],
      ['interpose', /interpos\w*/i],
      ['dyld', /\bdyld\b/i],
      ['founder', /\bfounders?\b/i],
      ['undetectable', /\bundetectable\b/i],
    ];

    // POSITIVE CONTROL on the matcher, before it is trusted over real files:
    // a scan that matches nothing reports every page clean.
    const fixture = 'sent as `h3_interpose_unavailable` by the harness';
    expect(
      internalWords.filter(([, re]) => re.test(fixture)).map(([w]) => w),
      'the matcher does not fire on text that plainly breaks the rule',
    ).toEqual(['harness', 'interpose']);

    // ⚠️ SCOPED, per surface, to what actually reaches a customer.
    // api-types: the whole FILE carries internal `//` comments that are
    // correct where they are and never ship (`removeComments` in
    // tsconfig.dist-js.json, and no `sourcesContent` in the maps). What does
    // ship is the description constant and the doc comment attached to the
    // exported schema — the `.d.ts` a consumer reads on hover carries the
    // latter. Both live between these two anchors.
    const apiTypesStart = apiTypes.indexOf('const EGRESS_WARNINGS_DESCRIPTION');
    const apiTypesEnd = apiTypes.indexOf('export type EgressCapabilities');
    expect(apiTypesStart, 'the description constant moved').toBeGreaterThan(-1);
    expect(apiTypesEnd, 'the exported type moved').toBeGreaterThan(apiTypesStart);

    const surfaces: readonly (readonly [string, string])[] = [
      [
        'packages/api-types/src/egress.ts (shipped description + doc comment)',
        apiTypes.slice(apiTypesStart, apiTypesEnd),
      ],
      ['apps/docs/src/pages/api/sessions.md', docsPage],
      ['apps/marketing-site/src/pages/docs/api-changelog.astro', read(CHANGELOG)],
    ];

    const violations: string[] = [];
    for (const [name, text] of surfaces) {
      expect(text.length, `${name} read as empty`).toBeGreaterThan(200);
      for (const [word, re] of internalWords) {
        if (re.test(text)) violations.push(`${name}: "${word}"`);
      }
    }
    expect(
      violations,
      'customer-facing text names an internal mechanism. Say WHAT the customer can see, ' +
        'not HOW it is built — describe the old code rather than printing it',
    ).toEqual([]);
  });
});
