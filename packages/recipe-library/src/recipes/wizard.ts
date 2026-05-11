// V-532.D — multi-step wizard recipe with branch-on-state.
//
// Final sub-slice of V-532 per the original anti-substitution
// progression: A (navigation) → B (login + fill-form) → C (cart +
// checkout) → D (multi-step wizard).
//
// Wizard recipes drive UIs that step through multiple stages where
// each step's selectors + field-shape only become known after the
// previous step's submit. Common shapes:
//   - signup-wizard: account → profile → consent → done.
//   - tax-config: country → form-shape (varies by country) → submit.
//   - account-setup: org-info → invite-team → integration-pick → done.
//
// The branch-on-state mechanic: each step has a `nextWaitSelector`
// that ARRIVES after submit; the runner waits for it, captures it,
// and only then advances to the next step. The wizard recipe is
// itself a flat step-sequence — the "branching" happens at the
// recipe-author level, not in the runtime DSL — but the helper
// here makes it ergonomic to express.
//
// What's NOT in scope here: dynamic branch-by-server-response. A
// recipe author that needs "step 3 differs based on what the server
// returned at step 2" composes two recipes and the runner caller
// decides which to run. The Recipe DSL is intentionally
// non-conditional; pushing branches into runtime would require a
// scripting layer that's a much bigger commitment than the recipe
// catalog should carry.

import type { Recipe, RecipeStep } from '../types.js';
import { navigateAndWait, tapAndWait, typeInto } from './navigation.js';
import type { FormField } from './forms.js';

/** One step in a multi-step wizard recipe. */
export interface WizardStep {
  /** Stable identifier for this step (used in logs / failure messages). */
  id: string;
  /** Form fields to fill on this step. May be empty for steps that only
   *  click a button (e.g. consent → "I agree"). */
  fields?: readonly FormField[];
  /** Optional explicit tap target between fill + advance (e.g. checkbox,
   *  confirm-toggle). */
  beforeAdvanceTap?: string;
  /** CSS selector for the "next" / "continue" button on this step. */
  advanceSelector: string;
  /** CSS selector that must appear on the NEXT step before this step is
   *  considered complete. Drives the wait barrier after `advance`. */
  nextWaitSelector: string;
}

/**
 * Build a multi-step wizard recipe. Each step:
 *   1. Type into each `fields[i].selector`.
 *   2. (Optional) Tap `beforeAdvanceTap` (checkbox / consent / etc).
 *   3. Tap `advanceSelector`.
 *   4. Wait for `nextWaitSelector` to appear (the next step's first
 *      element).
 *
 * The wizard navigates to `startUrl` first, then walks each step in
 * order. After the last step, the final `nextWaitSelector` is treated
 * as the "wizard complete" indicator (e.g. a success page selector),
 * and a `capture` step records the result.
 */
export function buildWizardRecipe(opts: {
  id: string;
  name: string;
  startUrl: string;
  /** Selector that must be present on the START URL before step 1 runs.
   *  Drives the initial navigate-and-wait. */
  startWaitSelector: string;
  steps: readonly WizardStep[];
}): Recipe {
  if (opts.steps.length === 0) {
    throw new Error('buildWizardRecipe: steps must contain at least 1 entry');
  }

  const recipeSteps: RecipeStep[] = [...navigateAndWait(opts.startUrl, opts.startWaitSelector)];

  for (const step of opts.steps) {
    for (const f of step.fields ?? []) {
      recipeSteps.push(typeInto(f.selector, f.value));
    }
    if (step.beforeAdvanceTap !== undefined) {
      recipeSteps.push({ kind: 'tap', selector: step.beforeAdvanceTap });
    }
    recipeSteps.push(...tapAndWait(step.advanceSelector, step.nextWaitSelector));
  }

  recipeSteps.push({ kind: 'capture', what: 'dom' });

  return {
    id: opts.id,
    name: opts.name,
    category: 'wizard',
    steps: recipeSteps,
  };
}

/** Reference 3-step signup-wizard recipe parameterised against example.com. */
export const SIGNUP_WIZARD_GENERIC: Recipe = buildWizardRecipe({
  id: 'signup_wizard_generic',
  name: 'Generic 3-step signup wizard (demo)',
  startUrl: 'https://example.com/signup',
  startWaitSelector: '#step-1-email',
  steps: [
    {
      id: 'account',
      fields: [
        { selector: '#step-1-email', value: 'demo@example.com' },
        { selector: '#step-1-password', value: 'demo_pass_123' },
      ],
      advanceSelector: 'button[data-step="1-next"]',
      nextWaitSelector: '#step-2-name',
    },
    {
      id: 'profile',
      fields: [
        { selector: '#step-2-name', value: 'Demo User' },
        { selector: '#step-2-org', value: 'Demo Co' },
      ],
      advanceSelector: 'button[data-step="2-next"]',
      nextWaitSelector: '#step-3-consent',
    },
    {
      id: 'consent',
      beforeAdvanceTap: '#step-3-consent',
      advanceSelector: 'button[data-step="3-finish"]',
      nextWaitSelector: '.signup-complete',
    },
  ],
});

/** Catalogue of V-532.D reference recipes. */
export const V532D_WIZARD_RECIPES: readonly Recipe[] = [SIGNUP_WIZARD_GENERIC];
