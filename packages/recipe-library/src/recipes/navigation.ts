// V-532.A — common navigation flow recipes.
//
// First sub-slice of V-532 per the anti-substitution clause. Ships 2
// reference recipes (search flow + paginated listing) alongside a small
// builder helper for constructing common navigation flows programmatically.
//
// Sub-slices deferred:
//   - V-532.B (later) — fill-form + paginate refinements.
//   - V-532.C (later) — infinite-scroll detection + cart + checkout.
//   - V-532.D (later) — multi-step wizard with branch-on-state.
//
// Recipes are pure data — no runtime behaviour. The runner
// (MockRecipeRunner / real Phase 3 runner) interprets them.

import type { Recipe, RecipeStep } from '../types.js';

/**
 * Build a navigation step + a wait-for-load barrier. Common pattern at
 * the start of most recipes — every following step needs the page loaded.
 */
export function navigateAndWait(url: string, waitForSelector?: string): readonly RecipeStep[] {
  const steps: RecipeStep[] = [{ kind: 'navigate', url, waitUntil: 'load' }];
  if (waitForSelector !== undefined) {
    steps.push({ kind: 'wait', condition: 'selector', value: waitForSelector });
  }
  return steps;
}

/**
 * Build a tap-and-wait pair. The wait barrier is essential for any tap
 * that triggers async page state — without it the recipe races between
 * tap and the next step's selector becoming present.
 */
export function tapAndWait(selector: string, awaitSelector: string): readonly RecipeStep[] {
  return [
    { kind: 'tap', selector },
    { kind: 'wait', condition: 'selector', value: awaitSelector },
  ];
}

/**
 * Build a type-into-input step. Returns a single step rather than an
 * array (no implicit wait — typing is synchronous from the recipe's POV).
 */
export function typeInto(selector: string, text: string): RecipeStep {
  return { kind: 'type', selector, text };
}

// ────────────────────────────────────────────────────────────────────
// Recipe: search flow
// ────────────────────────────────────────────────────────────────────

/**
 * Build a generic search-flow recipe. Navigates to `siteUrl`, focuses the
 * search input, types the query, submits, waits for results, captures.
 *
 * Selectors are passed in — recipe is site-agnostic. Caller supplies the
 * site's search-box / submit / results selectors.
 */
export function buildSearchFlowRecipe(opts: {
  id: string;
  name: string;
  siteUrl: string;
  searchInputSelector: string;
  submitSelector: string;
  resultsSelector: string;
  query: string;
}): Recipe {
  return {
    id: opts.id,
    name: opts.name,
    category: 'search',
    steps: [
      ...navigateAndWait(opts.siteUrl, opts.searchInputSelector),
      typeInto(opts.searchInputSelector, opts.query),
      ...tapAndWait(opts.submitSelector, opts.resultsSelector),
      { kind: 'capture', what: 'dom' },
    ],
  };
}

/** Reference search-flow recipe targeting example.com. */
export const SEARCH_FLOW_GENERIC: Recipe = buildSearchFlowRecipe({
  id: 'search_flow_generic',
  name: 'Generic search flow (demo)',
  siteUrl: 'https://example.com',
  searchInputSelector: 'input[type="search"]',
  submitSelector: 'button[type="submit"]',
  resultsSelector: '.search-results',
  query: 'driftstack',
});

// ────────────────────────────────────────────────────────────────────
// Recipe: paginated listing
// ────────────────────────────────────────────────────────────────────

/**
 * Build a paginated-listing recipe. Navigates, captures the first page,
 * then taps the next-page link N-1 more times, capturing each page.
 *
 * Useful for recipes that need to enumerate a multi-page listing
 * (search results, product catalogue, etc.).
 */
export function buildPaginatedListingRecipe(opts: {
  id: string;
  name: string;
  siteUrl: string;
  resultsSelector: string;
  nextPageSelector: string;
  pageCount: number;
}): Recipe {
  if (opts.pageCount < 1) {
    throw new Error('buildPaginatedListingRecipe: pageCount must be >= 1');
  }
  const steps: RecipeStep[] = [...navigateAndWait(opts.siteUrl, opts.resultsSelector)];

  for (let i = 0; i < opts.pageCount; i += 1) {
    steps.push({ kind: 'capture', what: 'dom' });
    if (i < opts.pageCount - 1) {
      steps.push(...tapAndWait(opts.nextPageSelector, opts.resultsSelector));
    }
  }

  return {
    id: opts.id,
    name: opts.name,
    category: 'pagination',
    steps,
  };
}

/** Reference paginated-listing recipe (3 pages). */
export const PAGINATED_LISTING_GENERIC: Recipe = buildPaginatedListingRecipe({
  id: 'paginated_listing_generic',
  name: 'Generic paginated listing (3 pages, demo)',
  siteUrl: 'https://example.com/products',
  resultsSelector: '.product-list',
  nextPageSelector: '.pagination .next',
  pageCount: 3,
});

/** Catalogue of V-532.A reference recipes. */
export const V532A_NAVIGATION_RECIPES: readonly Recipe[] = [
  SEARCH_FLOW_GENERIC,
  PAGINATED_LISTING_GENERIC,
];
