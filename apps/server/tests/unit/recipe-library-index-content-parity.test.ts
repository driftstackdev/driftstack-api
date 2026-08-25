// W455.C — drift guard for packages/recipe-library/src/index.ts.
// @driftstack/recipe-library public surface barrel spanning V-532.
// {A,B,C,D} recipe builders. Drift here drops a builder helper export
// (consumers building custom recipes lose the named builder) or
// accidentally re-exports an internal recipes/* helper not meant for
// public consumption.
//
//   • header framing pinned.
//   • core types: 5 type re-exports from ./types (Recipe + Context +
//     Result + Step + StepResult).
//   • core interfaces: 2 (RecipeRegistry + RecipeRunner).
//   • mock value exports: MockRecipeRegistry + MockRecipeRunner.
//   • V-532.A navigation: 8 value exports (buildPaginatedListingRecipe
//     + buildSearchFlowRecipe + navigateAndWait + PAGINATED_LISTING_
//     GENERIC + SEARCH_FLOW_GENERIC + tapAndWait + typeInto +
//     V532A_NAVIGATION_RECIPES).
//   • V-532.B forms: FormField type + 5 value exports (buildFillForm
//     Recipe + buildLoginRecipe + CONTACT_FORM_GENERIC + LOGIN_FLOW_
//     GENERIC + V532B_FORM_RECIPES).
//   • V-532.C checkout: 6 value exports (ADD_TO_CART_GENERIC + ADD_TO_
//     CART_WITH_VARIANT + buildAddToCartRecipe + buildCheckoutRecipe
//     + CHECKOUT_GENERIC + V532C_CHECKOUT_RECIPES).
//   • V-532.D wizard: WizardStep type + 3 value exports (buildWizard
//     Recipe + SIGNUP_WIZARD_GENERIC + V532D_WIZARD_RECIPES).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W455.C packages/recipe-library/src/index.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: '@driftstack/recipe-library public surface.'", () => {
    expect(body).toMatch(/\/\/ @driftstack\/recipe-library public surface\./);
  });

  it('core types: 5 type re-exports from ./types.js (Recipe + RecipeContext + RecipeResult + RecipeStep + RecipeStepResult)', () => {
    expect(body).toMatch(
      /export type \{ Recipe, RecipeContext, RecipeResult, RecipeStep, RecipeStepResult \} from '\.\/types\.js';/,
    );
  });

  it('core interfaces: 2 type re-exports (RecipeRegistry + RecipeRunner); mock value exports: MockRecipeRegistry + MockRecipeRunner', () => {
    expect(body).toMatch(
      /export type \{ RecipeRegistry, RecipeRunner \} from '\.\/interfaces\.js';/,
    );
    expect(body).toMatch(/export \{ MockRecipeRegistry, MockRecipeRunner \} from '\.\/mock\.js';/);
    // Credential redaction helpers (forward credential-leak guard) — step
    // results AND per-run metadata are two independent required chokepoints.
    expect(body).toMatch(
      /export \{ redactStepForResult, redactMetadata, REDACTED \} from '\.\/redact\.js';/,
    );
  });

  it("V-532.A framing pinned 'navigation flow recipes + builder helpers' + 8 value exports from ./recipes/navigation.js (buildPaginatedListingRecipe + buildSearchFlowRecipe + navigateAndWait + PAGINATED_LISTING_GENERIC + SEARCH_FLOW_GENERIC + tapAndWait + typeInto + V532A_NAVIGATION_RECIPES)", () => {
    expect(body).toMatch(/\/\/ V-532\.A — navigation flow recipes \+ builder helpers\./);
    expect(body).toMatch(
      /export \{\s*buildPaginatedListingRecipe,\s*buildSearchFlowRecipe,\s*navigateAndWait,\s*PAGINATED_LISTING_GENERIC,\s*SEARCH_FLOW_GENERIC,\s*tapAndWait,\s*typeInto,\s*V532A_NAVIGATION_RECIPES,\s*\} from '\.\/recipes\/navigation\.js';/,
    );
  });

  it("V-532.B framing pinned 'login + fill-form recipe builders' + FormField type + 5 value exports (buildFillFormRecipe + buildLoginRecipe + CONTACT_FORM_GENERIC + LOGIN_FLOW_GENERIC + V532B_FORM_RECIPES)", () => {
    expect(body).toMatch(/\/\/ V-532\.B — login \+ fill-form recipe builders\./);
    expect(body).toMatch(/export type \{ FormField \} from '\.\/recipes\/forms\.js';/);
    expect(body).toMatch(
      /export \{\s*buildFillFormRecipe,\s*buildLoginRecipe,\s*CONTACT_FORM_GENERIC,\s*LOGIN_FLOW_GENERIC,\s*V532B_FORM_RECIPES,\s*\} from '\.\/recipes\/forms\.js';/,
    );
  });

  it("V-532.C framing pinned 'cart + checkout recipe builders' + 6 value exports (ADD_TO_CART_GENERIC + ADD_TO_CART_WITH_VARIANT + buildAddToCartRecipe + buildCheckoutRecipe + CHECKOUT_GENERIC + V532C_CHECKOUT_RECIPES)", () => {
    expect(body).toMatch(/\/\/ V-532\.C — cart \+ checkout recipe builders\./);
    expect(body).toMatch(
      /export \{\s*ADD_TO_CART_GENERIC,\s*ADD_TO_CART_WITH_VARIANT,\s*buildAddToCartRecipe,\s*buildCheckoutRecipe,\s*CHECKOUT_GENERIC,\s*V532C_CHECKOUT_RECIPES,\s*\} from '\.\/recipes\/checkout\.js';/,
    );
  });

  it("V-532.D framing pinned 'multi-step wizard recipe builder' + WizardStep type + 3 value exports (buildWizardRecipe + SIGNUP_WIZARD_GENERIC + V532D_WIZARD_RECIPES)", () => {
    expect(body).toMatch(/\/\/ V-532\.D — multi-step wizard recipe builder\./);
    expect(body).toMatch(/export type \{ WizardStep \} from '\.\/recipes\/wizard\.js';/);
    expect(body).toMatch(
      /export \{\s*buildWizardRecipe,\s*SIGNUP_WIZARD_GENERIC,\s*V532D_WIZARD_RECIPES,\s*\} from '\.\/recipes\/wizard\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
