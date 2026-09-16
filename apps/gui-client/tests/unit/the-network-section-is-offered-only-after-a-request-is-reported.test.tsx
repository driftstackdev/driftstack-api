// The simulator drawer's Network section — OFFERED ONLY ONCE THE SESSION HAS
// REPORTED A REQUEST (owner, 2026-09-16).
//
// The defect this pins: nothing on the device side reports requests, so the
// section was a rail icon every customer could click exactly once, landing on a
// permanently empty table with a sentence explaining that requests are not
// available. An always-empty section is worse than no section. The rail now
// withholds the entry until the session actually reports a request, and the entry
// appears — same place in the order, same label — the first time one arrives, and
// stays for the session.
//
// ⛔ WHAT IS NOT DONE HERE: nothing that RECEIVES is removed. The store, the poll
// and the table are untouched, and the second half of this file proves it by
// making a request arrive and then using the section.
//
// Two levels, deliberately:
//   1. the predicate (visibleSimDrawerPanes) — pure, so the rail order is pinned
//      without standing up a window, with a vacuity control on each arm;
//   2. the rendered window — because a correct predicate wired to nothing is the
//      failure mode a pure test cannot see.
//
// MUTATIONS — every one below was APPLIED, RUN against this file and RESTORED on
// 2026-09-16, and what is recorded is what the runner PRINTED, not what the edit
// was expected to do. The source was compared byte-for-byte against its snapshot
// after each, and the file re-ran 12/12 green at the end.
//
// ⚠️ 1-5 were RE-RUN on 2026-09-16 after the discovery rate bound went in, because
// that change restructured two of the lines they edit. The counts below are the
// re-measured ones; where an arm was added since, the note says so.
//   1. VISIBILITY — in SimulatorWindow.visibleSimDrawerPanes, force the predicate
//      true: `if (state.networkEverReported)` → `if (true)` (equivalently, delete
//      the filtered branch). 3 RED: 'withholds Network while the session has
//      reported nothing', 'the rail does not offer Network on a session that
//      reports nothing', and the minute-20 arm on its staging control (the section
//      must still be withheld at minute 19). Every arm that asserts a SHOWN
//      section stays green — that is what makes them controls, not restatements.
//   2. THE BURST STILL STOPS — in the poll's `tick`, spend the budget faster:
//      `networkDiscoveryLooksLeftRef.current -= 1` → `-= 3`. 5 RED (4 before arm 9
//      existed), the burst arm on the count it exists for, and the 8-hour arms on
//      the cost that follows from it: "expected 34 to be 39".
//   3. THE HEARTBEAT EXISTS — in `quieter`, collapse the
//      `if (discovering && networkDiscoveryBurstSpentRef.current)` branch into its
//      else, so the poll reschedules at the 120 s burst cap for the session's whole
//      life. 4 RED, and the idle arm reads out the exact cost the budget exists to
//      prevent: "expected 241 to be 39" — 30 looks/hour for eight hours against the
//      documented 4/hour. ('a bare 503 …' reds the same way: "expected 30 to be
//      less than or equal to 4".)
//      ⚠️ ARM 9 STAYS GREEN UNDER THIS ONE, and that is the finding, not a gap: the
//      heartbeat now has TWO homes. `quieter` drops to it after a quiet answer, and
//      the effect's seed re-derives it from the burstSpent latch on every re-run —
//      which exists for the re-run that races an in-flight look, whose cancelled
//      tick never reaches `quieter`. Rebinding every five minutes re-seeds often
//      enough to reconstruct the cadence from the seed alone. MEASURED: deleting
//      BOTH reds all five rate arms; either one alone leaves the other carrying it.
//   4. THE BURST IS NOT A VERDICT — in `tick`, latch the TERMINAL ref off the
//      budget again (`… <= 0) networkDiscoveryOffHereRef.current = true`), i.e.
//      restore the 2026-09-16 defect exactly. 4 RED (3 before arm 9 existed), and
//      the minute-20 arm reds on the REVEAL itself rather than on any count:
//      "expected null not to be null" — no rail entry at all, on a live session, for
//      the rest of its life. The rate arms read out the other half: "expected 8 to
//      be 39", a session that stopped looking eight looks in.
//   5. THE 503 DISCRIMINANT — in the discovery catch, drop the kind check back to
//      `networkDiscoveryOffHereRef.current = true` on the bare status. EXACTLY ONE
//      RED — 'a bare 503 from an intermediary does NOT permanently deny the
//      section' — while the typed-503 arm stays green. That pair is what separates
//      "switched off here" from "briefly unavailable".
//
// MUTATIONS 6-9 — the RATE BOUND (2026-09-16, the same day and the same defect
// class: a rule written as a count where the claim is about elapsed time). Arms 8
// and 9 are new; 6-9 were applied, run and restored the same way.
//   6. THE FIRST LOOK OF A RUN IS RATE-BOUND — in SimulatorWindow, delete the
//      `dueInMs` schedule and call `tick()` unconditionally again, i.e. the defect
//      exactly. EXACTLY ONE RED, arm 9: "expected 101 to be 39" — 96 transport
//      rebuilds over the day, 96 extra looks, on a poll documented at 4/hour. Every
//      no-rebind arm stays green, which is the whole point of the pair: they measure
//      the cadence, arm 9 measures whether the cadence survives a re-run. (Measured
//      against the pre-fix source itself, before either arm was written: 102.)
//   7. THE RAMP IS CARRIED — in the seed, `networkDiscoveryBackoffRef.current` →
//      `baseMs`, so a re-run restarts the burst at 30 s. ONE RED, arm 9, on the
//      TIMELINE and not on any count: received [0, 60, 180, 300, 330, 390, 510,
//      600] against the documented [… 420, 540, 660, 780]. ⛔ This is why arm 9
//      asserts offsets: the budget holds the count at 8 however fast they are spent,
//      so the 8-hour total came back 39 — correct — while the burst had been burned
//      by minute 10 and the session's first page load was on a 15-minute heartbeat.
//   8. THE LOOK IS STAMPED — delete `networkDiscoveryLastLookAtRef.current =
//      Date.now()` from `tick`. ONE RED, arm 9: "expected 101 to be 39" (with no
//      stamp the ref stays null, every run is due now, and 6 and 8 coincide).
//   9. THE RAMP IS RECORDED — delete `if (discovering)
//      networkDiscoveryBackoffRef.current = backoff` from `quieter`. ONE RED, arm 9,
//      the same timeline as 7 — the seed can only carry what `quieter` wrote.
//
// Mock shape mirrors simulator-window-cookies.test.tsx (the AgentSessionPanel →
// room pattern). The network feed is mocked through importOriginal so the REAL
// store/validation still run and only the fetch is stubbed (N-1: hand-listing
// that module's exports would strand every future one as undefined).

import { useEffect, useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
// Type-only (erased): names the real feed module so the mock factory can spread
// it without an inline `import()` type annotation, which this repo's lint forbids.
import type * as NetworkFeedModule from '../../src/lib/network-log-feed';

const networkMock = vi.fn();

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));

/** A fresh transport object. Room IDENTITY is what the window keys its binding on
 *  (SimulatorWindow.handleRoom early-returns when `current.room === nextRoom`), so
 *  handing back a NEW object is exactly what the real panel does when it rebuilds
 *  the Room: an unexpected transport drop auto-reconnects through `retryNonce`
 *  (AgentSessionPanel connect effect, deps `[info.ws_url, info.token, retryNonce]`)
 *  and the freeze driver's 'rebuild' escalation bumps the same nonce. Neither is
 *  rare, and neither is anything the customer did. */
const makeRoom = (): unknown => ({
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
});
const fakeRoom = makeRoom();
/** Window event the mocked panel listens on, so an arm can rebind the transport
 *  mid-timeline. ⛔ Nothing dispatches it unless an arm asks: every other arm sees
 *  the single frozen `fakeRoom` it saw before, which is what keeps them controls
 *  for the rebinding arms rather than duplicates of them. */
const REBIND_EVENT = 'ds-test-transport-rebind';
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    const [room, setRoom] = useState<unknown>(fakeRoom);
    useEffect(() => {
      const onRebind = (): void => setRoom(makeRoom());
      window.addEventListener(REBIND_EVENT, onRebind);
      return () => window.removeEventListener(REBIND_EVENT, onRebind);
    }, []);
    useEffect(() => {
      props.onRoom?.(room, room);
    }, [props, room]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  uploadAgentSessionFile: () => Promise.resolve({ status: 'unavailable', handle: null }),
  listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
  fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {
    constructor(
      message: string,
      public status = 0,
      public kind = 'unknown',
    ) {
      super(message);
    }
  },
}));

// Keep the REAL store + protocol validation; stub only the wire call.
vi.mock('../../src/lib/network-log-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof NetworkFeedModule>();
  return {
    ...actual,
    fetchAgentSessionNetwork: (...a: unknown[]) => networkMock(...a) as unknown,
  };
});

const {
  SimulatorWindow,
  visibleSimDrawerPanes,
  NETWORK_DISCOVERY_MAX_LOOKS,
  NETWORK_DISCOVERY_HEARTBEAT_MS,
  NETWORK_DISCOVERY_IDLE_LOOKS_PER_HOUR,
} = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
// The MOCKED class above — the same constructor the window's `instanceof` sees.
const { AgentSessionControlError } = await import('../../src/lib/agent-session-control');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_net');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

const rail = (c: HTMLElement, pane: string): Element | null =>
  c.querySelector(`[data-component="sim-rail-${pane}"]`);

/** One reported request, in the shape the ring serves. */
const ONE_REQUEST = {
  id: 'r1',
  url: 'https://example.com/app.js',
  method: 'GET',
  status: 200,
  protocol: 'h3',
  started_at: 1,
};

const EMPTY_OK = { status: 'ok' as const, entries: [], next_after: null, reason: null };
const ONE_OK = {
  status: 'ok' as const,
  entries: [ONE_REQUEST],
  next_after: 'r1',
  reason: null,
};

describe('the drawer offers Network only after the session reports a request', () => {
  beforeEach(() => {
    networkMock.mockReset();
  });

  // ---- 1. the predicate ----------------------------------------------------

  it('withholds Network while the session has reported nothing', () => {
    const panes = visibleSimDrawerPanes({ networkEverReported: false });
    expect(panes).not.toContain('network');
    // VACUITY CONTROL — the filter removes exactly one entry and disturbs no
    // other. Without this, "no network" would also pass for an empty rail.
    expect(panes).toEqual([
      'session',
      'controls',
      'diagnostics',
      'cookies',
      'files',
      'downloads',
      'recording',
    ]);
  });

  it('offers Network once a request has been reported, in the same place in the order', () => {
    const panes = visibleSimDrawerPanes({ networkEverReported: true });
    expect(panes).toEqual([
      'session',
      'controls',
      'diagnostics',
      'cookies',
      'network',
      'files',
      'downloads',
      'recording',
    ]);
    // It returns to its original slot (after Cookies), not to the end of the rail.
    expect(panes.indexOf('network')).toBe(4);
  });

  // ---- 2. the rendered window ---------------------------------------------

  it('CRITICAL the rail does not offer Network on a session that reports nothing', async () => {
    networkMock.mockResolvedValue(EMPTY_OK);
    const { container, unmount } = renderSim();
    try {
      // The window LOOKED: a section that is never asked about could be "hidden"
      // for the wrong reason, and the reveal below would be unreachable in the
      // shipped app. This is the discovery poll running with the section closed.
      await waitFor(() => expect(networkMock).toHaveBeenCalled());
      expect(networkMock.mock.calls[0]?.[0]).toBe('agt_net');
      // VACUITY CONTROL — the rail itself rendered, and its neighbours are there.
      expect(rail(container, 'cookies')).not.toBeNull();
      expect(rail(container, 'files')).not.toBeNull();
      expect(rail(container, 'network')).toBeNull();
      // And nothing rendered the empty table behind the operator's back.
      expect(container.querySelector('[data-component="simulator-network"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('CRITICAL one reported request makes the section appear, with no click needed', async () => {
    networkMock.mockResolvedValue(ONE_OK);
    const { container, unmount } = renderSim();
    try {
      const icon = await waitFor(() => {
        const el = rail(container, 'network');
        expect(el).not.toBeNull();
        return el as Element;
      });
      // Same label the section always had.
      expect(icon.getAttribute('aria-label')).toBe('Network');
      expect(
        container.querySelector('[data-component="sim-rail-label-network"]')?.textContent,
      ).toBe('Network');
      // The ring has already handed over its one entry; later polls page from the
      // cursor and carry nothing new. (Left on ONE_OK the stub would re-serve the
      // same id every 3s and the pane would stack duplicates — an artefact of the
      // stub, not of the feed.)
      networkMock.mockResolvedValue(EMPTY_OK);
      // The receiving half still works: opening it shows the reported request.
      fireEvent.click(icon);
      await waitFor(() => {
        expect(container.querySelector('[data-component="simulator-network"]')).not.toBeNull();
      });
      await waitFor(() => {
        expect(container.querySelectorAll('[data-component="simulator-network-row"]').length).toBe(
          1,
        );
      });
      expect(container.textContent).toContain('app.js');
    } finally {
      unmount();
    }
  });

  it('CRITICAL the section stays for the session after Clear empties the view', async () => {
    // "Appears on the first request and STAYS" — Clear empties the local view, it
    // does not un-report what the session already sent, so the entry must survive
    // the store going back to an empty array.
    networkMock.mockResolvedValue(ONE_OK);
    const { container, unmount } = renderSim();
    try {
      const icon = await waitFor(() => {
        const el = rail(container, 'network');
        expect(el).not.toBeNull();
        return el as Element;
      });
      networkMock.mockResolvedValue(EMPTY_OK); // the ring has nothing further to page
      fireEvent.click(icon);
      const clear = await waitFor(() => {
        const b = container.querySelector('[data-action="clear-network"]');
        expect(b).not.toBeNull();
        expect((b as HTMLButtonElement).disabled).toBe(false);
        return b as HTMLButtonElement;
      });
      fireEvent.click(clear);
      await waitFor(() => {
        expect(
          container.querySelector('[data-component="simulator-network-empty"]'),
        ).not.toBeNull();
      });
      expect(rail(container, 'network')).not.toBeNull();
    } finally {
      unmount();
    }
  });
});

// ---- 3. what the withheld section COSTS, and how long it stays REACHABLE ----
//
// Withholding a section is only an improvement if it is also cheaper. Before the
// rail change a closed pane issued zero requests; the discovery poll that makes
// the reveal possible must not turn that into a request every couple of minutes
// for the rest of the session, on every open simulator window, on behalf of a
// producer that does not exist yet. Each look is authenticated and spends the
// account's own rate-limit budget, so "how many" is a correctness question.
//
// ⛔ The first version of discovery stopped on ONE condition — an HTTP 503 — and
// that condition cannot occur on any deployment a customer can open a session on:
// the route answers 200 `{status:'unavailable'}` with no store and 200
// `{status:'ok',entries:[]}` with one (it is always constructed), and the 503 stub
// is registered only where GET /v1/agent-sessions/:id is itself a 503. So the stop
// never fired and the poll ran forever. These arms pin the stops that do fire.
//
// ⛔ AND THEN THE BUDGET THAT FIXED THAT BECAME THE NEXT DEFECT (2026-09-16). A
// budget that ends DISCOVERY ends the SECTION: about 13 minutes into a session
// that is still running the last look is spent, and from that moment no request
// the session reports can reveal the pane — the store would serve it happily and
// nothing is left to ask. A customer who browses quietly for a quarter of an hour
// and then loads a page gets no pane at all, for the whole session. The budget now
// bounds the RATE of an opening BURST, and discovery then drops to a heartbeat it
// keeps for the session's life. That takes THREE properties together, one per arm:
//   • the burst still stops — the count of looks in the first 13 minutes is
//     unchanged (NETWORK_DISCOVERY_MAX_LOOKS), and the 120 s cadence is over;
//   • the idle cost is the DOCUMENTED one — 4 looks/hour steady state, 39 in an
//     idle 8-hour session (8 burst + 31 heartbeats), where the poll this budget
//     was introduced to kill would have spent 240;
//   • a live session stays REACHABLE — a first request at minute 20 reveals the
//     section, which is the arm that would have caught the defect above.
//
// ⛔ AND A FOURTH, ADDED THE SAME DAY, BECAUSE THE THREE ABOVE WERE ALL MEASURED IN
// THE ONE STATE WHERE THE RATE CANNOT BE VIOLATED. Each of them renders once against
// a single frozen Room, so the discovery effect runs exactly ONCE for the whole
// timeline and no dep ever changes — and the budget, being spent per LOOK, bounds
// the looks per effect RUN. "4 looks/hour" is a claim about elapsed time, and the
// two only agree while nothing re-runs the effect. The product re-runs it on its
// own: AgentSessionPanel rebuilds the Room on an unexpected transport drop and on
// the freeze driver's 'rebuild' escalation, and `room` is a dep of the poll. Before
// the rate bound, ONE rebind bought an immediate extra look and ten two minutes
// apart sustained 30 looks/hour — the exact rate this budget exists to kill.
//   • the cadence SURVIVES A RE-RUN — the same idle day with the transport rebuilt
//     every five virtual minutes lands the same 39 looks on the same offsets.
// Its control is the arm above it: a rebind DOES re-run the poll (proved on the open
// pane, where refreshing at once is correct), so a green there is never a green about
// an event the window never heard.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The burst's own window. Its looks land at t = 0, 60, 180, 300, 420, 540, 660 and
 *  780 s (base 30 s doubling to a 120 s cap), so 13 minutes contains the entire
 *  burst and no heartbeat — the first of those is at 780 + 900 = 1680 s. */
const BURST_WINDOW_MS = 13 * MINUTE_MS;
/** The idle 8-hour cost written down on NETWORK_DISCOVERY_HEARTBEAT_MS, pinned here
 *  as that literal number rather than recomputed from the constants under test: a
 *  guard that derives its expectation from the value it is guarding follows a
 *  mutated heartbeat wherever it goes and never reds. 8 burst looks +
 *  floor((28800 − 780) / 900) = 31 heartbeats. */
const IDLE_8H_LOOKS = 39;
/** The burst's documented SHAPE, as the literal offsets the constant's comment
 *  quotes — base 30 s doubling to a 120 s cap. A count alone cannot see the failure
 *  it is written for: a budget spent per look caps the count at 8 whatever provokes
 *  them, so a reconnect storm that burns the burst in the opening minutes leaves the
 *  count at 8 and the session on a 15-minute heartbeat from minute 7, which the
 *  customer meets as reveal latency on their very first page load. */
const BURST_OFFSETS_MS = [0, 60, 180, 300, 420, 540, 660, 780].map((s) => s * 1000);

describe('discovery for the withheld section is bounded in RATE, not in reach', () => {
  beforeEach(() => {
    networkMock.mockReset();
    // ⛔ THE DEADLINE IS THE THIRD ARGUMENT ON EACH HEAVY `it`, NOT A CALL HERE.
    //
    // The four arms that walk HOURS of virtual time step tens of thousands of
    // scheduled timers one at a time. Virtual time is free; the STEPPING is real
    // work whose wall-clock cost scales with machine load. Alone this file finishes
    // in 4 s; under the push gate, which runs all 3455 files in parallel, those arms
    // overran the 10 s default and failed — green by themselves every time anyone
    // went to look, which is the worst diagnostic shape there is.
    //
    // The first attempt at this fix put `vi.setConfig({ testTimeout: 60_000 })`
    // right here. It silently did nothing: the next gate reported the identical
    // "Test timed out in 10000ms", because the deadline for a test is already
    // running by the time its own `beforeEach` executes. That cost a whole gate
    // cycle and is exactly the shape worth leaving a note about — a remedy that
    // looks applied, reads as applied in review, and never took effect. The
    // per-test argument is unambiguous, so that is what is used.
  });

  /** Arm the fetch stub and hand back the (growing) list of look offsets, in
   *  VIRTUAL ms from `t0`. `answer` receives the offset the look arrived at and
   *  returns its promise — resolved or rejected — which is how "the session reports
   *  its first request at minute 20" is written down as a fact about the clock
   *  rather than as a call-count the arm has to guess at. */
  function armLooks(t0: number, answer: (elapsedMs: number) => Promise<unknown>): number[] {
    const offsets: number[] = [];
    networkMock.mockImplementation(() => {
      const at = Date.now() - t0;
      offsets.push(at);
      return answer(at);
    });
    return offsets;
  }

  /** The mount issues its first look synchronously inside the effect, but that
   *  look's promise settles — and schedules look 2 — in a microtask. Settle it
   *  before advancing anything, and ASSERT it happened: a run that quietly started
   *  from zero looks reads as a calm session when it is really a broken harness. */
  async function settleFirstLook(looks: number[]): Promise<void> {
    // ⛔ ONE flush is not enough, and the failure is load-dependent — which is the
    // worst shape: green on this file alone, red only in the push gate, where every
    // file runs in parallel and the mount's effect can still be pending when the
    // single `act` returns. It cost a whole gate cycle (5 arms red at 17:24, the
    // same file green in 4 s by itself).
    //
    // Flushing until the look ARRIVES removes the assumption about how many
    // microtask turns the effect needs, without weakening anything: the assertion
    // below is unchanged, so a run where the look never lands still fails loudly
    // rather than sliding on to advance a clock nobody is polling. The cap is a
    // runaway guard, not a budget — reaching it falls through to the assertion,
    // which is the honest report.
    for (let i = 0; i < 50 && looks.length === 0; i += 1) {
      await act(async () => {});
    }
    // ⛔ AND THEN ONE MORE, unconditionally. The loop above stops the moment the
    // look is ISSUED, which is strictly earlier than the old single flush stopped:
    // that one also settled the look's RESPONSE and rendered what it revealed. An
    // arm that goes straight from here to reading the rail found no network icon
    // and failed on `expect(icon).not.toBeNull()` — a green helper handing back a
    // half-settled window. The loop makes the effect's arrival certain; this makes
    // its answer's arrival certain.
    await act(async () => {});
    expect(looks).toEqual([0]);
  }

  /** Advance the window by `ms` of VIRTUAL time, stepping to each next scheduled
   *  timer with microtasks flushed between, so every look's promise settles and
   *  schedules (or declines to schedule) its successor.
   *
   *  ⛔ Do NOT replace this with one wide `advanceTimersByTimeAsync`. Two failures
   *  came out of trying:
   *   1. a single wide advance drains the timers queued when it starts; each look
   *      settles a promise and only THEN schedules its successor, so under the full
   *      suite (the push gate runs every file in parallel) the render's first effect
   *      can land after the advance begins and the run comes up a look short — green
   *      alone, red in the gate.
   *   2. looping a wide advance is worse: hours of fake time make every OTHER timer
   *      the window mounts fire hundreds of times per pass, and the test hit the 10 s
   *      timeout instead.
   *  Stepping jumps exactly as far as whatever is scheduled asks for.
   *
   *  ⛔ The iteration cap is a RUNAWAY GUARD, never a budget, and the assertion
   *  underneath it is what makes that true. An earlier version of this helper ended
   *  its loop on an "idle" heuristic, stopped between look 1 and look 2, and
   *  reported a budget of ONE — which reads as a product bug and was an artefact of
   *  the helper. Exhausting the cap now fails the arm out loud instead. */
  async function advanceVirtualMs(ms: number): Promise<void> {
    const until = Date.now() + ms;
    await act(async () => {
      for (let i = 0; i < 200_000; i += 1) {
        if (Date.now() >= until) break;
        if (vi.getTimerCount() === 0) {
          // Nothing is scheduled at all (every poll stood down). Jump the clock so
          // the caller's window is still the window it asked for.
          await vi.advanceTimersByTimeAsync(until - Date.now());
          break;
        }
        await vi.advanceTimersToNextTimerAsync();
      }
    });
    expect(Date.now()).toBeGreaterThanOrEqual(until);
  }

  /** Looks that landed in the half-open window [fromMs, toMs) — counted from the
   *  timestamps, not from where the stepping loop happened to stop, so a step that
   *  overshoots the deadline (the next timer is simply further out) cannot inflate
   *  a count. Half-open is what the per-hour buckets below want; the burst wants
   *  `through`, see there. */
  const within = (looks: readonly number[], fromMs: number, toMs: number): number =>
    looks.filter((at) => at >= fromMs && at < toMs).length;

  /** Looks up to AND INCLUDING `throughMs`.
   *
   *  ⛔ The burst's last look lands on exactly 780 000 ms, which is exactly the
   *  13-minute boundary the budget is quoted at, so counting it half-open drops it
   *  and reports a burst of 7 — a number that reads as a product regression and is
   *  purely the boundary. The burst window is stated inclusively for that reason. */
  const through = (looks: readonly number[], throughMs: number): number =>
    looks.filter((at) => at <= throughMs).length;

  it('CRITICAL the opening burst still stops — a healthy-but-empty deployment is not fast-polled', async () => {
    // The shape EVERY real deployment answers with today: store present, session
    // active, ring empty. Nothing in this answer will ever say "stop", so the burst
    // budget is the only thing that can end the fast looking.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, () => Promise.resolve(EMPTY_OK));
      const { unmount } = renderSim();
      await settleFirstLook(looks);
      await advanceVirtualMs(BURST_WINDOW_MS);
      expect(through(looks, BURST_WINDOW_MS)).toBe(NETWORK_DISCOVERY_MAX_LOOKS);
      // …and WHERE they land, which is what the constant's comment quotes.
      expect(looks.filter((at) => at <= BURST_WINDOW_MS)).toEqual(BURST_OFFSETS_MS);
      // VACUITY CONTROL — it really did poll; a burst of zero would also be
      // "bounded" and would break the reveal entirely.
      expect(NETWORK_DISCOVERY_MAX_LOOKS).toBeGreaterThan(1);
      // And the fast cadence is OVER, not merely a little slower: at the burst's own
      // 120 s cap the next ten minutes would carry five more looks. The heartbeat
      // puts the next one at 28 minutes, so this window holds none.
      const spent = looks.length;
      await advanceVirtualMs(10 * MINUTE_MS);
      expect(looks.length - spent).toBeLessThanOrEqual(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a first request at minute 20 still reveals the section', async () => {
    // THE DEFECT THIS ARM EXISTS FOR. The session is live and quiet for a quarter of
    // an hour — a customer reading a page — and only then loads something. Under the
    // terminal budget the last look had been spent at minute 13 and this session
    // could never show the pane again.
    const REPORTED_AT_MS = 20 * MINUTE_MS;
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, (at) => Promise.resolve(at >= REPORTED_AT_MS ? ONE_OK : EMPTY_OK));
      const { container, unmount } = renderSim();
      await settleFirstLook(looks);
      // STAGING CONTROL — at minute 19 the burst is long spent and the session has
      // still reported nothing, so the section is still (correctly) withheld. Without
      // this the arm below could pass on a section that was never withheld at all.
      await advanceVirtualMs(19 * MINUTE_MS);
      expect(looks.length).toBe(NETWORK_DISCOVERY_MAX_LOOKS);
      expect(rail(container, 'network')).toBeNull();
      // The customer loads a page at minute 20; the next heartbeat look sees it.
      await advanceVirtualMs(NETWORK_DISCOVERY_HEARTBEAT_MS + MINUTE_MS);
      expect(rail(container, 'network')).not.toBeNull();
      expect(rail(container, 'network')?.getAttribute('aria-label')).toBe('Network');
      // VACUITY CONTROL — the rail is the real rail, with its neighbours in place.
      expect(rail(container, 'cookies')).not.toBeNull();
      expect(rail(container, 'files')).not.toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL an idle 8-hour session costs the documented 4 looks/hour', async () => {
    // The number in this arm is the reason the budget exists, so it is measured over
    // a whole working day of an empty deployment rather than asserted about one gap.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, () => Promise.resolve(EMPTY_OK));
      const { unmount } = renderSim();
      await settleFirstLook(looks);
      await advanceVirtualMs(8 * HOUR_MS);
      expect(within(looks, 0, 8 * HOUR_MS)).toBe(IDLE_8H_LOOKS);
      // Steady state: every hour after the burst's own is at or under the documented
      // rate. (Hour 0 carries the burst as well, which is what the burst is for.)
      for (let hour = 1; hour < 8; hour += 1) {
        expect(within(looks, hour * HOUR_MS, (hour + 1) * HOUR_MS)).toBeLessThanOrEqual(
          NETWORK_DISCOVERY_IDLE_LOOKS_PER_HOUR,
        );
      }
      // VACUITY CONTROL — a poll that had stood down would also satisfy every
      // "at most" above. It is still watching in the eighth hour, which is the whole
      // point: this session can still reveal the section.
      expect(within(looks, 7 * HOUR_MS, 8 * HOUR_MS)).toBeGreaterThan(0);
      // And the spacing IS the heartbeat, not a ramp that happens to average out.
      const inWindow = looks.filter((at) => at < 8 * HOUR_MS);
      expect(inWindow[inWindow.length - 1] - inWindow[inWindow.length - 2]).toBe(
        NETWORK_DISCOVERY_HEARTBEAT_MS,
      );
      unmount();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('CRITICAL a typed feature-unavailable 503 stops discovery at one look', async () => {
    // The one answer that IS a statement about the deployment: the gated stub's
    // FeatureUnavailable problem type, which the shared transport puts in `kind`.
    // This is the ONLY terminal stop left, so it is checked over hours, not looks.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, () =>
        Promise.reject(
          new AgentSessionControlError('Not on this deployment.', 503, 'feature-unavailable'),
        ),
      );
      const { unmount } = renderSim();
      await settleFirstLook(looks);
      await advanceVirtualMs(2 * HOUR_MS);
      expect(looks.length).toBe(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it('CRITICAL a bare 503 from an intermediary does NOT permanently deny the section', async () => {
    // A gateway / load balancer / rolling restart answers 503 with a non-JSON body,
    // which lands on kind 'unknown'. Latching on the bare status would have denied
    // the section for the whole session to a session that may report a request a
    // minute later. It keeps looking — at the burst rate while the budget lasts, at
    // the heartbeat after it, never stopped by the status alone.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, () =>
        Promise.reject(new AgentSessionControlError('HTTP 503', 503, 'unknown')),
      );
      const { unmount } = renderSim();
      await settleFirstLook(looks);
      await advanceVirtualMs(BURST_WINDOW_MS);
      expect(looks.length).toBeGreaterThan(1);
      expect(through(looks, BURST_WINDOW_MS)).toBe(NETWORK_DISCOVERY_MAX_LOOKS);
      // A flapping intermediary does not cost more than a healthy empty page, and it
      // does not end the session's chance of a reveal either.
      const spent = looks.length;
      await advanceVirtualMs(HOUR_MS);
      expect(looks.length).toBeGreaterThan(spent);
      expect(looks.length - spent).toBeLessThanOrEqual(NETWORK_DISCOVERY_IDLE_LOOKS_PER_HOUR);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  /** Rebuild the session's transport the way the product does it to itself: the
   *  mocked panel hands the window a NEW Room object, which changes the identity of
   *  the `room` dep every poll in the window is keyed on. Wrapped in `act` so the
   *  re-render and the effect re-run have landed before the caller advances the
   *  clock again. */
  async function rebindTransport(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event(REBIND_EVENT));
      // The awaited body is what makes this an ASYNC act: React re-renders, the poll
      // effect tears down and re-runs, and whatever that run issues settles its
      // promise here — before the caller advances the clock a single tick further.
      await Promise.resolve();
    });
  }

  it('CRITICAL a transport rebind really does re-run the poll — the arm below is not vacuous', async () => {
    // POSITIVE CONTROL for the rate arm underneath, and the reason it is written
    // against the OPEN section: there this is the 3 s LIVE FEED, where re-running on
    // a new transport and refreshing at once is the wanted behaviour and is left
    // alone on purpose. Without this arm, "rebinding does not raise the idle rate"
    // could pass by the rebind never reaching the window at all — a green that is a
    // statement about an event nobody heard. It also pins the asymmetry: the same
    // rebind that refreshes an open feed immediately buys discovery nothing.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      let answer: unknown = ONE_OK;
      const looks = armLooks(t0, () => Promise.resolve(answer));
      const { container, unmount } = renderSim();
      await settleFirstLook(looks);
      // The one reported request has revealed the section; page from the cursor from
      // here so the stub does not re-serve the same id every 3 s.
      answer = EMPTY_OK;
      const icon = rail(container, 'network');
      expect(icon).not.toBeNull();
      await act(async () => {
        fireEvent.click(icon as Element);
        // Same reason as rebindTransport: settle the look the newly-active pane
        // issues, so `spent` below counts a finished cadence and not a race.
        await Promise.resolve();
      });
      await advanceVirtualMs(10_000);
      const spent = looks.length;
      // VACUITY CONTROL — the live feed is actually running at its own cadence, so
      // "one more look" below is one more than a real number.
      expect(spent).toBeGreaterThan(1);
      await rebindTransport();
      expect(looks.length).toBe(spent + 1);
      // And it went out AT ONCE — zero delay after the rebind, which is exactly the
      // behaviour discovery must NOT have.
      expect(looks[looks.length - 1]).toBe(Date.now() - t0);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a reconnecting idle session still costs the documented 4 looks/hour', async () => {
    // ⛔ THE ARM THE IDLE ONE ABOVE CANNOT BE. Every other arm in this file renders
    // once against one frozen Room, so the discovery effect runs exactly ONCE for the
    // whole timeline and no dep ever changes — which measures the cadence in the one
    // state where it cannot be violated. A budget spent per LOOK bounds the count of
    // looks per effect run; the documented 4/hour is a claim about ELAPSED TIME, and
    // the two only agree while nothing re-runs the effect. The product re-runs it on
    // its own: an unexpected transport drop auto-reconnects with a fresh Room and the
    // freeze driver's 'rebuild' escalation does the same, neither of them anything the
    // customer did. Measured before the rate bound went in, one rebind bought an
    // immediate extra look and ten rebinds two minutes apart sustained 30 looks/hour —
    // the exact rate this whole budget exists to kill.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const looks = armLooks(t0, () => Promise.resolve(EMPTY_OK));
      const { unmount } = renderSim();
      await settleFirstLook(looks);
      const REBIND_EVERY_MS = 5 * MINUTE_MS;
      const rebinds = (8 * HOUR_MS) / REBIND_EVERY_MS;
      for (let i = 0; i < rebinds; i += 1) {
        await advanceVirtualMs(REBIND_EVERY_MS);
        await rebindTransport();
      }
      // The cadence is a property of the clock, not of how many times the effect ran:
      // 96 transport rebuilds over the day and the timeline is the documented one.
      expect(within(looks, 0, 8 * HOUR_MS)).toBe(IDLE_8H_LOOKS);
      for (let hour = 1; hour < 8; hour += 1) {
        expect(within(looks, hour * HOUR_MS, (hour + 1) * HOUR_MS)).toBeLessThanOrEqual(
          NETWORK_DISCOVERY_IDLE_LOOKS_PER_HOUR,
        );
      }
      // The BURST is a property of the clock too — a rocky start (a reconnect storm)
      // must not spend the eight looks early and leave the session's first page load
      // waiting a quarter of an hour for a heartbeat. ⛔ THE COUNT CANNOT SEE THAT:
      // the budget caps it at 8 however fast they are spent, so the offsets are the
      // assertion and `through` is only the headline. Byte-identical to the
      // no-rebind arm's timeline, which is the whole claim.
      expect(through(looks, BURST_WINDOW_MS)).toBe(NETWORK_DISCOVERY_MAX_LOOKS);
      expect(looks.filter((at) => at <= BURST_WINDOW_MS)).toEqual(BURST_OFFSETS_MS);
      // VACUITY CONTROL — it is still watching in the eighth hour. A poll that had
      // stood down would satisfy every "at most" above.
      expect(within(looks, 7 * HOUR_MS, 8 * HOUR_MS)).toBeGreaterThan(0);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
