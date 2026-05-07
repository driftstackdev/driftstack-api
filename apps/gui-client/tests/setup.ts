// V-288 — Vitest setup file for the gui-jsdom project.
//
// Runs once per worker before any test in `apps/gui-client/tests/**/*.test.tsx`.
// Loaded via `setupFiles` in `apps/gui-client/vitest.config.ts`.
//
// Responsibilities:
//   1. Extends Vitest's `expect` with @testing-library/jest-dom matchers
//      (toBeInTheDocument / toHaveTextContent / etc).
//   2. Registers an afterEach() hook that calls @testing-library/react's
//      cleanup() — unmounts any rendered tree so the next test starts
//      with a clean DOM. Safe to run even when no component was rendered.

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
