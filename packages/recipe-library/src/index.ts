// @driftstack/recipe-library public surface.

export type { Recipe, RecipeContext, RecipeResult, RecipeStep, RecipeStepResult } from './types.js';

export type { RecipeRegistry, RecipeRunner } from './interfaces.js';

export { MockRecipeRegistry, MockRecipeRunner } from './mock.js';

// V-532.A — navigation flow recipes + builder helpers.
export {
  buildPaginatedListingRecipe,
  buildSearchFlowRecipe,
  navigateAndWait,
  PAGINATED_LISTING_GENERIC,
  SEARCH_FLOW_GENERIC,
  tapAndWait,
  typeInto,
  V532A_NAVIGATION_RECIPES,
} from './recipes/navigation.js';

// V-532.B — login + fill-form recipe builders.
export type { FormField } from './recipes/forms.js';
export {
  buildFillFormRecipe,
  buildLoginRecipe,
  CONTACT_FORM_GENERIC,
  LOGIN_FLOW_GENERIC,
  V532B_FORM_RECIPES,
} from './recipes/forms.js';

// V-532.C — cart + checkout recipe builders.
export {
  ADD_TO_CART_GENERIC,
  ADD_TO_CART_WITH_VARIANT,
  buildAddToCartRecipe,
  buildCheckoutRecipe,
  CHECKOUT_GENERIC,
  V532C_CHECKOUT_RECIPES,
} from './recipes/checkout.js';

// V-532.D — multi-step wizard recipe builder.
export type { WizardStep } from './recipes/wizard.js';
export {
  buildWizardRecipe,
  SIGNUP_WIZARD_GENERIC,
  V532D_WIZARD_RECIPES,
} from './recipes/wizard.js';
