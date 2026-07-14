import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep the workspace command independent of the caller's cwd while avoiding
  // the root orchestrator's intentional all-app + GUI project discovery.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'server',
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
