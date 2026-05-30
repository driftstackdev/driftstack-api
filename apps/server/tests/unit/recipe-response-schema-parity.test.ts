// Pins the recipe RESPONSE schema wiring introduced when the OpenAPI
// responses for the 3 recipe endpoints (POST 201 create, GET list, GET
// by-id) were `z.object({})` — i.e. the saved-recipe resource was
// untyped for SDK codegen.
//
//   1. api-types `RecipeSchema` mirrors the route's `PublicRecipe`
//      interface field-for-field; `RecipeDetailSchema` adds the
//      `intent_log` (reusing AgentIntentSchema) like `PublicRecipeDetail`.
//   2. openapi.ts registers Recipe + RecipeDetail as named components
//      and references them on the 3 endpoints (no longer empty).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecipeSchema, RecipeDetailSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

describe('recipe response schema parity', () => {
  it('RecipeSchema mirrors the route PublicRecipe interface field-for-field (shared shape — a field added/removed on either side breaks the build)', () => {
    const routeSrc = read(resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts'));
    // `interface PublicRecipe {` — the trailing ` {` keeps this from also
    // matching `interface PublicRecipeDetail extends PublicRecipe {`.
    const m = routeSrc.match(/interface PublicRecipe \{([\s\S]+?)\n\}/);
    expect(m, 'PublicRecipe interface must be present in the route').not.toBeNull();
    const ifaceFields = [...(m?.[1] ?? '').matchAll(/^\s+(\w+)\??:/gm)]
      .map((x) => x[1])
      .filter((f): f is string => f !== undefined);
    expect(ifaceFields.length).toBe(8);
    expect(new Set(Object.keys(RecipeSchema.shape))).toEqual(new Set(ifaceFields));
  });

  it('RecipeDetailSchema = RecipeSchema + intent_log (mirrors PublicRecipeDetail extends PublicRecipe)', () => {
    expect(Object.keys(RecipeDetailSchema.shape)).toEqual([
      ...Object.keys(RecipeSchema.shape),
      'intent_log',
    ]);
    // The detail carries the replayable intent_log (array of AgentIntent).
    expect(
      RecipeDetailSchema.safeParse({
        id: 'rcp_1',
        account_id: 'acc',
        agent_session_id: null,
        label: 'x',
        description: null,
        intent_count: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        intent_log: [{ kind: 'navigate', url: 'https://x' }],
      }).success,
    ).toBe(true);
  });

  it('OpenAPI registers Recipe + RecipeDetail and references them on the 3 recipe endpoints (were z.object({}))', () => {
    const oapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    expect(oapi).toMatch(/r\.register\('Recipe', RecipeSchema\);/);
    expect(oapi).toMatch(/r\.register\('RecipeDetail', RecipeDetailSchema\);/);
    expect(oapi).toMatch(/schema: RecipeSchema \}/); // POST 201 bare
    expect(oapi).toMatch(/schema: PaginatedRecipesSchema/); // GET list
    expect(oapi).toMatch(/schema: RecipeDetailSchema \}/); // GET by-id
  });
});
