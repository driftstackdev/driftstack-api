// W455.B — drift guard for packages/recipe-library/src/interfaces.ts.
// V-127 recipe-runner + registry stub interfaces. Drift here either
// drops the 'Per-step failures land inside the resolved result with
// status: failed' framing on RecipeRunner.run (callers start try/
// catch'ing for per-step failures that should be inspected on the
// resolved result, double-handling errors) or weakens RecipeRegistry
// (Phase 3 filesystem-backed YAML catalogue loses its seam contract
// against the mock).
//
//   • V-127 header framing pinned.
//   • imports: 3 type-only from ./types (Recipe + RecipeContext +
//     RecipeResult).
//   • RecipeRegistry framing pinned: 'read-only catalogue. Phase 3
//     ships a real catalogue (filesystem-backed YAML, plus
//     customer-defined recipes loaded at runtime). The mock
//     implementation here ships a tiny in-memory catalogue for
//     tests + scaffolding work.'
//   • RecipeRegistry: 3 methods (get → undefined-for-unknown +
//     list + listByCategory).
//   • RecipeRunner framing pinned: 'drives apps/server/src/services/
//     sessions.ts via the Driftstack SDK, applies behavioural-
//     simulation cadence between steps, surfaces per-step progress
//     to GUI clients via SSE/WebSocket. The mock runner returns
//     canned results synchronously so consumers can integrate
//     against the interface now.'
//   • RecipeRunner.run framing pinned: 'Rejects only on
//     infrastructural error (recipe not found, session unreachable).
//     Per-step failures land inside the resolved result with status:
//     failed.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/src/interfaces.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W455.B packages/recipe-library/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it("V-127 framing pinned: 'V-127 recipe-runner + registry interfaces.'", () => {
    expect(body).toMatch(/\/\/ V-127 recipe-runner \+ registry interfaces\./);
  });

  it('imports: 3 type-only from ./types (Recipe + RecipeContext + RecipeResult)', () => {
    expect(body).toMatch(
      /import type \{ Recipe, RecipeContext, RecipeResult \} from '\.\/types\.js';/,
    );
  });

  it("RecipeRegistry framing pinned: 'Recipe registry — read-only catalogue of available recipes.' + 'Phase 3 ships a real catalogue (filesystem-backed YAML, plus customer-defined recipes loaded at runtime). The mock implementation here ships a tiny in-memory catalogue for tests + scaffolding work.'", () => {
    expect(body).toMatch(
      /\* Recipe registry — read-only catalogue of available recipes\.\s*\*\s*\*\s*Phase 3 ships a real catalogue \(filesystem-backed YAML, plus\s*\*\s*customer-defined recipes loaded at runtime\)\. The mock implementation\s*\*\s*here ships a tiny in-memory catalogue for tests \+ scaffolding work\./,
    );
  });

  it("RecipeRegistry: 3 methods (get → undefined-for-unknown framing 'Look up a recipe by id. Returns undefined for unknown ids.' + list 'every registered recipe' + listByCategory 'within one category')", () => {
    expect(body).toMatch(
      /export interface RecipeRegistry \{\s*\/\*\* Look up a recipe by id\. Returns undefined for unknown ids\. \*\/\s*get\(recipeId: string\): Recipe \| undefined;\s*\/\*\* List every registered recipe\. \*\/\s*list\(\): readonly Recipe\[\];\s*\/\*\* List recipes within one category\. \*\/\s*listByCategory\(category: string\): readonly Recipe\[\];\s*\}/,
    );
  });

  it("RecipeRunner framing pinned: 'Recipe runner — executes a Recipe against a session.' + 'Phase 3 ships the real runner (drives apps/server/src/services/sessions.ts via the Driftstack SDK, applies behavioural-simulation cadence between steps, surfaces per-step progress to GUI clients via SSE/WebSocket). The mock runner returns canned results synchronously so consumers can integrate against the interface now.'", () => {
    expect(body).toMatch(
      /\* Recipe runner — executes a Recipe against a session\.\s*\*\s*\*\s*Phase 3 ships the real runner \(drives `apps\/server\/src\/services\/sessions\.ts`\s*\*\s*via the Driftstack SDK, applies behavioural-simulation cadence between\s*\*\s*steps, surfaces per-step progress to GUI clients via SSE\/WebSocket\)\.\s*\*\s*The mock runner returns canned results synchronously so consumers\s*\*\s*can integrate against the interface now\./,
    );
  });

  it("RecipeRunner.run framing pinned: 'Execute the recipe identified by recipeId against the session in ctx. Resolves with a RecipeResult reporting per-step status. Rejects only on infrastructural error (recipe not found, session unreachable). Per-step failures land inside the resolved result with status: failed.'", () => {
    expect(body).toMatch(
      /\*\s*Execute the recipe identified by `recipeId` against the session in\s*\*\s*`ctx`\. Resolves with a `RecipeResult` reporting per-step status\.\s*\*\s*Rejects only on infrastructural error \(recipe not found, session\s*\*\s*unreachable\)\. Per-step failures land inside the resolved result\s*\*\s*with `status: 'failed'`\./,
    );
    expect(body).toMatch(/run\(recipeId: string, ctx: RecipeContext\): Promise<RecipeResult>;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
