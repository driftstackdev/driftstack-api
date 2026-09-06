// T-13 — "Get set up" came back for a customer who had set up months ago.
//
// The two flags are meant to make that impossible: `ds_onboarding_completed` in
// this install's localStorage, and `onboarding_completed_at` on the account. The
// SEED effect copies account → local, so a finished customer on a NEW Mac never
// paints the card.
//
// ⛔ The other direction ran from `markCompleted` and nowhere else — and
// `markCompleted` fires exactly once, at the moment a customer finishes. So every
// customer who finished BEFORE the account gained the column has local=1 and an
// account that says nothing, and no code path ever tells it. On the Mac holding
// the flag the gap is invisible; it shows up on the NEXT one, as the exact
// complaint the pair of flags was built to answer.
//
// These arms pin the boot-time backfill, and — the part that matters — pin the
// two cases where it must NOT fire, because a PATCH on a guess would record
// completion for a customer who never finished.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type * as SyncModule from '../../src/lib/onboarding-account-sync';

const sync = vi.fn();
vi.mock('../../src/lib/onboarding-account-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof SyncModule>()),
  syncOnboardingCompletedToAccount: (): void => {
    sync();
  },
}));

const { useOnboardingCompleted } = await import('../../src/lib/use-onboarding-steps');

// The suite's own localStorage: jsdom's is not writable here, and the sibling
// onboarding suites install the same Map-backed shim.
const values = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return values.size;
  },
  clear() {
    values.clear();
  },
  getItem(key) {
    return values.get(key) ?? null;
  },
  key(index) {
    return [...values.keys()][index] ?? null;
  },
  removeItem(key) {
    values.delete(key);
  },
  setItem(key, value) {
    values.set(key, value);
  },
};

const COMPLETED_KEY = 'ds_onboarding_completed';
const FINISHED = { onboarding_completed_at: '2026-05-01T00:00:00.000Z' };
const UNFINISHED = { onboarding_completed_at: null };

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testStorage });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: testStorage });
  values.clear();
  sync.mockReset();
});
afterEach(cleanup);

describe('a finished customer tells the account, even on a later launch', () => {
  it('CRITICAL backfills when this Mac says done and the account does not', async () => {
    localStorage.setItem(COMPLETED_KEY, '1');
    renderHook(() => useOnboardingCompleted(UNFINISHED));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  });

  it('CRITICAL does NOT fire before /me has landed — a PATCH on a guess is a lie', async () => {
    // `null` means "the account has not loaded", not "the account says no". Firing
    // here would record completion for a customer who never finished, on any
    // machine where the local flag happens to be set.
    localStorage.setItem(COMPLETED_KEY, '1');
    renderHook(() => useOnboardingCompleted(null));
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not fire when the account already knows', async () => {
    localStorage.setItem(COMPLETED_KEY, '1');
    renderHook(() => useOnboardingCompleted(FINISHED));
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL — does not fire for a customer who has NOT finished', async () => {
    // No local flag: there is nothing to backfill, and this proves the arms above
    // measure the local→account gap rather than a hook that PATCHes on every mount.
    renderHook(() => useOnboardingCompleted(UNFINISHED));
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).not.toHaveBeenCalled();
  });

  it('CRITICAL a completion DURING this session is not backfilled on top of its own mirror', async () => {
    // ⛔ `markCompleted` already tells the account. If the backfill also fired on
    // the flag that call just wrote, every fresh completion would PATCH twice —
    // which is exactly what happened, and the mirror suite caught it. The two
    // paths are disjoint by construction: the backfill only ever considers the
    // value that was on disk at mount.
    const { result } = renderHook(() => useOnboardingCompleted(UNFINISHED));
    await new Promise((r) => setTimeout(r, 20));
    expect(sync, 'nothing to backfill on a fresh install').not.toHaveBeenCalled();
    result.current.markCompleted();
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    // …and the newly-written flag does not then trigger the backfill as well.
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('fires at most once per mount, however often the account object changes', async () => {
    // The account is a fresh object on many renders; without the ref this would
    // PATCH on every one of them, unbounded and invisible (the sync is
    // fire-and-forget, so nothing would ever surface the storm).
    localStorage.setItem(COMPLETED_KEY, '1');
    const { rerender } = renderHook(({ acct }) => useOnboardingCompleted(acct), {
      initialProps: { acct: { onboarding_completed_at: null } },
    });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i += 1) rerender({ acct: { onboarding_completed_at: null } });
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
