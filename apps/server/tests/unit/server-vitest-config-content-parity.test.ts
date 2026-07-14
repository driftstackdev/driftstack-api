// Server-workspace Vitest isolation guard. The root orchestrator intentionally
// owns the whole monorepo, but `npm test -w apps/server` must stay inside this
// workspace and must preserve appended single-file filters.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/vitest.config.ts');

describe('apps/server/vitest.config.ts workspace isolation', () => {
  const body = existsSync(LIB) ? readFileSync(LIB, 'utf8') : '';

  it('anchors root to the config directory and selects only server test files', () => {
    expect(body).toMatch(/import \{ fileURLToPath \} from 'node:url';/);
    expect(body).toMatch(/root: fileURLToPath\(new URL\('\.', import\.meta\.url\)\),/);
    expect(body).toMatch(/name: 'server',/);
    expect(body).toMatch(/include: \['tests\/\*\*\/\*\.test\.ts'\],/);
  });

  it('retains node execution, e2e/dist exclusions, and bounded timeouts', () => {
    expect(body).toMatch(/environment: 'node',/);
    expect(body).toMatch(
      /exclude: \['\*\*\/node_modules\/\*\*', '\*\*\/dist\/\*\*', '\*\*\/tests\/e2e\/\*\*'\],/,
    );
    expect(body).toMatch(/testTimeout: 10_000,/);
    expect(body).toMatch(/hookTimeout: 10_000,/);
  });

  it('exists at the package-script-relative path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
