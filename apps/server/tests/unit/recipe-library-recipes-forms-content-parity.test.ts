// W598.B — drift guard for packages/recipe-library/src/recipes/forms.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/recipes/forms.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W598.B packages/recipe-library/src/recipes/forms.ts content parity', () => {
  const body = read(LIB);

  it('V-532.B framing + login + fill-form builders + 2 reference recipes + V-532.C/.D deferrals pinned', () => {
    expect(body).toMatch(/\/\/ V-532\.B — login \+ fill-form recipe builders\./);
    expect(body).toMatch(/Second sub-slice of V-532\. V-532\.A shipped navigation flow primitives/);
    expect(body).toMatch(
      /\(search \+ paginated listing \+ 3 builder helpers\)\. V-532\.B adds the/,
    );
    expect(body).toMatch(/\/\/ form-interaction recipe family:/);
    expect(body).toMatch(/\/\/\s+- buildLoginRecipe — generic username\/password login flow\./);
    expect(body).toMatch(/\/\/\s+- buildFillFormRecipe — multi-field form submission\./);
    expect(body).toMatch(/\/\/\s+- 2 reference recipes parameterised against example\.com\./);
    expect(body).toMatch(
      /\/\/\s+- V-532\.C — infinite-scroll detection \+ cart \+ checkout recipes\./,
    );
    expect(body).toMatch(/\/\/\s+- V-532\.D — multi-step wizard recipe with branch-on-state\./);
  });

  it('buildLoginRecipe (site-agnostic + production-vault-injection note) + LOGIN_FLOW_GENERIC reference (demo_user/demo_pass) pinned', () => {
    expect(body).toMatch(/\* Build a login-flow recipe\./);
    expect(body).toMatch(/\* Site-agnostic — caller passes the site's selectors\. The credential/);
    expect(body).toMatch(/\* values are recipe-author-supplied and stored as plain text in the/);
    expect(body).toMatch(/\* Recipe \(which is itself a pure-data structure\)\. Production usage/);
    expect(body).toMatch(
      /\* typically injects credentials via a separate vault lookup rather than/,
    );
    expect(body).toMatch(/\* inlining them in the Recipe\./);
    expect(body).toMatch(/^export function buildLoginRecipe\(opts: \{$/m);
    expect(body).toMatch(/usernameSelector: string;/);
    expect(body).toMatch(/passwordSelector: string;/);
    expect(body).toMatch(/successSelector: string;/);
    expect(body).toMatch(/category: 'login',/);
    expect(body).toMatch(/^export const LOGIN_FLOW_GENERIC: Recipe = buildLoginRecipe\(\{$/m);
    expect(body).toMatch(/username: 'demo_user',/);
    expect(body).toMatch(/password: 'demo_pass',/);
  });

  it('FormField interface + buildFillFormRecipe fields-non-empty-required + CONTACT_FORM_GENERIC 3-field reference (name + email + message) + V532B_FORM_RECIPES catalogue pinned', () => {
    expect(body).toMatch(/\/\*\* A single field in a generic form-fill recipe\. \*\//);
    expect(body).toMatch(
      /^export interface FormField \{\s*\n\s*\/\*\* CSS selector for the input\/textarea\/select\. \*\/\s*\n\s*selector: string;\s*\n\s*\/\*\* Text value to type\. For select fields, use the option's visible text\. \*\/\s*\n\s*value: string;\s*\n\}/m,
    );
    expect(body).toMatch(/^export function buildFillFormRecipe\(opts: \{$/m);
    expect(body).toMatch(/fields: readonly FormField\[\];/);
    expect(body).toMatch(
      /if \(firstField === undefined\) \{\s*\n\s*throw new Error\('buildFillFormRecipe: fields must contain at least 1 entry'\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/\.\.\.opts\.fields\.map\(\(f\) => typeInto\(f\.selector, f\.value\)\),/);
    expect(body).toMatch(/category: 'form',/);
    expect(body).toMatch(/^export const CONTACT_FORM_GENERIC: Recipe = buildFillFormRecipe\(\{$/m);
    expect(body).toMatch(/\{ selector: '#name', value: 'Demo User' \},/);
    expect(body).toMatch(/\{ selector: '#email', value: 'demo@example\.com' \},/);
    expect(body).toMatch(/\{ selector: '#message', value: 'Hello from a Driftstack recipe\.' \},/);
    expect(body).toMatch(
      /^export const V532B_FORM_RECIPES: readonly Recipe\[\] = \[LOGIN_FLOW_GENERIC, CONTACT_FORM_GENERIC\];$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
