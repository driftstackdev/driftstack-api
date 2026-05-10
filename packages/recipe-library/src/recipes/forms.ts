// V-532.B — login + fill-form recipe builders.
//
// Second sub-slice of V-532. V-532.A shipped navigation flow primitives
// (search + paginated listing + 3 builder helpers). V-532.B adds the
// form-interaction recipe family:
//
//   - buildLoginRecipe — generic username/password login flow.
//   - buildFillFormRecipe — multi-field form submission.
//   - 2 reference recipes parameterised against example.com.
//
// Sub-slices remaining:
//   - V-532.C — infinite-scroll detection + cart + checkout recipes.
//   - V-532.D — multi-step wizard recipe with branch-on-state.

import type { Recipe, RecipeStep } from '../types.js';
import { navigateAndWait, tapAndWait, typeInto } from './navigation.js';

// ────────────────────────────────────────────────────────────────────
// Recipe: login flow
// ────────────────────────────────────────────────────────────────────

/**
 * Build a login-flow recipe. Navigates to `loginUrl`, waits for the
 * username field, types credentials, submits, waits for the post-login
 * success indicator, captures.
 *
 * Site-agnostic — caller passes the site's selectors. The credential
 * values are recipe-author-supplied and stored as plain text in the
 * Recipe (which is itself a pure-data structure). Production usage
 * typically injects credentials via a separate vault lookup rather than
 * inlining them in the Recipe.
 */
export function buildLoginRecipe(opts: {
  id: string;
  name: string;
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successSelector: string;
  username: string;
  password: string;
}): Recipe {
  return {
    id: opts.id,
    name: opts.name,
    category: 'login',
    steps: [
      ...navigateAndWait(opts.loginUrl, opts.usernameSelector),
      typeInto(opts.usernameSelector, opts.username),
      typeInto(opts.passwordSelector, opts.password),
      ...tapAndWait(opts.submitSelector, opts.successSelector),
      { kind: 'capture', what: 'dom' },
    ],
  };
}

/** Reference login-flow recipe targeting example.com. */
export const LOGIN_FLOW_GENERIC: Recipe = buildLoginRecipe({
  id: 'login_flow_generic',
  name: 'Generic login flow (demo)',
  loginUrl: 'https://example.com/login',
  usernameSelector: '#username',
  passwordSelector: '#password',
  submitSelector: 'button[type="submit"]',
  successSelector: '.dashboard',
  username: 'demo_user',
  password: 'demo_pass',
});

// ────────────────────────────────────────────────────────────────────
// Recipe: fill-form
// ────────────────────────────────────────────────────────────────────

/** A single field in a generic form-fill recipe. */
export interface FormField {
  /** CSS selector for the input/textarea/select. */
  selector: string;
  /** Text value to type. For select fields, use the option's visible text. */
  value: string;
}

/**
 * Build a fill-form recipe. Navigates to `formUrl`, waits for the first
 * field to appear, types each field in order, submits, waits for the
 * post-submit success indicator, captures.
 *
 * Use for contact forms, signup flows, checkout shipping details — any
 * multi-field submission that doesn't fit the login pattern.
 */
export function buildFillFormRecipe(opts: {
  id: string;
  name: string;
  formUrl: string;
  fields: readonly FormField[];
  submitSelector: string;
  successSelector: string;
}): Recipe {
  const firstField = opts.fields[0];
  if (firstField === undefined) {
    throw new Error('buildFillFormRecipe: fields must contain at least 1 entry');
  }
  const firstFieldSelector = firstField.selector;
  const steps: RecipeStep[] = [
    ...navigateAndWait(opts.formUrl, firstFieldSelector),
    ...opts.fields.map((f) => typeInto(f.selector, f.value)),
    ...tapAndWait(opts.submitSelector, opts.successSelector),
    { kind: 'capture', what: 'dom' },
  ];

  return {
    id: opts.id,
    name: opts.name,
    category: 'form',
    steps,
  };
}

/** Reference fill-form recipe (3-field contact form). */
export const CONTACT_FORM_GENERIC: Recipe = buildFillFormRecipe({
  id: 'contact_form_generic',
  name: 'Generic contact form (demo, 3 fields)',
  formUrl: 'https://example.com/contact',
  fields: [
    { selector: '#name', value: 'Demo User' },
    { selector: '#email', value: 'demo@example.com' },
    { selector: '#message', value: 'Hello from a Driftstack recipe.' },
  ],
  submitSelector: 'button[type="submit"]',
  successSelector: '.thank-you',
});

/** Catalogue of V-532.B reference recipes. */
export const V532B_FORM_RECIPES: readonly Recipe[] = [LOGIN_FLOW_GENERIC, CONTACT_FORM_GENERIC];
