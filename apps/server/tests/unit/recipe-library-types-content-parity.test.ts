// W456.B — drift guard for packages/recipe-library/src/types.ts.
// V-127 Phase 3 recipe types stub. Drift here either drops a step
// kind from RecipeStep (runner falls into the never-handled case
// and silently no-ops the step) or breaks the 3-value step/result
// status union (caller switch statements lose case coverage and
// stop reacting to 'partial' aggregate runs).
//
//   • V-127 framing pinned + 'Recipes are pre-built scripts that
//     orchestrate a sequence of session operations (navigate,
//     interact, wait, capture). The catalogue ships in Phase 3;
//     the runner interface + mock land here so callers can integrate
//     against the seam now.'
//   • RecipeStep: 6-kind discriminated union (navigate with
//     optional waitUntil 3-value + tap + type + scroll 4-direction +
//     wait condition 3-value + capture 3-value).
//   • Recipe: 4-field (id + name + optional category + steps
//     readonly).
//   • RecipeStepResult: 4-field (step + status 3-value union
//     'ok'|'failed'|'skipped' + durationMs + optional error
//     {message + optional cause}).
//   • RecipeResult: 4-field (recipeId + status 3-value 'ok'|
//     'failed'|'partial' + steps readonly + durationMs).
//   • RecipeContext: 2-field (sessionId + optional metadata
//     Record).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W456.B packages/recipe-library/src/types.ts content parity', () => {
  const body = read(LIB);

  it("V-127 framing pinned: 'Phase 3 recipe types — V-127 stub.' + 'Recipes are pre-built scripts that orchestrate a sequence of session operations (navigate, interact, wait, capture). The catalogue ships in Phase 3; the runner interface + mock land here so callers can integrate against the seam now.'", () => {
    expect(body).toMatch(/\/\/ Phase 3 recipe types — V-127 stub\./);
    expect(body).toMatch(
      /\/\/ Recipes are pre-built scripts that orchestrate a sequence of session\s*\/\/ operations \(navigate, interact, wait, capture\)\. The catalogue ships\s*\/\/ in Phase 3; the runner interface \+ mock land here so callers can\s*\/\/ integrate against the seam now\./,
    );
  });

  it("RecipeStep: 6-kind discriminated union; navigate with optional waitUntil 3-value union ('load'|'domcontentloaded'|'networkidle'); tap + type + scroll 4-direction + wait condition 3-value + capture 3-value", () => {
    expect(body).toMatch(
      /export type RecipeStep =\s*\| \{ kind: 'navigate'; url: string; waitUntil\?: 'load' \| 'domcontentloaded' \| 'networkidle' \}\s*\| \{ kind: 'tap'; selector: string \}\s*\| \{ kind: 'type'; selector: string; text: string \}\s*\| \{ kind: 'scroll'; direction: 'up' \| 'down' \| 'left' \| 'right'; pixels: number \}\s*\| \{ kind: 'wait'; condition: 'selector' \| 'url' \| 'time'; value: string \| number \}\s*\| \{ kind: 'capture'; what: 'screenshot' \| 'dom' \| 'pdf' \};/,
    );
  });

  it("Recipe: 4-field (id 'Stable identifier (e.g. login_to_example_com)' + name 'Human-readable name surfaced in the GUI catalogue' + optional category 'Optional category for catalogue grouping' + steps readonly RecipeStep[])", () => {
    expect(body).toMatch(
      /export interface Recipe \{[\s\S]*?\/\*\* Stable identifier \(e\.g\. `'login_to_example_com'`\)\. \*\/\s*id: string;[\s\S]*?\/\*\* Human-readable name surfaced in the GUI catalogue\. \*\/\s*name: string;[\s\S]*?\/\*\* Optional category for catalogue grouping\. \*\/\s*category\?: string;[\s\S]*?\/\*\* Ordered steps\. \*\/\s*steps: readonly RecipeStep\[\];/,
    );
  });

  it("RecipeStepResult: 4-field (step + status 3-value 'ok'|'failed'|'skipped' + durationMs + optional error {message, optional cause}) + 'Per-step run state. Surfaced to the runner caller as the recipe progresses.' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* Per-step run state\. Surfaced to the runner caller as the recipe progresses\. \*\/\s*export interface RecipeStepResult \{\s*step: RecipeStep;[\s\S]*?status: 'ok' \| 'failed' \| 'skipped';[\s\S]*?durationMs: number;[\s\S]*?\/\*\* Error detail when status === 'failed'\. \*\/\s*error\?: \{ message: string; cause\?: unknown \};/,
    );
  });

  it("RecipeResult: 4-field (recipeId + status 3-value 'ok'|'failed'|'partial' framing 'Aggregate result for a complete recipe run' + steps readonly + durationMs)", () => {
    expect(body).toMatch(
      /\/\*\* Aggregate result for a complete recipe run\. \*\/\s*export interface RecipeResult \{\s*recipeId: string;\s*status: 'ok' \| 'failed' \| 'partial';[\s\S]*?\/\*\* Per-step results in execution order\. \*\/\s*steps: readonly RecipeStepResult\[\];[\s\S]*?durationMs: number;/,
    );
  });

  it("RecipeContext: 2-field (sessionId 'Session ID the recipe runs against' + optional metadata Record<string, unknown>, documented to route through redactMetadata before surfacing)", () => {
    // toContain fragments (not a closed multi-line regex) so the expanded
    // metadata doc comment (pointing at redactMetadata) doesn't break the pin.
    expect(body).toContain('/** Context the runner needs to execute against a session. */');
    expect(body).toContain('export interface RecipeContext {');
    expect(body).toContain('/** Session ID the recipe runs against. */');
    expect(body).toContain('sessionId: string;');
    expect(body).toContain('metadata?: Record<string, unknown>;');
    expect(body).toContain('route through `redactMetadata` (redact.ts) before surfacing');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
