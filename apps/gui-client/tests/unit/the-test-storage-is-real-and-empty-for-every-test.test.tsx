// The positive control for tests/setup.ts (4): Web Storage in this suite is a
// REAL Storage on every Node major, and every test starts with an empty one.
//
// Why a test and not a comment: on Node 25 the global `localStorage` is a stub
// whose methods throw, and the app's try/catch turned that into "grid by
// default" — the suite passed while measuring nothing. On Node 22 (CI) jsdom's
// storage is real and persisted across tests, so one test's "☰ List" click
// broke the 29 tests after it. Both failure modes red here: a stub reds the
// first arm, a leak reds the second. Declared order matters (vitest runs a
// file's tests in order): the first arm writes, the second reads nothing.

import { describe, expect, it } from 'vitest';

const KEY = 'ds-test-storage-control';

describe('the test storage is real and empty for every test', () => {
  it('works within a test: a stored value reads back, and length counts it', () => {
    for (const s of [window.localStorage, window.sessionStorage]) {
      expect(typeof s.setItem).toBe('function');
      expect(typeof s.getItem).toBe('function');
      expect(s.length).toBe(0);
      s.setItem(KEY, 'list');
      expect(s.getItem(KEY)).toBe('list');
      expect(s.length).toBe(1);
      expect(s.key(0)).toBe(KEY);
      s.removeItem(KEY);
      expect(s.getItem(KEY)).toBeNull();
      s.setItem(KEY, 'list');
    }
    // The global and the window agree — the app reads `window.localStorage`.
    expect(globalThis.localStorage).toBe(window.localStorage);
  });

  it('…and the previous test left nothing behind', () => {
    for (const s of [window.localStorage, window.sessionStorage]) {
      expect(s.getItem(KEY)).toBeNull();
      expect(s.length).toBe(0);
    }
  });
});
