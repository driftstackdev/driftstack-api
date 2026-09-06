import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.venv/**',
      '**/site-packages/**',
      // 2026-05-21 — Astro generates a `.astro/` build-cache dir at
      // whatever cwd `astro check` is run from (per-workspace, but a
      // root run pollutes the repo root). Exclude across the tree so
      // lint doesn't trip on the auto-generated `content.d.ts` etc.
      '**/.astro/**',
      '**/src-tauri/**',
      // W483 — errors-site is a dependency-free static generator script
      // (plain .mjs, no tsconfig project); the type-aware rules can't
      // resolve it. Its output is drift-guarded by
      // apps/server/tests/unit/errors-site-slug-parity.test.ts instead.
      'apps/errors-site/**',
      // Marketing site is an Astro project — it uses Astro's own
      // type-check pipeline (`astro check` via the workspace's
      // `typecheck` script). Excluding it from the root ESLint
      // type-aware run avoids the parser claiming Astro/Tailwind
      // config files aren't in the TS project.
      'apps/marketing-site/**',
      // Customer dashboard — same Astro-project pattern (V-099).
      // Files are typechecked via `astro check`, not by the eslint
      // config.
      'apps/customer-dashboard/**',
      // Admin panel — same Astro-project pattern (V-135).
      'apps/admin-panel/**',
      // Docs site — same Astro-project pattern (V-250).
      'apps/docs/**',
      // Status site — same Astro-project pattern (V-295c).
      'apps/status-site/**',
      // Standalone Node scripts (V-165) — not part of any TS project,
      // not type-checked by tsconfig.eslint.json. Linting these would
      // require a separate parser config; the scripts are short +
      // .mjs ESM-only so the cost outweighs the value.
      'scripts/**',
      // Operational autopilot scripts (e.g. the headless simulator
      // self-verify harness) — same standalone-.mjs case as `scripts/**`
      // above: ESM-only, outside any tsconfig, not type-checked here.
      'operations/scripts/**',
      // T-3 step 8 — the Cloudflare Pages Function that 301s the .dev website
      // hosts to .io. Deployed by wrangler from the repo root, outside any
      // tsconfig: the same standalone-JS case as `scripts/**` above. Its shape
      // is pinned by apps/server/tests/unit/the-dev-hosts-redirect-to-io.test.ts.
      'functions/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: [
      '*.config.js',
      '*.config.ts',
      'eslint.config.js',
      'vitest.config.ts',
      'drizzle.config.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);
