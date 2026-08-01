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
//   3. Restores real timers after every test, so a spec that installs fake
//      ones cannot leak them into whatever runs next.
//
// (3) closes a real order-dependence. A describe block in
// simulator-window-frozen.test.tsx ended with a test that called
// vi.useFakeTimers() and had no restoring hook. In declared order nothing ran
// after it, so it passed — but under `--sequence.shuffle` that test could be
// scheduled BEFORE its four siblings, each of which `await waitFor(...)`.
// waitFor polls on real timers; with fake ones installed and nothing advancing
// them, all four sat until the 10s test timeout. Seeds 1 and 3 reproduced it.
//
// Doing it here rather than per file: 23 blocks across this suite combine fake
// timers with waitFor and have no restoring hook. Only one has bitten so far,
// and editing the other 22 on suspicion would be churn — one hook covers the
// class for all 162 files. `beforeAll`-installed fake timers WOULD be broken by
// this, so that was checked first: there are none.

import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  // cleanup() first: unmount runs under whatever timer mode the test chose.
  cleanup();
  vi.useRealTimers();
});
