// 2026-09-17 — the display windows are ENFORCED CONTINUOUSLY, by a clock.
//
// ⛔ THE DEFECT. Every window lives in `deriveProbeViewState`, which reads
// `Date.now()` — and that derivation only ran when the probe cache was WRITTEN:
// `ProxiesView.refresh` and its cache subscription, `ProfilesView`'s `useMemo` on
// `[probeCache]`. Neither view had a clock. So a chip stayed green long past its
// window and then flipped grey the moment some unrelated proxy was written.
//
// That is why the owner reported it as ERRATIC rather than timed — "Still
// sometimes a proxy was green on quic, and later not green box" — and it is why
// widening the windows (proxy-reading-windows) is only half a fix: a longer window
// checked at arbitrary moments is a longer arbitrary period.
//
// The fix is ONE shared ~60 s tick (lib/use-display-clock.ts) used as a dependency
// of the existing pure derivations. No network, no measurement, no cache write.
//
// ⛔ THESE ARMS PROVE THE ABSENCE OF A WRITE, not just the presence of a change:
// `loadProbeCache` is counted, and the cache object handed to the view is frozen
// and never re-emitted. If the chip ages, the only thing that can have moved is
// the clock.

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import type { CachedProbe } from '../../src/lib/proxy-probe-cache';
import { MEASURED_READING_TTL_MS } from '../../src/lib/proxy-probe-cache';
import { DISPLAY_CLOCK_INTERVAL_MS, subscribeDisplayClock } from '../../src/lib/use-display-clock';

const MIN = 60_000;
/** A fixed moment, so every age in this file is arithmetic rather than a race. */
const START = Date.parse('2026-09-17T12:00:00.000Z');

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};

let stored: ProxyConfig[] = [];
let cache: Record<string, CachedProbe> = {};
let loads = 0;
/** What the native probe does on the next Test — swapped by the arm that makes it
 *  throw. A `let`, not `mockRejectedValue`, because the mock factory below is
 *  hoisted and the arms cannot reach into it. */
let testProxyImpl: () => Promise<ProxyTestResult> = () => Promise.resolve(OK);
const savedProbeResults: Array<{ id: string; result: ProxyTestResult }> = [];

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => testProxyImpl()),
  probeProxyExit: () => Promise.resolve(null),
  resolveEndpoint: vi.fn(() => Promise.resolve({ resolved: true, ip: '1.2.3.4', message: 'ok' })),
}));

vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  // Spread the REAL module and override only the I/O — the derivation, every
  // freshness predicate and the aged split are the production ones.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  invalidateProbe: vi.fn(() => Promise.resolve()),
  loadProbeCache: () => {
    loads += 1;
    return Promise.resolve(cache);
  },
  saveExitResult: vi.fn(() => Promise.resolve()),
  // ⛔ IT REALLY WRITES, AND IT WRITES IN PLACE. A stub that resolved without
  // touching `cache` would let the "a failure survives the tick" arm below pass
  // against a view that never persisted anything — the tick would re-derive the
  // same green entry and the error sentence would survive only because nothing
  // else had changed either. MUTATED, not reassigned: production's write ends in
  // `emitProbeCache`, which hands the view the new map; that emitter is module-
  // private, so the nearest honest stand-in is to change the very object the view
  // is already holding, which is exactly what its tick re-derives.
  saveProbeResult: vi.fn((id: string, result: ProxyTestResult, at: number) => {
    savedProbeResults.push({ id, result });
    const prior = cache[id];
    if (prior !== undefined) cache[id] = { ...prior, result, at };
    return Promise.resolve(cache);
  }),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));
const settingsStub = { settings: { apiKey: null, baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

const proxy = (id: string): ProxyConfig => ({
  id,
  label: `proxy-${id}`,
  host: `${id}.example.com`,
  port: 1080,
  username: `user-${id}`,
  password: 'never-rendered',
  createdAt: '2026-07-01T00:00:00.000Z',
  scheme: 'socks5',
});

const quicChip = (): Element => {
  const el = document.querySelector('[data-capability="quic"]');
  if (el === null) throw new Error('no QUIC chip rendered');
  return el;
};

describe('a reading leaves the present tense on the clock, with no cache write', () => {
  beforeEach(() => {
    // ⛔ `shouldAdvanceTime` so the promises the view awaits on mount still
    // settle — without it the mount never completes and every arm here would be
    // asserting about an empty grid. The advance it does is milliseconds; every
    // age below is stepped explicitly.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: START });
    stored = [];
    cache = {};
    loads = 0;
    savedProbeResults.length = 0;
    testProxyImpl = () => Promise.resolve(OK);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CRITICAL a chip that is GREEN at T is AGED at T + W without anything touching the cache. MUTATION: remove `displayTick` from the ProxiesView effect (or the `useDisplayClock` call) and the second half reds — the chip stays green for ever', async () => {
    // Two minutes inside the window at mount, so the first render must be green
    // and the only thing that can change it is time passing.
    const measuredAt = START - (MEASURED_READING_TTL_MS - 2 * MIN);
    stored = [proxy('a')];
    cache = { a: { result: OK, at: START - MIN, quicProbe: true, quicProbeAt: measuredAt } };

    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    await waitFor(() => expect(quicChip().getAttribute('data-ok')).toBe('true'));
    const loadsAtMount = loads;

    // Three minutes: the reading crosses its window, and three ticks fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * MIN);
    });

    expect(quicChip().getAttribute('data-ok')).toBe('aged');
    expect(quicChip().getAttribute('data-aged-value')).toBe('true');
    expect(quicChip().textContent).toContain('QUIC');
    // ⛔ THE CONTROL THAT MAKES THE ARM MEAN WHAT IT SAYS: nothing re-read the
    // cache, so no write and no subscription emit can be what moved the chip.
    expect(loads, 'the clock re-derives; it does not reload').toBe(loadsAtMount);
  });

  it('CRITICAL ⛔ A FAILED TEST IS NOT UNDONE BY THE NEXT TICK. The catch branch dropped the row’s chips in component state ONLY, so a re-derivation from the cache — which still held the last HEALTHY result — put the green row back over "Couldn’t test this proxy". Before the clock that needed an unrelated write to happen by; with it, it is guaranteed within a minute. MUTATION: delete the `saveProbeResult` call in handleTest’s catch and this reds', async () => {
    stored = [proxy('a')];
    cache = {
      a: { result: OK, at: START - MIN, quicProbe: true, quicProbeAt: START - 2 * MIN },
    };
    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    await waitFor(() => expect(quicChip().getAttribute('data-ok')).toBe('true'));

    // The probe throws — the network went away mid-handshake — so nothing on the
    // happy path, `saveProbeResult` included, ever runs.
    testProxyImpl = () => Promise.reject(new Error('socket hang up'));
    await act(async () => {
      // A row that already holds a result labels the button 'Re-test'.
      screen.getByRole('button', { name: /^(Test|Re-test)$/ }).click();
      await vi.advanceTimersByTimeAsync(10);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Couldn't test this proxy"));
    // The failure was PERSISTED, fail-closed — which is what makes it survive.
    const saved = savedProbeResults.at(-1);
    expect(saved?.id).toBe('a');
    expect(saved?.result.can_route, 'fail closed: never usable by omission').toBe(false);
    expect(document.querySelector('[data-capability="quic"]')).toBeNull();

    // Two full ticks, no other write, no other event.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * DISPLAY_CLOCK_INTERVAL_MS);
    });
    expect(document.body.textContent).toContain("Couldn't test this proxy");
    expect(
      document.querySelector('[data-capability="quic"]'),
      'the stale green must not come back on a timer',
    ).toBeNull();
  });

  it('CRITICAL ⛔ THE TICK STANDS ASIDE WHILE A CHECK IS RUNNING. The tick re-derives a HELD cache snapshot, and that snapshot is stale for the whole window between an optimistic UI write and the cache emit that confirms it — `applyServerProbeOutcome` and the VPN check both set a row’s chips first and persist after. Re-applying over them would revert the row the customer is watching, which is the opposite of what this clock is for. MUTATION: drop the `testingIdRef.current !== null` guard in the tick effect and this reds', async () => {
    // Two minutes inside the window, exactly like the ageing arm above — so if the
    // tick ran, this chip WOULD age within three minutes. That is what makes the
    // arm discriminating rather than a restatement of "nothing changed".
    const measuredAt = START - (MEASURED_READING_TTL_MS - 2 * MIN);
    stored = [proxy('a')];
    cache = { a: { result: OK, at: START - MIN, quicProbe: true, quicProbeAt: measuredAt } };
    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    await waitFor(() => expect(quicChip().getAttribute('data-ok')).toBe('true'));

    // A probe that never answers: the row is under measurement for the whole of
    // what follows, which is the state the guard exists for.
    testProxyImpl = () => new Promise<ProxyTestResult>(() => undefined);
    await act(async () => {
      screen.getByRole('button', { name: /^(Test|Re-test)$/ }).click();
      await vi.advanceTimersByTimeAsync(10);
    });
    await waitFor(() => expect(screen.getByText('Testing…')).toBeInTheDocument());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * MIN);
    });
    // Three ticks came and went and the derivation did not run: the row keeps
    // what is on screen until its own answer lands.
    //
    // ⛔ `data-inferred`, NOT just `data-ok`. This arm first asserted
    // `data-ok === 'true'` and passed with the guard REMOVED, because the chip a
    // re-derivation leaves behind here also reports `data-ok="true"`: with the
    // measured verdict retired, `proxyCapabilities` falls back to the INFERENCE
    // (this fixture's native probe granted UDP, so QUIC reads as likely), and the
    // aged chip that would otherwise have shown the truth is deliberately
    // suppressed while a test runs. Two very different chips, one attribute. The
    // measurement is the half that must survive, so the measurement is what is
    // asserted.
    expect(quicChip().getAttribute('data-inferred')).toBe('false');
    expect(quicChip().getAttribute('data-ok')).toBe('true');
  });

  it('CRITICAL the age LABEL advances on the same tick — a chip that says "7 h ago" for ever is the same lie in a quieter voice', async () => {
    // Already aged at mount, by a whisker, so the label is on an hour boundary
    // and one more hour must move it.
    const measuredAt = START - (MEASURED_READING_TTL_MS + MIN);
    stored = [proxy('a')];
    cache = { a: { result: OK, at: START - MIN, quicProbe: true, quicProbeAt: measuredAt } };

    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    await waitFor(() => expect(quicChip().getAttribute('data-ok')).toBe('aged'));
    expect(quicChip().getAttribute('title')).toContain('Last checked 8 hours ago.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * MIN);
    });
    expect(quicChip().getAttribute('title')).toContain('Last checked 9 hours ago.');
  });

  it('VACUITY CONTROL — a reading with hours left does NOT age just because the clock ticked: the tick re-derives, it does not expire', async () => {
    stored = [proxy('a')];
    cache = {
      a: { result: OK, at: START - MIN, quicProbe: true, quicProbeAt: START - 30 * MIN },
    };
    render(<ProxiesView />);
    await screen.findByLabelText('Select proxy-a');
    await waitFor(() => expect(quicChip().getAttribute('data-ok')).toBe('true'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * MIN);
    });
    expect(quicChip().getAttribute('data-ok')).toBe('true');
  });
});

describe('the clock itself — one timer for the whole app', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CRITICAL every subscriber rides ONE interval, and the last unsubscribe stops it — a build with neither view open runs no timer at all. MUTATION: create the interval per subscriber and the first expectation reds; drop the clearInterval and the last one reds', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeDisplayClock(a);
    const offB = subscribeDisplayClock(b);
    expect(setInterval).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DISPLAY_CLOCK_INTERVAL_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    expect(clearInterval, 'one subscriber left: the timer stays').not.toHaveBeenCalled();
    vi.advanceTimersByTime(DISPLAY_CLOCK_INTERVAL_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    offB();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * DISPLAY_CLOCK_INTERVAL_MS);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('a THROWING subscriber does not stop the clock for the others, and one that unsubscribes itself inside the callback does not corrupt the iteration', () => {
    const good = vi.fn();
    const off = subscribeDisplayClock(() => {
      throw new Error('a broken surface');
    });
    const offSelf = subscribeDisplayClock(() => {
      offSelf();
    });
    const offGood = subscribeDisplayClock(good);
    expect(() => vi.advanceTimersByTime(DISPLAY_CLOCK_INTERVAL_MS)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DISPLAY_CLOCK_INTERVAL_MS);
    expect(good).toHaveBeenCalledTimes(2);
    off();
    offGood();
  });

  it('the tick is a minute — fine enough that no rendered age label can be wrong by a unit it prints, cheap enough to leave running', () => {
    expect(DISPLAY_CLOCK_INTERVAL_MS).toBe(MIN);
  });
});
