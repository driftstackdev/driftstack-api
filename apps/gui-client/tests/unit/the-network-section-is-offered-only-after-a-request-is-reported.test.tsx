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
// MUTATIONS (stated for the record):
//   1. VISIBILITY — in SimulatorWindow.visibleSimDrawerPanes, force the predicate
//      true: `if (state.networkEverReported)` → `if (true)` (equivalently, delete
//      the filtered branch). The hidden arms — 'withholds Network while the
//      session has reported nothing' and the rendered 'the rail does not offer
//      Network on a session that reports nothing' — turn RED; every shown-arm
//      stays green, which is what makes them a control rather than a restatement.
//   2. BOUNDED DISCOVERY — in the network poll's `.finally`, delete
//      `if (discovering && networkDiscoveryStoppedRef.current) return;`. The poll
//      reschedules forever and 'a healthy-but-empty deployment spends a bounded
//      budget, not the session' turns RED (it keeps counting past the budget).
//   3. THE 503 DISCRIMINANT — in the discovery catch, drop the kind check back to
//      `if (status === 503) networkDiscoveryStoppedRef.current = true;`. 'a bare
//      503 from an intermediary does NOT permanently deny the section' turns RED
//      at one look, while the typed-503 arm stays green — the pair is what
//      separates "switched off here" from "briefly unavailable".
//
// Mock shape mirrors simulator-window-cookies.test.tsx (the AgentSessionPanel →
// room pattern). The network feed is mocked through importOriginal so the REAL
// store/validation still run and only the fetch is stubbed (N-1: hand-listing
// that module's exports would strand every future one as undefined).

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
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

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
    }, [props]);
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

const { SimulatorWindow, visibleSimDrawerPanes, NETWORK_DISCOVERY_MAX_LOOKS } =
  await import('../../src/views/SimulatorWindow');
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

// ---- 3. what the withheld section COSTS ------------------------------------
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
// never fired and the poll ran forever. These arms pin the two stops that do fire.
describe('discovery for the withheld section terminates', () => {
  beforeEach(() => {
    networkMock.mockReset();
  });

  /** Run a mounted window forward past every discovery backoff, with microtasks
   *  flushed between timers so each look's promise settles and schedules (or
   *  declines to schedule) the next. Two hours is far beyond the budget's reach. */
  async function runPastEveryBackoff(): Promise<void> {
    // ⛔ Do NOT advance a wide window here. Two failures came out of trying:
    //  1. ONE `advanceTimersByTimeAsync(2h)` drains only the timers already
    //     queued when it starts. Each look settles a promise and only THEN
    //     schedules its successor, so under the full suite (the push gate runs
    //     every file in parallel) the render's first effect can land after the
    //     advance begins and the run comes up a look short — green alone, red
    //     in the gate.
    //  2. Looping that wide advance is worse: two fake hours make every OTHER
    //     timer the window mounts fire hundreds of times per pass, and the test
    //     hit the 10s timeout instead.
    // Step to the NEXT timer instead: it jumps exactly as far as the backoff
    // chain asks for, settles the promise, and costs one iteration per look.
    // Stop when nothing is scheduled at all, or when a long run of timers has
    // produced no new look (the chain has stood down).
    // ⛔ `idle` must be GENEROUS. The window mounts other timers, and they
    // interleave with the backoff chain — a tight allowance (8) ended the loop
    // between look 1 and look 2 and reported a budget of ONE, which reads as a
    // product bug and is an artefact of this helper. Both bounds are runaway
    // guards, never budgets: a chain that polls forever keeps resetting `idle`,
    // runs to the iteration cap, and then fails the caller's exact-count
    // assertion — which is the regression this file exists to catch.
    for (let i = 0, idle = 0; i < 2000 && idle < 200; i += 1) {
      if (vi.getTimerCount() === 0) break;
      const before = networkMock.mock.calls.length;
      await vi.advanceTimersToNextTimerAsync();
      idle = networkMock.mock.calls.length === before ? idle + 1 : 0;
    }
  }

  it('CRITICAL a healthy-but-empty deployment spends a bounded budget, not the session', async () => {
    // The shape EVERY real deployment answers with today: store present, session
    // active, ring empty. Nothing in this answer will ever say "stop", so the
    // budget is the only thing that can.
    networkMock.mockResolvedValue(EMPTY_OK);
    vi.useFakeTimers();
    try {
      const { unmount } = renderSim();
      await runPastEveryBackoff();
      expect(networkMock).toHaveBeenCalledTimes(NETWORK_DISCOVERY_MAX_LOOKS);
      // VACUITY CONTROL — it really did poll; a budget of zero would also be
      // "bounded" and would break the reveal entirely.
      expect(NETWORK_DISCOVERY_MAX_LOOKS).toBeGreaterThan(1);
      // And the budget is SPENT, not merely slow: more time buys no more looks.
      const spent = networkMock.mock.calls.length;
      await runPastEveryBackoff();
      expect(networkMock.mock.calls.length).toBe(spent);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a typed feature-unavailable 503 stops discovery at one look', async () => {
    // The one answer that IS a statement about the deployment: the gated stub's
    // FeatureUnavailable problem type, which the shared transport puts in `kind`.
    networkMock.mockRejectedValue(
      new AgentSessionControlError('Not on this deployment.', 503, 'feature-unavailable'),
    );
    vi.useFakeTimers();
    try {
      const { unmount } = renderSim();
      await runPastEveryBackoff();
      expect(networkMock).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CRITICAL a bare 503 from an intermediary does NOT permanently deny the section', async () => {
    // A gateway / load balancer / rolling restart answers 503 with a non-JSON body,
    // which lands on kind 'unknown'. Latching on the bare status would have denied
    // the section for the whole session to a session that may report a request a
    // minute later. It must keep looking — bounded by the budget like any other
    // quiet answer, never stopped by the status alone.
    networkMock.mockRejectedValue(new AgentSessionControlError('HTTP 503', 503, 'unknown'));
    vi.useFakeTimers();
    try {
      const { unmount } = renderSim();
      await runPastEveryBackoff();
      expect(networkMock.mock.calls.length).toBeGreaterThan(1);
      expect(networkMock).toHaveBeenCalledTimes(NETWORK_DISCOVERY_MAX_LOOKS);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
