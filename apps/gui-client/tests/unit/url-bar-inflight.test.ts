// url-bar-inflight — the pure policy behind the address bar's "navigation pending"
// state (T-23; the tap half is T-10).
//
// ⛔ Owner item T-23: "When entering a URL and the page takes a while to load (slow
// proxy), the URL in our simulator doesn't show the new URL … but still the old one
// for a while." MEASURED: the typed navigate is optimistic, but the ~2s page-state
// poll (and any data-channel frame) keeps describing the page the box is STILL ON
// until the new load commits — and that url was written straight into the tab, so the
// bar reverted to the old address within ~2s. `judgePendingNavigationFrame` is the one
// place that decides what such a frame may do; SimulatorWindow only applies the
// verdict. It is exercised here on its own so every branch is pinned without a
// 9k-line component in the way (the rendered path is covered in
// a-pending-navigation-outranks-a-stale-page-state.test.tsx).

import { describe, expect, it } from 'vitest';
import {
  URL_BAR_INFLIGHT_CEILING_MS,
  judgePendingNavigationFrame,
  type PendingNavigation,
} from '../../src/lib/url-bar-inflight';

// The component's normalizer shape (fragment off, trailing slash off, case-folded)
// — the judge is handed a normalizer, it does not own one.
const normalize = (url: unknown): string =>
  typeof url === 'string' ? url.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase() : '';

const OLD = 'https://old.example/';
const TARGET = 'https://new.example/';
const T0 = 1_700_000_000_000;

const pending = (over: Partial<PendingNavigation> = {}): PendingNavigation => ({
  target: normalize(TARGET),
  fromUrl: OLD,
  tabId: 'tab-a',
  startedAt: T0,
  ...over,
});

describe('judgePendingNavigationFrame (T-23)', () => {
  it('HOLDS a frame that still carries the PRE-navigation url while the typed navigation is pending — any state', () => {
    for (const state of ['loaded', 'loading', 'stalled', null, undefined]) {
      expect(
        judgePendingNavigationFrame(
          pending(),
          { tabId: 'tab-a', url: OLD, state },
          T0 + 2_600,
          normalize,
        ),
        `state=${String(state)}`,
      ).toBe('hold');
    }
  });

  it('holds on the NORMALIZED pre-navigation url too (a poll that drops the trailing slash is the same page)', () => {
    expect(
      judgePendingNavigationFrame(
        pending(),
        { tabId: 'tab-a', url: 'https://OLD.example', state: 'loaded' },
        T0 + 2_600,
        normalize,
      ),
    ).toBe('hold');
  });

  it('VACUITY CONTROL — a frame carrying the TARGET resolves in any state (the bar follows the box)', () => {
    for (const state of ['loading', 'loaded', 'stalled']) {
      expect(
        judgePendingNavigationFrame(
          pending(),
          { tabId: 'tab-a', url: TARGET, state },
          T0 + 2_600,
          normalize,
        ),
        `state=${state}`,
      ).toBe('resolve');
    }
  });

  it('a `loading` frame for a DIFFERENT url is a redirect — resolve, so the bar shows where the box went', () => {
    expect(
      judgePendingNavigationFrame(
        pending(),
        { tabId: 'tab-a', url: 'https://third.example/landing', state: 'loading' },
        T0 + 2_600,
        normalize,
      ),
    ).toBe('resolve');
  });

  it('an error frame resolves, even when it names the old url (the box is reporting, not lagging)', () => {
    expect(
      judgePendingNavigationFrame(
        pending(),
        { tabId: 'tab-a', url: OLD, state: 'errored' },
        T0 + 2_600,
        normalize,
      ),
    ).toBe('resolve');
  });

  it('the ceiling resolves an old-url frame — the hold can never outlive URL_BAR_INFLIGHT_CEILING_MS', () => {
    const frame = { tabId: 'tab-a', url: OLD, state: 'loaded' };
    expect(
      judgePendingNavigationFrame(
        pending(),
        frame,
        T0 + URL_BAR_INFLIGHT_CEILING_MS - 1,
        normalize,
      ),
      'one ms before the ceiling: still held',
    ).toBe('hold');
    expect(
      judgePendingNavigationFrame(pending(), frame, T0 + URL_BAR_INFLIGHT_CEILING_MS, normalize),
      'at the ceiling: released',
    ).toBe('resolve');
  });

  it('a frame for ANOTHER tab passes untouched, even with the very url that would be held on the pending tab', () => {
    expect(
      judgePendingNavigationFrame(
        pending(),
        { tabId: 'tab-b', url: OLD, state: 'loaded' },
        T0 + 2_600,
        normalize,
      ),
    ).toBe('pass');
  });

  it('nothing pending → pass (the everyday case must cost nothing and change nothing)', () => {
    expect(
      judgePendingNavigationFrame(
        null,
        { tabId: 'tab-a', url: OLD, state: 'loaded' },
        T0,
        normalize,
      ),
    ).toBe('pass');
  });

  it('a Reload (target == pre-navigation url) is confirmed by the old url, never held by it', () => {
    expect(
      judgePendingNavigationFrame(
        pending({ target: normalize(OLD) }),
        { tabId: 'tab-a', url: OLD, state: 'loading' },
        T0 + 500,
        normalize,
      ),
    ).toBe('resolve');
  });

  it('a url-less (title-only) frame carries nothing the hold is about → pass', () => {
    expect(
      judgePendingNavigationFrame(
        pending(),
        { tabId: 'tab-a', url: null, state: 'loaded' },
        T0 + 2_600,
        normalize,
      ),
    ).toBe('pass');
  });
});
