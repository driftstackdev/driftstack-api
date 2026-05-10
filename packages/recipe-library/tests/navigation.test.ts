import { describe, expect, it } from 'vitest';
import {
  buildPaginatedListingRecipe,
  buildSearchFlowRecipe,
  MockRecipeRegistry,
  MockRecipeRunner,
  navigateAndWait,
  PAGINATED_LISTING_GENERIC,
  SEARCH_FLOW_GENERIC,
  tapAndWait,
  typeInto,
  V532A_NAVIGATION_RECIPES,
} from '../src/index.js';

describe('V-532.A navigation builder helpers', () => {
  it('navigateAndWait without waitForSelector produces a single navigate step', () => {
    const steps = navigateAndWait('https://example.com');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      kind: 'navigate',
      url: 'https://example.com',
      waitUntil: 'load',
    });
  });

  it('navigateAndWait with waitForSelector adds a wait-for-selector barrier', () => {
    const steps = navigateAndWait('https://example.com', '#root');
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ kind: 'wait', condition: 'selector', value: '#root' });
  });

  it('tapAndWait produces a tap + wait pair', () => {
    const steps = tapAndWait('#submit', '.results');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ kind: 'tap', selector: '#submit' });
    expect(steps[1]).toEqual({ kind: 'wait', condition: 'selector', value: '.results' });
  });

  it('typeInto produces a single type step', () => {
    expect(typeInto('#q', 'hello')).toEqual({ kind: 'type', selector: '#q', text: 'hello' });
  });
});

describe('V-532.A buildSearchFlowRecipe', () => {
  it('produces a recipe with navigate + type + tap-wait + capture sequence', () => {
    const recipe = buildSearchFlowRecipe({
      id: 'test_search',
      name: 'Test search',
      siteUrl: 'https://example.com',
      searchInputSelector: '#q',
      submitSelector: '#submit',
      resultsSelector: '.results',
      query: 'driftstack',
    });

    expect(recipe.id).toBe('test_search');
    expect(recipe.category).toBe('search');

    const kinds = recipe.steps.map((s) => s.kind);
    expect(kinds).toEqual(['navigate', 'wait', 'type', 'tap', 'wait', 'capture']);

    // Verify the type step carries the query.
    const typeStep = recipe.steps.find((s) => s.kind === 'type');
    expect(typeStep).toBeDefined();
    if (typeStep && typeStep.kind === 'type') {
      expect(typeStep.text).toBe('driftstack');
    }
  });
});

describe('V-532.A buildPaginatedListingRecipe', () => {
  it('produces N captures + N-1 next-page taps for N pages', () => {
    for (const pageCount of [1, 2, 3, 5]) {
      const recipe = buildPaginatedListingRecipe({
        id: `pagi_${pageCount}`,
        name: `Pagination test ${pageCount}`,
        siteUrl: 'https://example.com/list',
        resultsSelector: '.list',
        nextPageSelector: '.next',
        pageCount,
      });
      const captures = recipe.steps.filter((s) => s.kind === 'capture');
      const taps = recipe.steps.filter((s) => s.kind === 'tap');
      expect(captures.length).toBe(pageCount);
      expect(taps.length).toBe(pageCount - 1);
    }
  });

  it('rejects pageCount < 1', () => {
    expect(() =>
      buildPaginatedListingRecipe({
        id: 'pagi_0',
        name: 'zero',
        siteUrl: 'https://example.com',
        resultsSelector: '.list',
        nextPageSelector: '.next',
        pageCount: 0,
      }),
    ).toThrow(/pageCount/);
  });
});

describe('V-532.A reference recipes', () => {
  it('catalogue contains both reference recipes', () => {
    expect(V532A_NAVIGATION_RECIPES).toHaveLength(2);
    expect(V532A_NAVIGATION_RECIPES.map((r) => r.id)).toEqual([
      'search_flow_generic',
      'paginated_listing_generic',
    ]);
  });

  it('SEARCH_FLOW_GENERIC matches the search-flow shape', () => {
    expect(SEARCH_FLOW_GENERIC.id).toBe('search_flow_generic');
    expect(SEARCH_FLOW_GENERIC.category).toBe('search');
    expect(SEARCH_FLOW_GENERIC.steps.length).toBeGreaterThan(0);
  });

  it('PAGINATED_LISTING_GENERIC has 3 captures + 2 next-page taps', () => {
    const captures = PAGINATED_LISTING_GENERIC.steps.filter((s) => s.kind === 'capture');
    const taps = PAGINATED_LISTING_GENERIC.steps.filter((s) => s.kind === 'tap');
    expect(captures.length).toBe(3);
    expect(taps.length).toBe(2);
  });

  it('MockRecipeRunner executes both reference recipes deterministically', async () => {
    const registry = new MockRecipeRegistry([...V532A_NAVIGATION_RECIPES]);
    const runner = new MockRecipeRunner(registry);
    for (const recipe of V532A_NAVIGATION_RECIPES) {
      const result = await runner.run(recipe.id, { sessionId: 'test-session' });
      expect(result.status).toBe('ok');
      expect(result.steps.length).toBe(recipe.steps.length);
      expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    }
  });
});
