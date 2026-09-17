// 2026-09-17 — THE INVARIANT: a reading's DISPLAY WINDOW must outlast the
// REFRESH CADENCE that feeds it.
//
//     W  >=  C + S
//
//   W = how long a reading renders in the present tense.
//   C = how old it may get before anything re-takes it unasked.
//   S = one scheduler slack — the re-take is planned by a sweep that only wakes
//       every `SWEEP_INTERVAL_MS`.
//
// ⛔ WHY IT NEEDED STATING. Three windows said thirty minutes; the only thing that
// re-takes those readings unasked runs every SIX HOURS. So a healthy proxy whose
// QUIC and stack readings were TRUE rendered green for 30 of every ~360 minutes —
// about 8% — and muted for the rest, through no fault of the proxy. The owner,
// 2026-09-17: "Still sometimes a proxy was green on quic, and later not green box,
// or i see apple but not being green at proxies … Has QUIC and Apple, but it aint
// green sometimes".
//
// Each of the three windows was individually defensible and each cited its
// neighbours ("same thirty minutes as the QUIC verdict above") rather than the
// cadence that re-measures it — so when the automatic check settled on six hours,
// nothing moved. The number is now DERIVED; this file is the check that keeps it
// derived, and the controls below are the check that it was not applied to the two
// windows that must NOT move.

import { describe, expect, it } from 'vitest';

import {
  deriveProbeViewState,
  isExitIdentityFresh,
  isOsFingerprintFresh,
  isQuicProbeFresh,
  isQuicVerdictFresh,
  isUdpVerdictFresh,
  EXIT_IDENTITY_TTL_MS,
  MEASURED_READING_TTL_MS,
  QUIC_VERDICT_TTL_MS,
  type CachedOsFingerprint,
} from '../../src/lib/proxy-probe-cache';
import { OS_FINGERPRINT_TTL_MS } from '../../src/lib/os-fingerprint-verdict';
import {
  CAPABILITY_REFRESH_AFTER_MS,
  CAPABILITY_RETRY_AFTER_MS,
  SWEEP_INTERVAL_MS,
} from '../../src/lib/proxy-probe-sweeper';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;

const FP = (at: number): CachedOsFingerprint => ({
  os: 'macos-or-ios',
  confidence: 'high',
  reason: 'initial TTL 64, Darwin option layout',
  at,
});

/** Every reading the automatic capability check re-takes, with the predicate that
 *  decides whether it may speak in the present tense. ⛔ The predicate, not the
 *  constant: a window that is right in a `const` and wrong at the call site is the
 *  shape this suite exists to catch. */
const CAPABILITY_FED = [
  ['quicProbe (the Test relay verdict)', isQuicProbeFresh],
  ['udpProbe (the UDP-relay verdict)', isUdpVerdictFresh],
  [
    'osFingerprint (the passive stack reading)',
    (at: number | undefined, now: number): boolean =>
      isOsFingerprintFresh(at === undefined ? undefined : FP(at), now),
  ],
] as const;

describe('W >= C + S — every reading the automatic check feeds', () => {
  it('CRITICAL is still CURRENT one full refresh cadence plus one scheduler slot after it was taken. MUTATION: set MEASURED_READING_TTL_MS to 30 * 60 * 1000 and all three arms red', () => {
    // The cadence, and the slack, read from the sweep that actually plans the
    // re-take — never re-typed here, or this asserts nothing about production.
    const C = CAPABILITY_REFRESH_AFTER_MS;
    const S = SWEEP_INTERVAL_MS;
    expect(C).toBe(6 * HOUR);
    expect(S).toBe(15 * MIN);
    // The BACKOFF matters as much as the refresh: a row is not looked at again
    // within it whatever the last attempt produced, so it bounds the real gap too.
    expect(CAPABILITY_RETRY_AFTER_MS).toBeLessThanOrEqual(C);

    for (const [name, fresh] of CAPABILITY_FED) {
      expect(fresh(NOW - (C + S), NOW), `${name}: a reading exactly C+S old`).toBe(true);
      // …and the margin on top of that, which is what makes it survive a run it
      // loses to the per-run budget (three rows, one VPN row).
      expect(fresh(NOW - (C + S + HOUR), NOW), `${name}: C+S+margin`).toBe(true);
    }
  });

  it('CRITICAL the window is DERIVED from the cadence, not typed beside it — the three windows that failed were each a hand-typed literal that could not follow the number it depended on', () => {
    // 6 h + 15 min + 1 h = 7 h 15 min, rounded UP to the next whole hour.
    expect(MEASURED_READING_TTL_MS).toBeGreaterThanOrEqual(
      CAPABILITY_REFRESH_AFTER_MS + SWEEP_INTERVAL_MS,
    );
    expect(MEASURED_READING_TTL_MS).toBe(8 * HOUR);
    // ONE definition reaches every surface. The cockpit's session readout ages the
    // SAME stack reading as the proxy grid and cannot import the cache (the Tauri
    // store rides along), so a second literal there would let two surfaces disagree
    // about the same proxy on the same screen.
    expect(OS_FINGERPRINT_TTL_MS).toBe(MEASURED_READING_TTL_MS);
  });

  it('CRITICAL the aged state is still the SAFETY NET, not the normal state: past the window every one of these reads as NOT current, so the muted, dated rendering still happens — the window moved, the honesty did not', () => {
    for (const [name, fresh] of CAPABILITY_FED) {
      expect(fresh(NOW - MEASURED_READING_TTL_MS, NOW), `${name}: at the edge`).toBe(false);
      expect(fresh(NOW - MEASURED_READING_TTL_MS - 1, NOW), `${name}: past it`).toBe(false);
      // …and the rule that has to survive every one of these moves: a reading we
      // cannot DATE is not current, whatever the window is.
      expect(fresh(undefined, NOW), `${name}: undated`).toBe(false);
    }
  });
});

describe('⛔ CONTROL — the two windows that were NOT widened, and why', () => {
  it('CRITICAL quicMeasured (the LIVE-SESSION verdict) is still thirty minutes: its cadence is the 300 s ±20% capability re-emit, not the six-hourly check, so its own derivation is correct and applying this one would have made it twelve times too slow to notice a relay that died', () => {
    expect(QUIC_VERDICT_TTL_MS).toBe(30 * MIN);
    expect(QUIC_VERDICT_TTL_MS).not.toBe(MEASURED_READING_TTL_MS);
    expect(isQuicVerdictFresh(NOW - 30 * MIN + 1, NOW)).toBe(true);
    expect(isQuicVerdictFresh(NOW - 30 * MIN, NOW)).toBe(false);
    // It satisfies the invariant on ITS OWN cadence: six re-emits at the 360 s
    // worst-case honest gap is 36 min — more than the window — which is why this
    // one was never the defect. 1800s = 5 whole 360s gaps of slack.
    expect(QUIC_VERDICT_TTL_MS).toBeGreaterThanOrEqual(5 * 360_000);
  });

  it('CRITICAL ⛔ EXIT IDENTITY is still thirty minutes because a DECISION consumes it. A display window may be widened to stop a true reading going quiet; a window the launch path reads decides what clock goes on the customer’s device, and past it the answer is not "render it muted", it is "probe again"', () => {
    expect(EXIT_IDENTITY_TTL_MS).toBe(30 * MIN);
    expect(EXIT_IDENTITY_TTL_MS).not.toBe(MEASURED_READING_TTL_MS);
    expect(isExitIdentityFresh(NOW - 30 * MIN + 1, NOW)).toBe(true);
    expect(isExitIdentityFresh(NOW - 30 * MIN, NOW)).toBe(false);
    // Widening this one would have put a rotated exit's old timezone on the
    // simulator's status bar for a whole session — the defect T-17 exists for.
    expect(isExitIdentityFresh(NOW - (CAPABILITY_REFRESH_AFTER_MS + SWEEP_INTERVAL_MS), NOW)).toBe(
      false,
    );
  });

  it('a FUTURE stamp is fresh on every one of the five predicates — a host clock that moved backwards (DST, an NTP correction, a VM resume) must not re-probe the customer’s whole list', () => {
    for (const fresh of [
      isQuicProbeFresh,
      isUdpVerdictFresh,
      isQuicVerdictFresh,
      isExitIdentityFresh,
    ])
      expect(fresh(NOW + HOUR, NOW)).toBe(true);
    expect(isOsFingerprintFresh(FP(NOW + HOUR), NOW)).toBe(true);
  });
});

describe('⛔ THE DELIBERATE GAP — server latency has NO display window at all', () => {
  // ⛔ (2026-09-17 review) THIS ARM EXISTS BECAUSE THE DEVIATION WAS INVISIBLE.
  // The item asked for an 8 h window on FOUR readings and three got one; the
  // fourth — the latency Driftstack measures — was deliberately left unbounded,
  // and that decision was recorded only in a hand-off note, which does not
  // survive the commit. So the file that exists to keep every window honest said
  // nothing about the one window that is infinite: exactly the silence this work
  // was written to remove. It is stated here, in the suite, where it reds.
  //
  // WHY UNBOUNDED IS THE RIGHT ANSWER HERE, and not an oversight:
  //  • ∞ >= C + S, so it satisfies the invariant — it is the one direction the
  //    invariant does not constrain. The defect was windows that were too SHORT.
  //  • It is already dated IN PLACE: `serverMeasuredAt` keys the same entry from
  //    `serverProbeAt`, so the surface prints the number beside its own age
  //    rather than silently retiring it.
  //  • It has no `AgedReadings` slot, so "past the window" has nowhere to render
  //    — narrowing it would DELETE the number instead of muting it, which is the
  //    muting cliff this whole item exists to remove.
  //  • ⛔ A DECISION consumes it: `rowStatusRank` in ProxiesView sorts the grid on
  //    it. Narrowing it would reorder the customer's rows on a timer.
  //
  // Giving it a real window means adding `serverLatency` to `AgedReadings`, a
  // muted/dated renderer on the grid, the card and the detail row, and deciding
  // what the sort does with an aged number. Until then: unbounded, and said so.
  it('CRITICAL a decade-old server latency still renders — it is dated in place, never retired. MUTATION: gate `serverLatency` in deriveProbeViewState on isQuicProbeFresh(c.serverProbeAt, nowMs) and this reds', () => {
    const DECADE = 10 * 365 * 24 * HOUR;
    const view = deriveProbeViewState(
      {
        p1: {
          // Usable — every reading in this derivation is gated on that, and this
          // arm is about the WINDOW, not about the usable gate.
          result: {
            reachable: true,
            auth_ok: true,
            udp_associate: true,
            can_route: true,
            connect_reply: 0,
            latency_ms: 40,
            message: 'ok',
          },
          at: NOW - DECADE,
          serverLatencyMs: 61,
          serverProbeAt: NOW - DECADE,
          // The control's reading, on the SAME entry and the SAME stamp.
          quicProbe: true,
          quicProbeAt: NOW - DECADE,
        },
      },
      NOW,
    );
    expect(view.serverLatency.p1).toBe(61);
    // …and it carries its own age, which is what makes the absent window honest
    // rather than a reading pretending to be current.
    expect(view.serverMeasuredAt.p1).toBe(NOW - DECADE);
    // THE CONTROL, in the same breath and off the same entry and stamp: a reading
    // that DOES have a window is gone at that age. Without it this arm would pass
    // just as happily against a derivation that stopped running at all.
    expect(view.quicProbe.p1).toBeUndefined();
    // …and past the thirty-day aged cap too, so nothing renders it muted either.
    expect(view.aged.quicProbe.p1).toBeUndefined();
  });
});
