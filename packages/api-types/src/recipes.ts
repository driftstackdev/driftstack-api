import { z } from 'zod';
import { AgentIntentSchema } from './agent-intents.js';

/**
 * Saved-recipe resource (list/summary shape) — the metadata returned by
 * `POST /v1/recipes` (201) and each row of `GET /v1/recipes`. A recipe
 * is a replayable navigation flow assembled from an agent session's
 * plan-executed turns. Mirrors the route's `PublicRecipe` interface
 * (apps/server/src/routes/recipes.ts) field-for-field; a drift guard
 * pins the two in lockstep. The heavy `intent_log` is omitted here and
 * carried only by the detail view ({@link RecipeDetailSchema}).
 *
 * Before this schema existed the OpenAPI recipe responses were
 * `z.object({})` (empty), leaving the resource untyped for SDK codegen.
 */
export const RecipeSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  agent_session_id: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable(),
  intent_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * Full recipe (the `GET /v1/recipes/{id}` detail view) — the list
 * metadata plus the replayable `intent_log` (ordered {@link
 * AgentIntentSchema} array). Mirrors the route's `PublicRecipeDetail`.
 */
export const RecipeDetailSchema = RecipeSchema.extend({
  intent_log: z.array(AgentIntentSchema),
});

export type RecipeDetail = z.infer<typeof RecipeDetailSchema>;
