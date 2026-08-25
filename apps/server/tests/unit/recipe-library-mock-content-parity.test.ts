// W457.A — drift guard for packages/recipe-library/src/mock.ts.
// V-127 mock RecipeRegistry + RecipeRunner. Drift here either drops
// the constant per-step duration (tests assert exact totals which
// flake under real timings) or breaks the 2-recipe DEFAULT_RECIPES
// catalogue (consumer-scaffolding tests lose the named demos and
// silently revert to empty registry).
//
//   • V-127 framing pinned + 'Deterministic outputs — same inputs
//     always produce the same RecipeResult. Real runner ships in
//     Phase 3; mock here lets the GUI client + admin panel
//     scaffolding integrate against the interface without waiting
//     on Phase 3 implementation.'
//   • DEFAULT_RECIPES: 2-entry catalogue (noop_smoke_test
//     diagnostic category + login_form_demo login category).
//   • noop_smoke_test: 2 steps (navigate https://example.com load +
//     capture screenshot).
//   • login_form_demo: 7 steps (navigate /login + wait #username +
//     type #username demo_user + type #password demo_pass + tap
//     #submit + wait .dashboard + capture dom).
//   • MOCK_STEP_DURATION_MS = 50 framing pinned 'Constant per-step
//     duration (ms) for the mock runner. Real runner surfaces
//     actual driver timings. Kept small + uniform so tests can
//     assert exact totals.'
//   • MockRecipeRegistry: 3 methods (get find + list + listByCategory).
//   • MockRecipeRunner.run: missing-recipe rejects with `recipe
//     not found: ${recipeId}`; status:'ok' across all steps.
//   • stepResultFor: { step, status: 'ok', durationMs:
//     MOCK_STEP_DURATION_MS }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/mock.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W457.A packages/recipe-library/src/mock.ts content parity', () => {
  const body = read(LIB);

  it("V-127 framing pinned: 'V-127 mock recipe runner + registry.' + 'Deterministic outputs — same inputs always produce the same RecipeResult. Real runner ships in Phase 3; mock here lets the GUI client + admin panel scaffolding integrate against the interface without waiting on Phase 3 implementation.'", () => {
    expect(body).toMatch(/\/\/ V-127 mock recipe runner \+ registry\./);
    expect(body).toMatch(
      /\/\/ Deterministic outputs — same inputs always produce the same\s*\/\/ RecipeResult\. Real runner ships in Phase 3; mock here lets the\s*\/\/ GUI client \+ admin panel scaffolding integrate against the\s*\/\/ interface without waiting on Phase 3 implementation\./,
    );
  });

  it('imports: 2 type-only from ./interfaces (RecipeRegistry + RecipeRunner); 5 type-only from ./types (Recipe + RecipeContext + RecipeResult + RecipeStep + RecipeStepResult)', () => {
    expect(body).toMatch(
      /import type \{ RecipeRegistry, RecipeRunner \} from '\.\/interfaces\.js';/,
    );
    expect(body).toMatch(
      /import type \{ Recipe, RecipeContext, RecipeResult, RecipeStep, RecipeStepResult \} from '\.\/types\.js';/,
    );
  });

  it("DEFAULT_RECIPES framing pinned 'Built-in mock recipes — minimal but realistic enough for tests'; noop_smoke_test recipe (id + diagnostic category + 2 steps: navigate https://example.com waitUntil:load + capture screenshot)", () => {
    expect(body).toMatch(
      /\/\*\* Built-in mock recipes — minimal but realistic enough for tests\. \*\//,
    );
    expect(body).toMatch(
      /\{\s*id: 'noop_smoke_test',\s*name: 'No-op smoke test',\s*category: 'diagnostic',\s*steps: \[\s*\{ kind: 'navigate', url: 'https:\/\/example\.com', waitUntil: 'load' \},\s*\{ kind: 'capture', what: 'screenshot' \},\s*\],\s*\},/,
    );
  });

  it('login_form_demo recipe: id + login category + 7-step sequence (navigate /login + wait #username + type #username demo_user + type #password demo_pass + tap #submit + wait .dashboard + capture dom)', () => {
    expect(body).toMatch(
      /\{\s*id: 'login_form_demo',\s*name: 'Generic login form \(demo\)',\s*category: 'login',\s*steps: \[\s*\{ kind: 'navigate', url: 'https:\/\/example\.com\/login' \},\s*\{ kind: 'wait', condition: 'selector', value: '#username' \},\s*\{ kind: 'type', selector: '#username', text: 'demo_user' \},\s*\{ kind: 'type', selector: '#password', text: 'demo_pass' \},\s*\{ kind: 'tap', selector: '#submit' \},\s*\{ kind: 'wait', condition: 'selector', value: '\.dashboard' \},\s*\{ kind: 'capture', what: 'dom' \},\s*\],\s*\},/,
    );
  });

  it('MockRecipeRegistry: 3 methods (get via .find on recipeId + list returns this.recipes + listByCategory filters); default constructor falls back to DEFAULT_RECIPES', () => {
    expect(body).toMatch(
      /export class MockRecipeRegistry implements RecipeRegistry \{\s*constructor\(private readonly recipes: readonly Recipe\[\] = DEFAULT_RECIPES\) \{\}\s*\n?\s*get\(recipeId: string\): Recipe \| undefined \{\s*return this\.recipes\.find\(\(r\) => r\.id === recipeId\);\s*\}\s*\n?\s*list\(\): readonly Recipe\[\] \{\s*return this\.recipes;\s*\}\s*\n?\s*listByCategory\(category: string\): readonly Recipe\[\] \{\s*return this\.recipes\.filter\(\(r\) => r\.category === category\);\s*\}/,
    );
  });

  it("MOCK_STEP_DURATION_MS=50 framing pinned: 'Constant per-step duration (ms) for the mock runner. Real runner surfaces actual driver timings. Kept small + uniform so tests can assert exact totals.'", () => {
    expect(body).toMatch(
      /\*\s*Constant per-step duration \(ms\) for the mock runner\. Real runner\s*\*\s*surfaces actual driver timings\. Kept small \+ uniform so tests can\s*\*\s*assert exact totals\./,
    );
    expect(body).toMatch(/const MOCK_STEP_DURATION_MS = 50;/);
  });

  it("MockRecipeRunner: default registry = new MockRecipeRegistry(); run rejects with `recipe not found: ${recipeId}` on missing; maps every step through stepResultFor (status:'ok'); aggregate status:'ok'; durationMs = reduce-sum", () => {
    expect(body).toMatch(
      /export class MockRecipeRunner implements RecipeRunner \{\s*constructor\(private readonly registry: RecipeRegistry = new MockRecipeRegistry\(\)\) \{\}/,
    );
    expect(body).toMatch(
      /return Promise\.reject\(new Error\(`recipe not found: \$\{recipeId\}`\)\);/,
    );
    expect(body).toMatch(
      /const steps: RecipeStepResult\[\] = recipe\.steps\.map\(\(step\) => stepResultFor\(step\)\);\s*const durationMs = steps\.reduce\(\(acc, s\) => acc \+ s\.durationMs, 0\);/,
    );
    expect(body).toMatch(
      /return Promise\.resolve\(\{\s*recipeId: recipe\.id,\s*status: 'ok',\s*steps,\s*durationMs,\s*\}\);/,
    );
  });

  it("stepResultFor: returns { step: redactStepForResult(step), status: 'ok', durationMs: MOCK_STEP_DURATION_MS } (credential redaction)", () => {
    expect(body).toMatch(
      /function stepResultFor\(step: RecipeStep\): RecipeStepResult \{\s*return \{ step: redactStepForResult\(step\), status: 'ok', durationMs: MOCK_STEP_DURATION_MS \};\s*\}/,
    );
    // the redaction helper must be imported (forward credential-leak guard).
    expect(body).toMatch(/import \{ redactStepForResult \} from '\.\/redact\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
