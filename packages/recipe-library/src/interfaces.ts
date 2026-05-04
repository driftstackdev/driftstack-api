// V-127 recipe-runner + registry interfaces.

import type { Recipe, RecipeContext, RecipeResult } from './types.js';

/**
 * Recipe registry — read-only catalogue of available recipes.
 *
 * Phase 3 ships a real catalogue (filesystem-backed YAML, plus
 * customer-defined recipes loaded at runtime). The mock implementation
 * here ships a tiny in-memory catalogue for tests + scaffolding work.
 */
export interface RecipeRegistry {
  /** Look up a recipe by id. Returns undefined for unknown ids. */
  get(recipeId: string): Recipe | undefined;
  /** List every registered recipe. */
  list(): readonly Recipe[];
  /** List recipes within one category. */
  listByCategory(category: string): readonly Recipe[];
}

/**
 * Recipe runner — executes a Recipe against a session.
 *
 * Phase 3 ships the real runner (drives `apps/server/src/services/sessions.ts`
 * via the Driftstack SDK, applies behavioural-simulation cadence between
 * steps, surfaces per-step progress to GUI clients via SSE/WebSocket).
 * The mock runner returns canned results synchronously so consumers
 * can integrate against the interface now.
 */
export interface RecipeRunner {
  /**
   * Execute the recipe identified by `recipeId` against the session in
   * `ctx`. Resolves with a `RecipeResult` reporting per-step status.
   * Rejects only on infrastructural error (recipe not found, session
   * unreachable). Per-step failures land inside the resolved result
   * with `status: 'failed'`.
   */
  run(recipeId: string, ctx: RecipeContext): Promise<RecipeResult>;
}
