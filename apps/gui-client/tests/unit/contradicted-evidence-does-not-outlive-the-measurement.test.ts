// (V-219) The QUIC chip has TWO sources and only ONE of them expires.
//
// `proxyCapabilities` collapses them into a single verdict, strongest evidence
// first: a live session's MEASURED HTTP/3 (`quicMeasured`), then the fleet Mac's
// relay handshake (`quicProbe`). W-30 gave the first a thirty-minute window,
// for a reason it stated plainly — "a relay that dies keeps its green tick for
// the life of the install". The second has no window at all.
//
// ⛔⛔ SO THE EXPIRY WAS BEING UNDONE BY THE FIELD BELOW IT. A live `h2-only`,
// measured through the customer's own browser, ages out after thirty minutes —
// and an older relay `true` underneath it then wins the precedence and renders
// the same green "HTTP/3 works through this exit" the live measurement had
// contradicted. Half an hour after the app told the truth, it went back to the
// older answer, silently, with nothing on screen having changed.
//
// ⚠️ THE OBVIOUS FIX IS A REGRESSION, and this file exists partly to record why.
// A TTL on the relay verdict looks symmetric and is not: a live verdict is
// re-emitted by a running session every ~300s, while the relay verdict is
// written ONLY when someone presses Test. A thirty-minute window on it means the
// green chip is essentially never shown — which is the owner's ORIGINAL
// complaint ("my proxy has QUIC but its not detecting it"), reintroduced by the
// fix for a different one. Two fields that look alike are in different decay
// classes, and one window over both collapses them.
//
// The rule that needs no window and no new field: A LATER MEASUREMENT RETIRES AN
// EARLIER ONE IT CONTRADICTS. Both are statements about the same MUTABLE
// property — does HTTP/3 work through this exit — so recency beats strength;
// strength only breaks ties at the same instant. Agreement is kept, because two
// measurements that agree corroborate, and that is what leaves the chip green
// after the live verdict expires.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  MEASURED_READING_TTL_MS,
  QUIC_VERDICT_TTL_MS,
  deriveProbeViewState,
  loadProbeCache,
  saveObservedQuic,
  saveProbeResult,
  saveServerProbeResult,
} from '../../src/lib/proxy-probe-cache';
import { proxyCapabilities } from '../../src/components/ProxyCapabilities';

const OK = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 42,
  message: 'ok',
};

const T0 = 1_000_000;
/** Far enough past the live verdict's window that it has expired and the relay
 *  verdict below it is the only thing left to render from.
 *
 * ⚠️ Measured from the LAST write in these arms (T0 + 10s), not from T0. The
 * window runs from `quicMeasuredAt`, so a constant anchored to T0 leaves the
 * live verdict still fresh — and every arm below then passes or fails for a
 * reason that has nothing to do with what it is testing. */
const LAST_WRITE = T0 + 10_000;
/** ⛔ PIN UPDATED 2026-09-17 — past the LONGER of the two windows. The live
 *  verdict still expires at `QUIC_VERDICT_TTL_MS` (30 min, derived from the 300 s
 *  re-emit that feeds it); the relay verdict beside it now expires at
 *  `MEASURED_READING_TTL_MS` (8 h, derived from the six-hourly check that feeds
 *  it). A constant anchored to the shorter one leaves the relay verdict fresh and
 *  the arms below pass or fail for a reason that has nothing to do with what they
 *  test — the same trap the note above records for T0. */
const AFTER_EXPIRY = LAST_WRITE + Math.max(QUIC_VERDICT_TTL_MS, MEASURED_READING_TTL_MS) + 1;

/** What the chip ACTUALLY renders for a row, through the real derivation and the
 *  real capability builder — not a hand-read of the cache. The defect is a
 *  rendering one, so the arms assert on the rendered verdict. */
const quicChip = async (
  id: string,
  nowMs: number,
): Promise<{ ok: boolean; inferred: boolean | undefined; hint: string }> => {
  const view = deriveProbeViewState(await loadProbeCache(), nowMs);
  const caps = proxyCapabilities(
    view.testResults[id] ?? OK,
    view.quicMeasured[id],
    view.quicProbe[id],
  );
  const chip = caps.find((c) => c.key === 'quic');
  if (chip === undefined) throw new Error('no QUIC chip');
  return { ok: chip.ok, inferred: chip.inferred, hint: chip.hint };
};

/** A row with a green FLEET RELAY verdict and nothing else. */
const rowWithRelay = async (id: string, relay: boolean): Promise<void> => {
  await saveProbeResult(id, OK, T0);
  await saveServerProbeResult(id, { latencyMs: 40, measuredFrom: 'fleet', quicProbe: relay }, T0);
};

beforeEach(() => {
  stores.clear();
});

describe('a live measurement retires the relay verdict it contradicts', () => {
  it('CRITICAL a live h2-only kills a green relay verdict, so the green cannot come BACK when the live one expires', async () => {
    await rowWithRelay('p1', true);
    // Before: the relay verdict alone renders green.
    expect((await quicChip('p1', T0)).ok, 'the relay verdict is green to begin with').toBe(true);

    await saveObservedQuic('p1', 'h2-only', T0 + 1_000);
    // The live measurement is the verdict now…
    const live = await quicChip('p1', T0 + 2_000);
    expect(live.ok).toBe(false);
    expect(live.inferred, 'a measured negative, not an inference').toBe(false);

    // …and THIS is the arm. Half an hour later the live verdict has expired, and
    // the retired relay verdict must NOT resurface as a green claim.
    const later = await quicChip('p1', AFTER_EXPIRY);
    // ⚠️ `inferred` is the assertion, not `ok`. With nothing measured the chip
    // falls back to the UDP inference, which is `ok: true, inferred: true` and
    // renders as the muted '~' — a guess, never the green claim. Asserting `ok`
    // alone would fail on the honest fallback and pass on the retired verdict:
    // exactly backwards.
    expect(later.inferred, 'it falls back to the INFERENCE, never to the retired verdict').toBe(
      true,
    );
    expect(later.hint, 'and it says so — "LIKELY — not tested"').toMatch(/not yet tested/i);
    expect((await loadProbeCache()).p1).not.toHaveProperty('quicProbe');
  });

  it('CRITICAL and the same in the other direction — a live h3 retires a relay `false`, or an expired positive uncovers a measured negative nobody re-measured', async () => {
    await rowWithRelay('p2', false);
    expect((await quicChip('p2', T0)).ok).toBe(false);

    await saveObservedQuic('p2', 'h3', T0 + 1_000);
    expect((await quicChip('p2', T0 + 2_000)).ok).toBe(true);

    const later = await quicChip('p2', AFTER_EXPIRY);
    expect(later.inferred, 'the retired negative does not come back either').toBe(true);
    expect((await loadProbeCache()).p2).not.toHaveProperty('quicProbe');
  });

  it('CRITICAL VACUITY CONTROL — AGREEMENT IS KEPT. Two measurements that agree corroborate, and keeping the relay verdict is exactly what leaves the chip green after the live one expires. A rule that dropped it here would look identical on the arms above while quietly deleting good evidence.', async () => {
    await rowWithRelay('p3', true);
    await saveObservedQuic('p3', 'h3', T0 + 1_000);
    expect((await loadProbeCache()).p3?.quicProbe, 'the corroborating verdict survives').toBe(true);
    // PIN UPDATED 2026-09-17 — the relay verdict is dated and aged now
    // (`quicProbeAt` / `isQuicProbeFresh`), so past the window NEITHER verdict
    // speaks in the present tense and this arm can no longer read a current green.
    // What it protects is unchanged and is asserted where it now lives: the
    // corroborating evidence is still THERE after the live verdict expires — as an
    // AGED `true`, the later of the two agreeing readings — instead of having been
    // deleted with the verdict it agreed with.
    const view = deriveProbeViewState(await loadProbeCache(), AFTER_EXPIRY);
    expect(view.quicProbe.p3, 'not a present-tense claim past the window').toBeUndefined();
    expect(view.aged.quicProbe.p3, 'the corroborating reading survives, dated').toEqual({
      value: true,
      atMs: T0,
    });
    const aged = proxyCapabilities(OK, undefined, undefined, {
      quicProbe: view.aged.quicProbe.p3,
      quicMeasured: view.aged.quicMeasured.p3,
    }).find((c) => c.key === 'quic')?.aged;
    expect(aged?.value, 'so the chip still says QUIC worked — in the past tense').toBe(true);
  });

  it('VACUITY CONTROL — a row with no relay verdict at all is untouched, so the arms above are about the CONTRADICTION and not about the write path clearing a field it does not like', async () => {
    await saveProbeResult('p4', OK, T0);
    await saveObservedQuic('p4', 'h2-only', T0 + 1_000);
    const entry = (await loadProbeCache()).p4;
    expect(entry?.quicMeasured).toBe('h2-only');
    expect(entry).not.toHaveProperty('quicProbe');
  });
});

describe('the mirror: a measured relay verdict retires the live verdict it contradicts', () => {
  it('CRITICAL a fleet test that measures NO relay drops a stored h3 that predates it — otherwise the older, stronger verdict masks the newer measurement for half an hour', async () => {
    await saveProbeResult('p5', OK, T0);
    await saveObservedQuic('p5', 'h3', T0 + 1_000);
    await saveServerProbeResult(
      'p5',
      { latencyMs: 40, measuredFrom: 'fleet', quicProbe: false },
      T0 + 2_000,
    );
    const entry = (await loadProbeCache()).p5;
    expect(entry).not.toHaveProperty('quicMeasured');
    expect(entry).not.toHaveProperty('quicMeasuredAt');
    const chip = await quicChip('p5', T0 + 3_000);
    expect(chip.ok, 'the newer measurement is the verdict').toBe(false);
    expect(chip.inferred).toBe(false);
  });

  it('CRITICAL CONTROL — a CARRIED relay verdict retires nothing. A control-plane fallback and a node that SKIPPED the QUIC leg both re-measure nothing, and a non-measurement must not be able to delete a real one.', async () => {
    await saveProbeResult('p6', OK, T0);
    await saveServerProbeResult(
      'p6',
      { latencyMs: 40, measuredFrom: 'fleet', quicProbe: true },
      T0,
    );
    await saveObservedQuic('p6', 'h2-only', T0 + 1_000);
    // The live h2-only retired the relay `true` above, so re-establish one that
    // the NEXT (non-measuring) result will carry forward.
    await saveServerProbeResult('p6', { measuredFrom: 'fleet', quicProbe: true }, T0 + 2_000);
    await saveObservedQuic('p6', 'h3', T0 + 3_000);
    // Now a skipped leg: no `quicProbe`, `quicSkipped` true. The prior verdict is
    // CARRIED — and carrying is not measuring, so the live h3 must stand.
    await saveServerProbeResult(
      'p6',
      { latencyMs: 55, measuredFrom: 'fleet', quicSkipped: true },
      T0 + 4_000,
    );
    const entry = (await loadProbeCache()).p6;
    expect(entry?.quicProbe, 'the skipped leg keeps the prior relay verdict').toBe(true);
    expect(entry?.quicMeasured, 'and it retires nothing').toBe('h3');
  });

  it('CRITICAL CONTROL — a live verdict NEWER than the server test survives it. A live observation that lands while a fleet test is in flight is the LATER evidence, and ordering by "whoever writes last" would let the older measurement win.', async () => {
    await saveProbeResult('p7', OK, T0);
    await saveObservedQuic('p7', 'h3', T0 + 5_000);
    // The server test MEASURED a contradicting relay verdict, but its own instant
    // is earlier than the live observation already stored.
    await saveServerProbeResult(
      'p7',
      { latencyMs: 40, measuredFrom: 'fleet', quicProbe: false },
      T0 + 1_000,
    );
    expect((await loadProbeCache()).p7?.quicMeasured, 'the later evidence stands').toBe('h3');
  });

  it('VACUITY CONTROL — an AGREEING relay measurement leaves the live verdict alone, so the mirror is about contradiction and not about every server result clearing the field', async () => {
    await saveProbeResult('p8', OK, T0);
    await saveObservedQuic('p8', 'h3', T0 + 1_000);
    await saveServerProbeResult(
      'p8',
      { latencyMs: 40, measuredFrom: 'fleet', quicProbe: true },
      T0 + 2_000,
    );
    const entry = (await loadProbeCache()).p8;
    expect(entry?.quicMeasured).toBe('h3');
    expect(entry?.quicProbe).toBe(true);
  });
});
