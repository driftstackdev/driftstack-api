// W529.C — drift guard for /eslint.config.js (workspace root).
// Flat-config ESLint setup. Drift here either weakens rule enforcement
// (would let lint regressions slip through CI) or drops an Astro-app
// ignore (would break root-typescript-eslint parser on Astro project
// files) or relaxes test-file rules in places they shouldn't apply.
//
//   • 5 Astro-app ignores: marketing-site (V-_), customer-dashboard
//     (V-099), admin-panel (V-135), docs (V-250), status-site (V-295c).
//   • dist/build/coverage/node_modules/.venv/site-packages/src-tauri
//     ignores.
//   • scripts/** ignored (V-165 — standalone .mjs ESM, no TS project).
//   • Base configs: js.configs.recommended + tseslint.configs.
//     recommendedTypeChecked.
//   • parserOptions.project: tsconfig.eslint.json (single typed
//     parser project for the whole monorepo).
//   • 4 explicit rules: @typescript-eslint/no-unused-vars (allow _-prefix)
//     + consistent-type-imports + no-floating-promises + no-misused-
//     promises + no-console (warn, allow warn/error).
//   • Test-file relaxation: no-explicit-any + no-unsafe-assignment off.
//   • Config-file relaxation: no-console off for *.config.js/ts +
//     eslint.config.js + vitest.config.ts + drizzle.config.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'eslint.config.js');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W529.C /eslint.config.js content parity', () => {
  const body = read(LIB);

  it("Imports + flat-config framing pinned: 'import js from \"@eslint/js\"' + 'import tseslint from \"typescript-eslint\"' + 'export default tseslint.config(...)' — pinned so the flat-config (not legacy .eslintrc) + @eslint/js base + typescript-eslint integration commitment survives", () => {
    expect(body).toMatch(/import js from '@eslint\/js';/);
    expect(body).toMatch(/import tseslint from 'typescript-eslint';/);
    expect(body).toMatch(/export default tseslint\.config\(/);
  });

  it("Build-artefact + Python venv + Tauri ignores framing pinned: '**/dist/**' + '**/build/**' + '**/coverage/**' + '**/node_modules/**' + '**/.venv/**' (Python venvs in sdk-python) + '**/site-packages/**' (Python site-packages) + '**/src-tauri/**' (Rust GUI client backend) — pinned so the 7-ignore build-artefact + cross-language-package-dir commitment survives", () => {
    expect(body).toMatch(/'\*\*\/dist\/\*\*',/);
    expect(body).toMatch(/'\*\*\/build\/\*\*',/);
    expect(body).toMatch(/'\*\*\/coverage\/\*\*',/);
    expect(body).toMatch(/'\*\*\/node_modules\/\*\*',/);
    expect(body).toMatch(/'\*\*\/\.venv\/\*\*',/);
    expect(body).toMatch(/'\*\*\/site-packages\/\*\*',/);
    expect(body).toMatch(/'\*\*\/src-tauri\/\*\*',/);
  });

  it("Astro-app 5-app + V-anchor framing pinned: 'Marketing site is an Astro project — it uses Astro's own type-check pipeline (`astro check` via the workspace's `typecheck` script). Excluding it from the root ESLint type-aware run avoids the parser claiming Astro/Tailwind config files aren't in the TS project.' + apps/marketing-site/** + apps/customer-dashboard/** (V-099) + apps/admin-panel/** (V-135) + apps/docs/** (V-250) + apps/status-site/** (V-295c) — pinned so the Astro-projects-use-astro-check + 5-Astro-app ignore (with each app's V-anchor commentary) commitment survives", () => {
    expect(body).toMatch(
      /\/\/ Marketing site is an Astro project — it uses Astro's own\s*\/\/ type-check pipeline \(`astro check` via the workspace's\s*\/\/ `typecheck` script\)\. Excluding it from the root ESLint\s*\/\/ type-aware run avoids the parser claiming Astro\/Tailwind\s*\/\/ config files aren't in the TS project\./,
    );
    expect(body).toMatch(/'apps\/marketing-site\/\*\*',/);
    expect(body).toMatch(/\/\/ Customer dashboard — same Astro-project pattern \(V-099\)\./);
    expect(body).toMatch(/'apps\/customer-dashboard\/\*\*',/);
    expect(body).toMatch(/\/\/ Admin panel — same Astro-project pattern \(V-135\)\./);
    expect(body).toMatch(/'apps\/admin-panel\/\*\*',/);
    expect(body).toMatch(/\/\/ Docs site — same Astro-project pattern \(V-250\)\./);
    expect(body).toMatch(/'apps\/docs\/\*\*',/);
    expect(body).toMatch(/\/\/ Status site — same Astro-project pattern \(V-295c\)\./);
    expect(body).toMatch(/'apps\/status-site\/\*\*',/);
  });

  it("scripts/** V-165 ignore framing pinned: 'Standalone Node scripts (V-165) — not part of any TS project, not type-checked by tsconfig.eslint.json. Linting these would require a separate parser config; the scripts are short + .mjs ESM-only so the cost outweighs the value.' + 'scripts/**' ignore — pinned so the V-165 anchor + scripts-as-standalone-mjs + cost-outweighs-value rationale commitment survives", () => {
    expect(body).toMatch(
      /\/\/ Standalone Node scripts \(V-165\) — not part of any TS project,\s*\/\/ not type-checked by tsconfig\.eslint\.json\. Linting these would\s*\/\/ require a separate parser config; the scripts are short \+\s*\/\/ \.mjs ESM-only so the cost outweighs the value\./,
    );
    expect(body).toMatch(/'scripts\/\*\*',/);
  });

  it("Base config + tsconfig.eslint.json + 4 explicit-rule framing pinned: 'js.configs.recommended' + '...tseslint.configs.recommendedTypeChecked' + 'project: \"./tsconfig.eslint.json\"' + 'tsconfigRootDir: import.meta.dirname' + '@typescript-eslint/no-unused-vars [error, _-prefix-ignore]' + '@typescript-eslint/consistent-type-imports: error' + '@typescript-eslint/no-floating-promises: error' + '@typescript-eslint/no-misused-promises: error' + 'no-console: [warn, allow warn+error]' — pinned so the type-checked base + tsconfig.eslint.json single-parser-project + 4-explicit-rule + console-warn-allow-warn-error commitment survives", () => {
    expect(body).toMatch(/js\.configs\.recommended,/);
    expect(body).toMatch(/\.\.\.tseslint\.configs\.recommendedTypeChecked,/);
    expect(body).toMatch(/project: '\.\/tsconfig\.eslint\.json',/);
    expect(body).toMatch(/tsconfigRootDir: import\.meta\.dirname,/);
    expect(body).toMatch(
      /'@typescript-eslint\/no-unused-vars': \[\s*'error',\s*\{ argsIgnorePattern: '\^_', varsIgnorePattern: '\^_' \},\s*\],/,
    );
    expect(body).toMatch(/'@typescript-eslint\/consistent-type-imports': 'error',/);
    expect(body).toMatch(/'@typescript-eslint\/no-floating-promises': 'error',/);
    expect(body).toMatch(/'@typescript-eslint\/no-misused-promises': 'error',/);
    expect(body).toMatch(/'no-console': \['warn', \{ allow: \['warn', 'error'\] \}\],/);
  });

  it("Test-file + config-file rule-relaxation framing pinned: test files: '**/*.test.ts' + '**/tests/**/*.ts' → no-explicit-any:off + no-unsafe-assignment:off; config files: '*.config.js' + '*.config.ts' + 'eslint.config.js' + 'vitest.config.ts' + 'drizzle.config.ts' → no-console:off — pinned so the test-file assertion-flexibility + 5-config-file console-log-allowed commitment survives (drift to applying no-explicit-any to tests would force every Zod/mock assertion to over-annotate)", () => {
    expect(body).toMatch(/files: \['\*\*\/\*\.test\.ts', '\*\*\/tests\/\*\*\/\*\.ts'\],/);
    expect(body).toMatch(/'@typescript-eslint\/no-explicit-any': 'off',/);
    expect(body).toMatch(/'@typescript-eslint\/no-unsafe-assignment': 'off',/);
    expect(body).toMatch(
      /files: \[\s*'\*\.config\.js',\s*'\*\.config\.ts',\s*'eslint\.config\.js',\s*'vitest\.config\.ts',\s*'drizzle\.config\.ts',\s*\],/,
    );
    expect(body).toMatch(/'no-console': 'off',/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
