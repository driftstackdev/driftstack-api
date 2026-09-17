// 2026-09-17 — THE UPGRADE CLIFF.
//
// `quicProbeAt` did not exist before gui-v0.1.63. MEASURED, not assumed:
//
//   git show gui-v0.1.62:apps/gui-client/src/lib/proxy-probe-cache.ts \
//     | grep -c quicProbeAt      → 0
//   …| grep -c quicProbe         → 26
//
// So every install that pressed Test before that release holds a relay verdict
// with NO date. The rule that came with the stamp — an undated verdict is NOT
// fresh — is right, and `isAgedReadingShowable` likewise refuses an undated
// reading, because an age sentence needs a date. Together they mean such a verdict
// is shown by NOTHING: a customer who tested yesterday, updated, and looked again
// sees "~ QUIC … not yet tested" about a proxy they had just proved, and nothing
// restores it until they press Test again. The value was on disk the whole time.
//
// The fix is the one the V2 `quicMeasuredAt` cliff already took: a ONE-TIME
// backfill at load, keyed on the schema version, stamping the entry with a date we
// actually recorded. Not a read-time default — that would weaken the not-fresh
// rule for every entry for ever.
//
// ⛔⛔ PIN UPDATED 2026-09-17 (review) — AND THE STAMP IS CLAMPED INTO THE AGED
// BAND. This suite first pinned the raw `serverProbeAt ?? at`, and pinned the
// resulting chip as GREEN. Both candidates are re-stamped long after the verdict
// was taken — `saveServerProbeResult` writes `serverProbeAt` on EVERY reply
// including a pure carry, and the background sweep moves `at` about every fifteen
// minutes — so neither is this verdict's own date, and an arbitrarily old verdict
// was being promoted to a present-tense green tick for a full display window. The
// cache file says so on itself, about this very field: "a CARRY keeps the original
// stamp, because a carry measured nothing and may not make an old verdict look
// new." So the backfill takes `min(borrowed, loadTime - W)`: the value is
// RESTORED — which is the whole point of the cliff — but it speaks in the past
// tense, muted and dated, because its true age is unknown. That is also what the
// item asked for in so many words: a pre-upgrade entry renders AGED, not untested.
//
// An entry whose borrowed date is ALREADY older than the boundary keeps it: the
// clamp only ever ages a stamp, never freshens one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, structuredClone(value));
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  backfillQuicMeasuredAt,
  backfillQuicProbeAt,
  deriveProbeViewState,
  loadProbeCache,
  PROBE_CACHE_SCHEMA_VERSION,
  type ProbeCacheMap,
} from '../../src/lib/proxy-probe-cache';
import { MEASURED_READING_TTL_MS } from '../../src/lib/proxy-reading-windows';
import type { ProxyTestResult } from '../../src/lib/proxies';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0,
  latency_ms: 40,
  message: 'ok',
};

/** An entry exactly as gui-v0.1.62 wrote it: a relay verdict, no `quicProbeAt`. */
const preUpgrade = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  result: OK,
  at: NOW - 3 * HOUR,
  quicProbe: true,
  ...over,
});

function seed(probes: Record<string, unknown>, version?: number): void {
  const m = new Map<string, unknown>([['probes', probes]]);
  // No key at all is the V1 store; a number is an install that has migrated that far.
  if (version !== undefined) m.set('probes_schema', version);
  stores.set('proxy-probe-cache.json', m);
}

beforeEach(() => {
  stores.clear();
  // ⛔ THE CLOCK IS FROZEN AT `NOW` because the migration now READS it. The
  // clamp is `min(borrowed, loadTime - W)`, so `loadProbeCache` consults the real
  // clock where it used only to copy a field off the entry — and `NOW` is a
  // deliberately synthetic instant, so against a live clock every clamped stamp
  // would land at "real now minus eight hours" and no assertion here could name a
  // value. Frozen, not offset: the arms are about an exact boundary.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the load migration dates a pre-upgrade relay verdict', () => {
  it('CRITICAL a v0.1.62-shaped entry loads with a stamp and RENDERS — AGED, in the past tense, never "not measured" and never green. MUTATION: drop backfillQuicProbeAt from migrateOnce and both halves red', async () => {
    seed({ p1: preUpgrade() }, 2);
    const cache = await loadProbeCache();
    // ⛔ CLAMPED. `at` says three hours, but `at` is the NATIVE probe's date and
    // the background sweep re-stamps it about every fifteen minutes — it is not
    // evidence about when the relay verdict was taken, only about when this row
    // was last pinged. The true age of this verdict is unknown, so the stamp is
    // pushed to exactly one display window old…
    expect(cache.p1?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
    // …which is the AGED band: the verdict is restored and visible, muted and
    // dated, and it does NOT claim to be current.
    const view = deriveProbeViewState(cache, NOW);
    expect(view.quicProbe, 'never green — its age is unknown').toEqual({});
    expect(view.aged.quicProbe.p1).toEqual({
      value: true,
      atMs: NOW - MEASURED_READING_TTL_MS,
    });
    // …and it is still there a week later, because the aged band runs to thirty
    // days. "Restored" has to mean restored, not "green for eight hours then gone".
    const later = deriveProbeViewState(cache, NOW + 7 * 24 * HOUR);
    expect(later.aged.quicProbe.p1?.value).toBe(true);
  });

  it('CRITICAL ⛔ THE DATE IS `serverProbeAt` WHEN THERE IS ONE, and `at` only as the fallback. `quicProbe` is written by ONE writer — the server test — so `serverProbeAt` is the closest thing on the entry to when the verdict was measured; `at` is the NATIVE probe’s date and moves on every local re-test and every background sweep, so preferring it would make an old relay verdict look as young as the last reachability check. MUTATION: swap the two and this reds', async () => {
    seed(
      {
        p1: preUpgrade({ at: NOW - MIN, serverProbeAt: NOW - 10 * HOUR, serverLatencyMs: 40 }),
      },
      2,
    );
    const cache = await loadProbeCache();
    // Already older than the clamp boundary, so it is kept verbatim: the clamp
    // only ever ages a stamp, and a recorded date beats a synthesised one.
    expect(cache.p1?.quicProbeAt).toBe(NOW - 10 * HOUR);
    // …and it therefore reads as AGED, beside a native check a minute old. A
    // verdict borrowing `at` here would have been green.
    const view = deriveProbeViewState(cache, NOW);
    expect(view.quicProbe).toEqual({});
    expect(view.aged.quicProbe.p1?.atMs).toBe(NOW - 10 * HOUR);
  });

  it('CRITICAL a verdict that ALREADY carries its own stamp is never re-dated — a migration that touched it would make every dated verdict look as young as the upgrade', async () => {
    seed({ p1: preUpgrade({ quicProbeAt: NOW - 20 * HOUR }) }, 2);
    expect((await loadProbeCache()).p1?.quicProbeAt).toBe(NOW - 20 * HOUR);
  });

  it('CRITICAL a row with NO relay verdict gets no stamp invented for it — the backfill dates a reading, it does not create one', async () => {
    seed({ p1: { result: OK, at: NOW - HOUR } }, 2);
    const cache = await loadProbeCache();
    expect(cache.p1).not.toHaveProperty('quicProbe');
    expect(cache.p1).not.toHaveProperty('quicProbeAt');
    expect(deriveProbeViewState(cache, NOW).quicProbe).toEqual({});
  });

  it('CRITICAL ⛔ EACH BACKFILL RUNS ONLY FOR THE VERSION IT WAS WRITTEN FOR. A store already at V2 has had the `quicMeasuredAt` pass; re-running it on the V3 bump would re-stamp an entry the V2 rule had deliberately left undatable — the read-time default that rule exists to refuse, arriving by another door. MUTATION: run both passes unconditionally and the first block reds', async () => {
    seed({ p1: { result: OK, at: NOW - HOUR, quicMeasured: 'h3', quicProbe: true } }, 2);
    let cache = await loadProbeCache();
    expect(cache.p1, 'the completed V2 pass does not run again').not.toHaveProperty(
      'quicMeasuredAt',
    );
    expect(cache.p1?.quicProbeAt, '…and the V3 pass does').toBe(NOW - MEASURED_READING_TTL_MS);

    // CONTROL — an install arriving from BEFORE V2 gets both passes.
    stores.clear();
    seed({ p1: { result: OK, at: NOW - HOUR, quicMeasured: 'h3', quicProbe: true } });
    cache = await loadProbeCache();
    // ⛔ The V2 stamp is NOT clamped and must not be: the live-session verdict's
    // own backfill rule was correct as written, and this is the control that the
    // V3 clamp was not quietly applied to it as well.
    expect(cache.p1?.quicMeasuredAt).toBe(NOW - HOUR);
    expect(cache.p1?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
  });

  it('the migration persists what it changed and then stops running — a second load reads the stamps back rather than re-deriving them', async () => {
    seed({ p1: preUpgrade(), p2: { result: OK, at: NOW - HOUR } }, 2);
    await loadProbeCache();
    const store = stores.get('proxy-probe-cache.json');
    expect(store?.get('probes_schema')).toBe(PROBE_CACHE_SCHEMA_VERSION);
    const raw = store?.get('probes') as Record<string, Record<string, unknown>>;
    expect(raw.p1?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
    // ⛔ Untouched entries are left in the store exactly as they were: the write
    // loop keys only the ids the backfill changed.
    expect(raw.p2).not.toHaveProperty('quicProbeAt');
    expect((await loadProbeCache()).p1?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
  });
});

describe('the backfills themselves — pure, over a cleaned map', () => {
  it('CRITICAL report exactly the ids they changed, so the caller persists exactly those; and a NON-FINITE date falls back to the load time rather than stamping a value no arithmetic can age', () => {
    const cache = {
      dated: { result: OK, at: NOW, quicProbe: true, quicProbeAt: NOW - HOUR },
      undated: { result: OK, at: NOW - HOUR, quicProbe: false },
      nan: { result: OK, at: Number.NaN, quicProbe: true },
      none: { result: OK, at: NOW },
    } as unknown as ProbeCacheMap;
    expect(backfillQuicProbeAt(cache, NOW).sort()).toEqual(['nan', 'undated']);
    // Both borrowed dates are NEWER than the clamp boundary, so both land on it:
    // a date we cannot trust may not speak in the present tense, however recent
    // the field it was borrowed from happens to look.
    expect(cache.undated?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
    expect(cache.nan?.quicProbeAt).toBe(NOW - MEASURED_READING_TTL_MS);
    expect(cache.dated?.quicProbeAt, 'untouched').toBe(NOW - HOUR);
    // ⛔ AND AN ALREADY-OLD DATE SURVIVES INTACT — the clamp is a ceiling, not an
    // assignment. Without this the arm above would pass just as well against
    // `quicProbeAt = loadTime - W` for every entry, which would throw away the one
    // honest date the cliff was able to recover.
    const older = {
      old: { result: OK, at: NOW - 40 * HOUR, quicProbe: true },
    } as unknown as ProbeCacheMap;
    backfillQuicProbeAt(older, NOW);
    expect(older.old?.quicProbeAt).toBe(NOW - 40 * HOUR);
    // Idempotent: a second pass finds nothing left to do.
    expect(backfillQuicProbeAt(cache, NOW)).toEqual([]);
  });

  it('CONTROL — the V2 backfill is unchanged and still stamps only the live verdict, so the V3 one cannot be a rewrite of it in disguise', () => {
    const cache = {
      a: { result: OK, at: NOW - HOUR, quicMeasured: 'h3' },
      b: { result: OK, at: NOW - HOUR, quicProbe: true },
    } as unknown as ProbeCacheMap;
    expect(backfillQuicMeasuredAt(cache, NOW)).toEqual(['a']);
    expect(cache.a?.quicMeasuredAt).toBe(NOW - HOUR);
    expect(cache.b).not.toHaveProperty('quicProbeAt');
  });
});
