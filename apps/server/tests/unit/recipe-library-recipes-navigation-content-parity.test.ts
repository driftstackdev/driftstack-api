// W598.A — drift guard for packages/recipe-library/src/recipes/navigation.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/recipes/navigation.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W598.A packages/recipe-library/src/recipes/navigation.ts content parity', () => {
  const body = read(LIB);

  it('V-532.A framing + 2 reference recipes + 3 builder helpers (navigateAndWait + tapAndWait + typeInto) + pure-data-no-runtime-behaviour rationale + V-532.B/.C/.D deferrals pinned', () => {
    expect(body).toMatch(/\/\/ V-532\.A — common navigation flow recipes\./);
    expect(body).toMatch(/First sub-slice of V-532 per the anti-substitution clause\. Ships 2/);
    expect(body).toMatch(
      /\/\/ reference recipes \(search flow \+ paginated listing\) alongside a small/,
    );
    expect(body).toMatch(
      /\/\/ builder helper for constructing common navigation flows programmatically\./,
    );
    expect(body).toMatch(/\/\/ Sub-slices deferred:/);
    expect(body).toMatch(/\/\/\s+- V-532\.B \(later\) — fill-form \+ paginate refinements\./);
    expect(body).toMatch(
      /\/\/\s+- V-532\.C \(later\) — infinite-scroll detection \+ cart \+ checkout\./,
    );
    expect(body).toMatch(/\/\/\s+- V-532\.D \(later\) — multi-step wizard with branch-on-state\./);
    expect(body).toMatch(/\/\/ Recipes are pure data — no runtime behaviour\./);
    expect(body).toMatch(/\/\/ \(MockRecipeRunner \/ real Phase 3 runner\) interprets them\./);
  });

  it('navigateAndWait + tapAndWait + typeInto builder helpers pinned + their inline rationale (initial-load barrier + async-state wait barrier + synchronous-typing no-wait)', () => {
    expect(body).toMatch(
      /\* Build a navigation step \+ a wait-for-load barrier\. Common pattern at/,
    );
    expect(body).toMatch(
      /\* the start of most recipes — every following step needs the page loaded\./,
    );
    expect(body).toMatch(
      /export function navigateAndWait\(url: string, waitForSelector\?: string\): readonly RecipeStep\[\] \{/,
    );
    expect(body).toMatch(
      /const steps: RecipeStep\[\] = \[\{ kind: 'navigate', url, waitUntil: 'load' \}\];/,
    );
    expect(body).toMatch(
      /if \(waitForSelector !== undefined\) \{\s*\n\s*steps\.push\(\{ kind: 'wait', condition: 'selector', value: waitForSelector \}\);\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /\* Build a tap-and-wait pair\. The wait barrier is essential for any tap/,
    );
    expect(body).toMatch(/\* that triggers async page state — without it the recipe races between/);
    expect(body).toMatch(
      /export function tapAndWait\(selector: string, awaitSelector: string\): readonly RecipeStep\[\] \{/,
    );
    expect(body).toMatch(/\* Build a type-into-input step\. Returns a single step rather than an/);
    expect(body).toMatch(
      /\* array \(no implicit wait — typing is synchronous from the recipe's POV\)\./,
    );
    expect(body).toMatch(
      /export function typeInto\(selector: string, text: string\): RecipeStep \{\s*\n\s*return \{ kind: 'type', selector, text \};\s*\n\}/,
    );
  });

  it('buildSearchFlowRecipe (site-agnostic param surface) + SEARCH_FLOW_GENERIC reference (example.com) + buildPaginatedListingRecipe (pageCount>=1; final-page no-tap) + PAGINATED_LISTING_GENERIC (3 pages) + V532A_NAVIGATION_RECIPES catalogue pinned', () => {
    expect(body).toMatch(/^export function buildSearchFlowRecipe\(opts: \{$/m);
    expect(body).toMatch(/searchInputSelector: string;/);
    expect(body).toMatch(/resultsSelector: string;/);
    expect(body).toMatch(/query: string;/);
    expect(body).toMatch(/category: 'search',/);
    expect(body).toMatch(/\{ kind: 'capture', what: 'dom' \}/);
    expect(body).toMatch(/\/\*\* Reference search-flow recipe targeting example\.com\. \*\//);
    expect(body).toMatch(/^export const SEARCH_FLOW_GENERIC: Recipe = buildSearchFlowRecipe\(\{$/m);
    expect(body).toMatch(/id: 'search_flow_generic',/);
    expect(body).toMatch(/searchInputSelector: 'input\[type="search"\]',/);
    expect(body).toMatch(/query: 'driftstack',/);
    expect(body).toMatch(/^export function buildPaginatedListingRecipe\(opts: \{$/m);
    expect(body).toMatch(/\* Useful for recipes that need to enumerate a multi-page listing/);
    expect(body).toMatch(
      /if \(opts\.pageCount < 1\) \{\s*\n\s*throw new Error\('buildPaginatedListingRecipe: pageCount must be >= 1'\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/category: 'pagination',/);
    expect(body).toMatch(
      /^export const PAGINATED_LISTING_GENERIC: Recipe = buildPaginatedListingRecipe\(\{$/m,
    );
    expect(body).toMatch(/pageCount: 3,/);
    expect(body).toMatch(
      /^export const V532A_NAVIGATION_RECIPES: readonly Recipe\[\] = \[\s*\n\s*SEARCH_FLOW_GENERIC,\s*\n\s*PAGINATED_LISTING_GENERIC,\s*\n\];/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
