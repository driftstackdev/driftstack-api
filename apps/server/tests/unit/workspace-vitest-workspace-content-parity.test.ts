// W528.B — drift guard for the Vitest 4 root project orchestrator.
// V-288 two-project setup: vitest.node.config.ts (node) +
// apps/gui-client/vitest.config.ts (jsdom). Drift here either drops
// the gui-client jsdom project (would break all component/hook tests)
// or removes the .ts vs .tsx discriminator (would double-run tests
// in both environments).
//
//   • Project paths resolve from this config's URL, never process cwd.
//   • Two projects:
//     1. vitest.node.config.ts (node, .test.ts).
//     2. apps/gui-client/vitest.config.ts (jsdom, .test.tsx).
//   • .ts vs .tsx extension is the discriminator (no double-runs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'vitest.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W528.B /vitest.config.ts project orchestration parity', () => {
  const body = read(LIB);

  it('registers cwd-independent absolute node and GUI projects in order', () => {
    expect(body).toMatch(/import \{ defineConfig \} from 'vitest\/config';/);
    expect(body).toMatch(/import \{ fileURLToPath \} from 'node:url';/);
    expect(body).toMatch(
      /projects: \[\s*fileURLToPath\(new URL\('\.\/vitest\.node\.config\.ts', import\.meta\.url\)\),\s*fileURLToPath\(\s*new URL\('\.\/apps\/gui-client\/vitest\.config\.ts', import\.meta\.url\),?\s*\),?\s*\],/,
    );
  });

  it('uses the Vitest 4 projects API instead of the removed workspace API', () => {
    expect(body).not.toMatch(/defineWorkspace/);
    expect(existsSync(resolve(REPO_ROOT, 'vitest.workspace.ts'))).toBe(false);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
