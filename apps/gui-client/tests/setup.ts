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
//   4. Guarantees a REAL Web Storage on the window and EMPTIES it after every
//      test (see the block at the bottom).
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

// (4) Web Storage — measured 2026-09-11, two runtimes, two wrong truths:
//
//   • Node ≥ 25 ships an experimental GLOBAL `localStorage` whose methods throw
//     ("setItem is not a function") and it shadows jsdom's on this global. Every
//     storage read in the app sits in a try/catch, so on the Mac's Node 25 the
//     whole suite ran against storage that cannot store and passed by accident.
//   • CI's Node 22 gets jsdom's real Storage — which PERSISTS across the tests
//     of a file. One test's "☰ List" click left `ds-profiles-view-mode=list`
//     behind, and the 29 tests after it rendered the table and waited for a
//     grid card that never mounted (a-vpn-row-is-resolved-never-socks5-probed).
//
// So: the storage must WORK (a stub that throws is not "no storage", it is a
// broken instrument the app politely hides), and every test must start from an
// empty one, the way the app does on a fresh install. Guarded by
// tests/unit/the-test-storage-is-real-and-empty-for-every-test.test.tsx.

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

function ensureRealStorage(name: 'localStorage' | 'sessionStorage'): Storage {
  const g = globalThis as unknown as Record<string, unknown>;
  const current = g[name] as Partial<Storage> | undefined;
  if (typeof current?.setItem === 'function' && typeof current.getItem === 'function') {
    return current as Storage;
  }
  const fresh = new MemoryStorage();
  // Node's experimental global is an accessor; defineProperty replaces it. If
  // some future runtime makes it non-configurable this THROWS — a suite that
  // cannot store must not run and report green.
  Object.defineProperty(globalThis, name, { value: fresh, configurable: true, writable: true });
  if (typeof window !== 'undefined' && (window as unknown) !== globalThis) {
    Object.defineProperty(window, name, { value: fresh, configurable: true, writable: true });
  }
  return fresh;
}

const STORAGES: ReadonlyArray<Storage> = [
  ensureRealStorage('localStorage'),
  ensureRealStorage('sessionStorage'),
];

afterEach(() => {
  // cleanup() first: unmount runs under whatever timer mode the test chose.
  cleanup();
  vi.useRealTimers();
  // Then the storage: nothing a test stored outlives it.
  for (const s of STORAGES) s.clear();
});
