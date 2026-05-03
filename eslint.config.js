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
      '**/src-tauri/**',
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
