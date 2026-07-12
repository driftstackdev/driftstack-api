// Unit tests for SessionPageStateStore (W650/A3-W1254): latest-pageState-per-
// agent-session, bounded (oldest-evicted), customer-facing slice (drops the
// wire-routing type/sessionId).

import { describe, expect, it } from 'vitest';
import { AgentPageStateSchema } from '@driftstack/api-types';
import {
  SessionPageStateStore,
  resolvePageStateMaxAgeSeconds,
} from '../../src/services/session-page-state-store.js';
import type { PageStateFrame } from '../../src/schemas/harness-control-protocol.js';

function frame(sessionId: string, over: Partial<PageStateFrame> = {}): PageStateFrame {
  return {
    type: 'pageState',
    sessionId,
    state: 'loaded',
    url: 'https://example.com',
    error: null,
    ...over,
  };
}

describe('SessionPageStateStore', () => {
  it('get returns null for an unknown session', () => {
    const store = new SessionPageStateStore();
    expect(store.get('agt_unknown')).toBeNull();
  });

  it('set stores the customer-facing slice (state/url/title/tabId/error), dropping type + sessionId', () => {
    const store = new SessionPageStateStore();
    store.set(frame('agt_a', { state: 'loaded', url: 'https://x.test' }));
    expect(store.get('agt_a')).toEqual({
      state: 'loaded',
      url: 'https://x.test',
      title: null,
      tabId: null,
      error: null,
    });
  });

  it('set carries title + tabId through (forward-compat per-tab plumbing), on ANY state', () => {
    const store = new SessionPageStateStore();
    // title-only change frame on a NON-loaded state (the box may emit title on any
    // state) → both fields persisted, normalized when absent.
    store.set(frame('agt_a', { state: 'loading', url: null, title: 'New Title', tabId: 'tab_2' }));
    expect(store.get('agt_a')).toEqual({
      state: 'loading',
      url: null,
      title: 'New Title',
      tabId: 'tab_2',
      error: null,
    });
  });

  it('set overwrites with the latest per session', () => {
    const store = new SessionPageStateStore();
    store.set(frame('agt_a', { state: 'loading', url: null }));
    store.set(
      frame('agt_a', {
        state: 'errored',
        url: null,
        error: { kind: 'net', http_status: null, message: 'refused' },
      }),
    );
    expect(store.get('agt_a')).toEqual({
      state: 'errored',
      url: null,
      title: null,
      tabId: null,
      error: { kind: 'net', http_status: null, message: 'refused' },
    });
  });

  it('delete drops a session entry', () => {
    const store = new SessionPageStateStore();
    store.set(frame('agt_a'));
    store.delete('agt_a');
    expect(store.get('agt_a')).toBeNull();
  });

  it('is bounded — evicts the oldest entry past maxEntries (no unbounded growth from dead sessions)', () => {
    const store = new SessionPageStateStore(3);
    store.set(frame('agt_1'));
    store.set(frame('agt_2'));
    store.set(frame('agt_3'));
    expect(store.size).toBe(3);
    store.set(frame('agt_4')); // evicts agt_1 (oldest)
    expect(store.size).toBe(3);
    expect(store.get('agt_1')).toBeNull();
    expect(store.get('agt_4')).not.toBeNull();
  });

  it('an update refreshes recency — re-setting an entry moves it off the eviction front', () => {
    const store = new SessionPageStateStore(3);
    store.set(frame('agt_1'));
    store.set(frame('agt_2'));
    store.set(frame('agt_3'));
    store.set(frame('agt_1', { state: 'loading', url: null })); // agt_1 now newest
    store.set(frame('agt_4')); // evicts agt_2 (now the oldest), NOT agt_1
    expect(store.get('agt_1')).not.toBeNull();
    expect(store.get('agt_2')).toBeNull();
  });

  // Cross-package contract: the api-types `AgentPageStateSchema` is the shared
  // wire shape for GET /v1/agent-sessions/:id/page-state, so a stored record must
  // round-trip through it (incl. the new title/tabId fields). If the store shape
  // and the shared schema drift, this fails — the GUI's typed response breaks.
  it('a stored record validates against the shared api-types AgentPageStateSchema', () => {
    const store = new SessionPageStateStore();
    store.set(
      frame('agt_a', {
        state: 'stalled',
        url: 'https://example.com/app',
        title: 'App',
        tabId: 'tab_3',
      }),
    );
    const parsed = AgentPageStateSchema.safeParse(store.get('agt_a'));
    expect(parsed.success).toBe(true);
    // and the null-normalized empty case (no title/tabId/url/error reported yet).
    store.set(frame('agt_b', { state: 'loading', url: null }));
    expect(AgentPageStateSchema.safeParse(store.get('agt_b')).success).toBe(true);
  });

  it('the shared response schema rejects oversized retained strings', () => {
    const base = {
      state: 'loaded',
      url: 'https://example.com',
      title: 'Example',
      tabId: 'tab_1',
      error: null,
    } as const;
    for (const oversized of [
      { url: 'u'.repeat(8193) },
      { title: 't'.repeat(4097) },
      { tabId: 't'.repeat(257) },
      { error: { kind: 'k'.repeat(257), message: 'm' } },
      { error: { kind: 'net', message: 'm'.repeat(4097) } },
    ]) {
      expect(AgentPageStateSchema.safeParse({ ...base, ...oversized }).success).toBe(false);
    }
  });
});

// Audit 2026-07-01 (MEDIUM) — GET /:id/page-state has no way to distinguish
// "still genuinely stalled" from "dead session, stale cache" without a bound
// on how long a cached entry may outlive the harness that reported it.
// `getFresh` is that bound (paired with the `rec.status` check the route
// itself owns). A manual clock (like the deterministic-timer seam used by
// worker-disconnect-reaper.test.ts) makes the age math exact, no real
// wall-clock / fake-timer flakiness.
function manualClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('SessionPageStateStore.getFresh (age-bounded read, audit 2026-07-01)', () => {
  it('returns the entry when it is within maxAgeMs', () => {
    const clock = manualClock();
    const store = new SessionPageStateStore(5_000, clock.now);
    store.set(frame('agt_a', { state: 'stalled', url: null }));
    clock.advance(60_000); // 60s old
    expect(store.getFresh('agt_a', 120_000)).toEqual({
      state: 'stalled',
      url: null,
      title: null,
      tabId: null,
      error: null,
    });
  });

  it("treats a 'stalled' entry older than maxAgeMs as stale/cleared — evicts it and returns null, exactly the dead-session-serves-stale-cache gap the audit flagged", () => {
    const clock = manualClock();
    const store = new SessionPageStateStore(5_000, clock.now);
    store.set(frame('agt_a', { state: 'stalled', url: 'https://x.test' }));
    clock.advance(120_001); // 1ms past a 120s bound
    expect(store.getFresh('agt_a', 120_000)).toBeNull();
    // AND it evicted the entry (not just masked this one read) — a later
    // unbounded `get()` no longer sees it either.
    expect(store.get('agt_a')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('the plain unbounded get() still serves an entry regardless of age — getFresh and get() are independent reads', () => {
    const clock = manualClock();
    const store = new SessionPageStateStore(5_000, clock.now);
    store.set(frame('agt_a', { state: 'loaded' }));
    clock.advance(10 * 60_000); // 10 minutes — way past any sane bound
    expect(store.get('agt_a')).not.toBeNull();
  });

  it('returns null for an unknown session (no throw)', () => {
    const store = new SessionPageStateStore();
    expect(store.getFresh('agt_unknown', 120_000)).toBeNull();
  });

  it('an entry exactly AT maxAgeMs is still fresh (strictly-greater-than eviction)', () => {
    const clock = manualClock();
    const store = new SessionPageStateStore(5_000, clock.now);
    store.set(frame('agt_a'));
    clock.advance(120_000);
    expect(store.getFresh('agt_a', 120_000)).not.toBeNull();
  });
});

describe('resolvePageStateMaxAgeSeconds', () => {
  it('defaults to 120 when the env var is unset', () => {
    expect(resolvePageStateMaxAgeSeconds({})).toBe(120);
  });

  it('honors a valid positive override', () => {
    expect(
      resolvePageStateMaxAgeSeconds({
        DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS: '300',
      }),
    ).toBe(300);
  });

  it('falls back to 120 for a non-finite / non-positive value (never disables the bound)', () => {
    expect(
      resolvePageStateMaxAgeSeconds({
        DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS: 'nope',
      }),
    ).toBe(120);
    expect(
      resolvePageStateMaxAgeSeconds({ DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS: '0' }),
    ).toBe(120);
    expect(
      resolvePageStateMaxAgeSeconds({ DRIFTSTACK_AGENT_SESSION_PAGE_STATE_MAX_AGE_SECONDS: '-5' }),
    ).toBe(120);
  });
});
