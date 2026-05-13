// W528.B — drift guard for /vitest.workspace.ts.
// V-288 two-project workspace: root vitest.config.ts (node) +
// apps/gui-client/vitest.config.ts (jsdom). Drift here either drops
// the gui-client jsdom project (would break all component/hook tests)
// or removes the .ts vs .tsx discriminator (would double-run tests
// in both environments).
//
//   • V-288 anchor doc-comment.
//   • Two projects:
//     1. Root vitest.config.ts (node, .test.ts).
//     2. apps/gui-client/vitest.config.ts (jsdom, .test.tsx).
//   • .ts vs .tsx extension is the discriminator (no double-runs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'vitest.workspace.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W528.B /vitest.workspace.ts content parity', () => {
  const body = read(LIB);

  it("V-288 two-project framing pinned: 'V-288 — Vitest workspace entry point.' + 'Two projects:' + '1. Root `vitest.config.ts` — node environment, covers `apps/**/tests/**/*.test.ts` + `packages/**/tests/**/*.test.ts`. Existing scope; unchanged.' + '2. `apps/gui-client/vitest.config.ts` — jsdom environment, covers ONLY `apps/gui-client/tests/**/*.test.tsx`. Component + hook-lifecycle tests live here; pure-function `.test.ts` files in the same dir keep running in the node project.' — pinned so the V-288 anchor + 2-project setup + node-vs-jsdom split commitment survives (drift to dropping the jsdom project would break all component/hook tests)", () => {
    expect(body).toMatch(/\/\/ V-288 — Vitest workspace entry point\./);
    expect(body).toMatch(/\/\/ Two projects:/);
    expect(body).toMatch(
      /\/\/\s+1\. Root `vitest\.config\.ts` — node environment, covers\s*\n?\s*\/\/\s+`apps\/\*\*\/tests\/\*\*\/\*\.test\.ts` \+ `packages\/\*\*\/tests\/\*\*\/\*\.test\.ts`\.\s*\n?\s*\/\/\s+Existing scope; unchanged\./,
    );
    expect(body).toMatch(
      /\/\/\s+2\. `apps\/gui-client\/vitest\.config\.ts` — jsdom environment, covers\s*\n?\s*\/\/\s+ONLY `apps\/gui-client\/tests\/\*\*\/\*\.test\.tsx`\. Component \+\s*\n?\s*\/\/\s+hook-lifecycle tests live here; pure-function `\.test\.ts` files\s*\n?\s*\/\/\s+in the same dir keep running in the node project\./,
    );
  });

  it("ts-vs-tsx discriminator + no-double-runs framing pinned: 'The .ts vs .tsx extension is the discriminator. No double-runs.' — pinned so the extension-based environment-routing + no-double-runs commitment survives (drift to overlapping include globs would double-run tests in both node + jsdom)", () => {
    expect(body).toMatch(
      /\/\/ The \.ts vs \.tsx extension is the discriminator\. No double-runs\./,
    );
  });

  it('defineWorkspace 2-entry framing pinned: \'import { defineWorkspace } from "vitest/config"\' + \'export default defineWorkspace(["./vitest.config.ts", "./apps/gui-client/vitest.config.ts"])\' — pinned so the 2-entry workspace + project-order (root first, gui-client second) commitment survives', () => {
    expect(body).toMatch(/import \{ defineWorkspace \} from 'vitest\/config';/);
    expect(body).toMatch(
      /export default defineWorkspace\(\['\.\/vitest\.config\.ts', '\.\/apps\/gui-client\/vitest\.config\.ts'\]\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
