// W598.D — drift guard for packages/recipe-library/src/recipes/wizard.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/recipes/wizard.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W598.D packages/recipe-library/src/recipes/wizard.ts content parity', () => {
  const body = read(LIB);

  it('V-532.D framing + final-sub-slice + 3 wizard archetypes (signup / tax-config / account-setup) + branch-on-state mechanic via nextWaitSelector + dynamic-branch-by-server-response-OUT-OF-SCOPE rationale pinned', () => {
    expect(body).toMatch(/\/\/ V-532\.D — multi-step wizard recipe with branch-on-state\./);
    expect(body).toMatch(/\/\/ Final sub-slice of V-532 per the original anti-substitution/);
    expect(body).toMatch(
      /\/\/ progression: A \(navigation\) → B \(login \+ fill-form\) → C \(cart \+/,
    );
    expect(body).toMatch(/\/\/ checkout\) → D \(multi-step wizard\)\./);
    expect(body).toMatch(/\/\/\s+- signup-wizard: account → profile → consent → done\./);
    expect(body).toMatch(
      /\/\/\s+- tax-config: country → form-shape \(varies by country\) → submit\./,
    );
    expect(body).toMatch(
      /\/\/\s+- account-setup: org-info → invite-team → integration-pick → done\./,
    );
    expect(body).toMatch(/\/\/ The branch-on-state mechanic: each step has a `nextWaitSelector`/);
    expect(body).toMatch(/\/\/ that ARRIVES after submit; the runner waits for it, captures it,/);
    expect(body).toMatch(/\/\/ and only then advances to the next step\./);
    expect(body).toMatch(/\/\/ What's NOT in scope here: dynamic branch-by-server-response\./);
    expect(body).toMatch(/\/\/ scripting layer that's a much bigger commitment than the recipe/);
    expect(body).toMatch(/\/\/ catalog should carry\./);
  });

  it('WizardStep interface: id + optional fields + optional beforeAdvanceTap (consent-style checkbox) + advanceSelector + nextWaitSelector pinned', () => {
    expect(body).toMatch(/\/\*\* One step in a multi-step wizard recipe\. \*\//);
    expect(body).toMatch(/^export interface WizardStep \{$/m);
    expect(body).toMatch(
      /\/\*\* Stable identifier for this step \(used in logs \/ failure messages\)\. \*\//,
    );
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(
      /\/\*\* Form fields to fill on this step\. May be empty for steps that only/,
    );
    expect(body).toMatch(/\*\s+click a button \(e\.g\. consent → "I agree"\)\. \*\//);
    expect(body).toMatch(/fields\?: readonly FormField\[\];/);
    expect(body).toMatch(
      /\/\*\* Optional explicit tap target between fill \+ advance \(e\.g\. checkbox,/,
    );
    expect(body).toMatch(/\*\s+confirm-toggle\)\. \*\//);
    expect(body).toMatch(/beforeAdvanceTap\?: string;/);
    expect(body).toMatch(
      /\/\*\* CSS selector for the "next" \/ "continue" button on this step\. \*\//,
    );
    expect(body).toMatch(/advanceSelector: string;/);
    expect(body).toMatch(
      /\/\*\* CSS selector that must appear on the NEXT step before this step is/,
    );
    expect(body).toMatch(
      /\*\s+considered complete\. Drives the wait barrier after `advance`\. \*\//,
    );
    expect(body).toMatch(/nextWaitSelector: string;/);
  });

  it('buildWizardRecipe: throws on empty steps + 4-action-per-step loop (type fields → optional beforeAdvanceTap → tapAndWait advanceSelector→nextWaitSelector) + final capture step + category wizard pinned', () => {
    expect(body).toMatch(/\* Build a multi-step wizard recipe\. Each step:/);
    expect(body).toMatch(/\*\s+1\. Type into each `fields\[i\]\.selector`\./);
    expect(body).toMatch(
      /\*\s+2\. \(Optional\) Tap `beforeAdvanceTap` \(checkbox \/ consent \/ etc\)\./,
    );
    expect(body).toMatch(/\*\s+3\. Tap `advanceSelector`\./);
    expect(body).toMatch(/\*\s+4\. Wait for `nextWaitSelector` to appear \(the next step's first/);
    expect(body).toMatch(/^export function buildWizardRecipe\(opts: \{$/m);
    expect(body).toMatch(/startWaitSelector: string;/);
    expect(body).toMatch(/steps: readonly WizardStep\[\];/);
    expect(body).toMatch(
      /if \(opts\.steps\.length === 0\) \{\s*\n\s*throw new Error\('buildWizardRecipe: steps must contain at least 1 entry'\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/for \(const step of opts\.steps\) \{/);
    expect(body).toMatch(/for \(const f of step\.fields \?\? \[\]\) \{/);
    expect(body).toMatch(/recipeSteps\.push\(typeInto\(f\.selector, f\.value\)\);/);
    expect(body).toMatch(
      /if \(step\.beforeAdvanceTap !== undefined\) \{\s*\n\s*recipeSteps\.push\(\{ kind: 'tap', selector: step\.beforeAdvanceTap \}\);\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /recipeSteps\.push\(\.\.\.tapAndWait\(step\.advanceSelector, step\.nextWaitSelector\)\);/,
    );
    expect(body).toMatch(/recipeSteps\.push\(\{ kind: 'capture', what: 'dom' \}\);/);
    expect(body).toMatch(/category: 'wizard',/);
  });

  it('SIGNUP_WIZARD_GENERIC 3-step reference (account email+password / profile name+org / consent checkbox→finish) + V532D_WIZARD_RECIPES catalogue pinned', () => {
    expect(body).toMatch(
      /\/\*\* Reference 3-step signup-wizard recipe parameterised against example\.com\. \*\//,
    );
    expect(body).toMatch(/^export const SIGNUP_WIZARD_GENERIC: Recipe = buildWizardRecipe\(\{$/m);
    expect(body).toMatch(/startWaitSelector: '#step-1-email',/);
    expect(body).toMatch(/id: 'account',/);
    expect(body).toMatch(/\{ selector: '#step-1-email', value: 'demo@example\.com' \},/);
    expect(body).toMatch(/\{ selector: '#step-1-password', value: 'demo_pass_123' \},/);
    expect(body).toMatch(/advanceSelector: 'button\[data-step="1-next"\]',/);
    expect(body).toMatch(/nextWaitSelector: '#step-2-name',/);
    expect(body).toMatch(/id: 'profile',/);
    expect(body).toMatch(/\{ selector: '#step-2-org', value: 'Demo Co' \},/);
    expect(body).toMatch(/id: 'consent',/);
    expect(body).toMatch(/beforeAdvanceTap: '#step-3-consent',/);
    expect(body).toMatch(/nextWaitSelector: '\.signup-complete',/);
    expect(body).toMatch(
      /^export const V532D_WIZARD_RECIPES: readonly Recipe\[\] = \[SIGNUP_WIZARD_GENERIC\];$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
