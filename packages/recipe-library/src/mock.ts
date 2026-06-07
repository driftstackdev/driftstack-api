// V-127 mock recipe runner + registry.
//
// Deterministic outputs — same inputs always produce the same
// RecipeResult. Real runner ships in Phase 3; mock here lets the
// GUI client + admin panel scaffolding integrate against the
// interface without waiting on Phase 3 implementation.

import type { RecipeRegistry, RecipeRunner } from './interfaces.js';
import type { Recipe, RecipeContext, RecipeResult, RecipeStep, RecipeStepResult } from './types.js';
import { redactStepForResult } from './redact.js';

/** Built-in mock recipes — minimal but realistic enough for tests. */
const DEFAULT_RECIPES: readonly Recipe[] = [
  {
    id: 'noop_smoke_test',
    name: 'No-op smoke test',
    category: 'diagnostic',
    steps: [
      { kind: 'navigate', url: 'https://example.com', waitUntil: 'load' },
      { kind: 'capture', what: 'screenshot' },
    ],
  },
  {
    id: 'login_form_demo',
    name: 'Generic login form (demo)',
    category: 'login',
    steps: [
      { kind: 'navigate', url: 'https://example.com/login' },
      { kind: 'wait', condition: 'selector', value: '#username' },
      { kind: 'type', selector: '#username', text: 'demo_user' },
      { kind: 'type', selector: '#password', text: 'demo_pass' },
      { kind: 'tap', selector: '#submit' },
      { kind: 'wait', condition: 'selector', value: '.dashboard' },
      { kind: 'capture', what: 'dom' },
    ],
  },
];

export class MockRecipeRegistry implements RecipeRegistry {
  constructor(private readonly recipes: readonly Recipe[] = DEFAULT_RECIPES) {}

  get(recipeId: string): Recipe | undefined {
    return this.recipes.find((r) => r.id === recipeId);
  }

  list(): readonly Recipe[] {
    return this.recipes;
  }

  listByCategory(category: string): readonly Recipe[] {
    return this.recipes.filter((r) => r.category === category);
  }
}

/**
 * Constant per-step duration (ms) for the mock runner. Real runner
 * surfaces actual driver timings. Kept small + uniform so tests can
 * assert exact totals.
 */
const MOCK_STEP_DURATION_MS = 50;

export class MockRecipeRunner implements RecipeRunner {
  constructor(private readonly registry: RecipeRegistry = new MockRecipeRegistry()) {}

  run(recipeId: string, _ctx: RecipeContext): Promise<RecipeResult> {
    const recipe = this.registry.get(recipeId);
    if (!recipe) {
      return Promise.reject(new Error(`recipe not found: ${recipeId}`));
    }
    const steps: RecipeStepResult[] = recipe.steps.map((step) => stepResultFor(step));
    const durationMs = steps.reduce((acc, s) => acc + s.durationMs, 0);
    return Promise.resolve({
      recipeId: recipe.id,
      status: 'ok',
      steps,
      durationMs,
    });
  }
}

function stepResultFor(step: RecipeStep): RecipeStepResult {
  return { step: redactStepForResult(step), status: 'ok', durationMs: MOCK_STEP_DURATION_MS };
}
