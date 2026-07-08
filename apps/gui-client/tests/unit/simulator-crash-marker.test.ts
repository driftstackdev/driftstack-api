// #137 — the abnormal-exit detector: a simulator window that vanishes without a clean
// close (native WKWebView crash / force-kill) leaves a stale heartbeat marker; the next
// boot must report exactly those, never a still-alive sibling or its own fresh marker.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.fn();
vi.mock('../../src/lib/log-buffer', () => ({
  record: (level: string, args: unknown[]): void => {
    record(level, args);
  },
}));

import {
  evaluateStaleMarkers,
  startSimulatorCrashMarker,
  HEARTBEAT_MS,
  STALE_MS,
} from '../../src/lib/simulator-crash-marker';

const K = 'ds:sim:live:';
const mk = (at: number, url = 'https://x.example/', sid = 's') => JSON.stringify({ at, url, sid });

describe('evaluateStaleMarkers (#137 pure core)', () => {
  const NOW = 1_000_000;

  it('flags a STALE marker for a different session as an abnormal exit', () => {
    const out = evaluateStaleMarkers(
      [{ key: K + 'dead', raw: mk(NOW - STALE_MS - 1) }],
      NOW,
      'self',
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(K + 'dead');
    expect(out[0].note).toContain('abnormal exit');
    expect(out[0].note).toContain('WITHOUT a clean close');
  });

  it('does NOT flag a still-heartbeating sibling (fresh marker)', () => {
    const out = evaluateStaleMarkers([{ key: K + 'alive', raw: mk(NOW - 1000) }], NOW, 'self');
    expect(out).toHaveLength(0);
  });

  it('never flags our OWN session marker, even if stale', () => {
    const out = evaluateStaleMarkers(
      [{ key: K + 'self', raw: mk(NOW - STALE_MS - 5) }],
      NOW,
      'self',
    );
    expect(out).toHaveLength(0);
  });

  it('sweeps an unparseable/legacy marker with an EMPTY note (no crash claim)', () => {
    const out = evaluateStaleMarkers([{ key: K + 'junk', raw: 'not-json' }], NOW, 'self');
    expect(out).toHaveLength(1);
    expect(out[0].note).toBe('');
  });

  it('skips a null entry', () => {
    const out = evaluateStaleMarkers([{ key: K + 'gone', raw: null }], NOW, 'self');
    expect(out).toHaveLength(0);
  });
});

describe('startSimulatorCrashMarker (boot sweep + heartbeat + clean stop)', () => {
  let store: Map<string, string>;
  let now: number;

  beforeEach(() => {
    record.mockClear();
    store = new Map();
    now = 5_000_000;
    // Minimal in-memory localStorage for the node test env.
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    vi.useFakeTimers();
  });

  it('on boot: reports a stale prior window, sweeps it, and starts its own heartbeat', () => {
    store.set(K + 'prior', mk(now - STALE_MS - 1)); // a window that died
    store.set(K + 'sibling', mk(now - 500)); // a live sibling — must survive untouched
    const stop = startSimulatorCrashMarker('me', () => now);

    // The dead prior was recorded + removed; the live sibling + our own marker remain.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      'error',
      expect.arrayContaining([expect.stringContaining('abnormal exit')]),
    );
    expect(store.has(K + 'prior')).toBe(false);
    expect(store.has(K + 'sibling')).toBe(true);
    expect(store.has(K + 'me')).toBe(true);

    stop();
    vi.useRealTimers();
  });

  it('heartbeat refreshes our marker; stop() clears the interval + removes our marker', () => {
    const stop = startSimulatorCrashMarker('me', () => now);
    const first = store.get(K + 'me');
    now += HEARTBEAT_MS;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    const second = store.get(K + 'me');
    expect(second).not.toBe(first); // heartbeat wrote a newer timestamp

    stop();
    expect(store.has(K + 'me')).toBe(false); // clean teardown → no breadcrumb next boot
    // After stop the interval is cleared — advancing time must not resurrect the marker.
    now += HEARTBEAT_MS * 5;
    vi.advanceTimersByTime(HEARTBEAT_MS * 5);
    expect(store.has(K + 'me')).toBe(false);
    vi.useRealTimers();
  });
});
