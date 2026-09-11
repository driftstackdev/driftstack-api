// (n) N13 — the iPhone status-bar clock kept showing the Mac's time for up to a
// minute after the tunnel's exit timezone landed.
//
// MEASURED: `useStatusClock` seeds `time` ONCE (useState initialiser) and its
// effect only re-armed the minute-boundary timer on a `timeZone` change — no
// `setTime` ran, so nothing repainted until the next :00 rollover. A SOCKS5
// session never took that path: its zone is known at mount and arrives in the
// handoff query as `tz`. A WireGuard/OpenVPN launch hands `tz: ''` whenever no
// fresh exit is cached (this Mac cannot probe through the tunnel), so the zone
// arrives MID-SESSION on the capability report's `exit_timezone`
// (SimulatorWindow.tsx `displayTimezone = sessionCapabilityReport?.exit_timezone
// ?? timezone`) — and for up to 60s the status bar contradicted the drawer and
// the egress strip, which already read the exit's zone.
//
// MUTATION: delete the `setTime(formatStatusTime(new Date(), timeZone));` line
// added before `schedule()` in useStatusClock → the CRITICAL arm below still
// reads the host's 12:00 after the Tokyo report lands → red. The "no boundary
// crossed" control is what makes that specific: the clock is only 10 simulated
// seconds past 12:00:05, so nothing but the zone change can have repainted it.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

// The assertion compares the exit zone's hour against the HOST's, so the host
// zone must be a known one — otherwise the arm is vacuous on a Mac already set
// to Asia/Tokyo. Set before the module graph (and any Date) is touched.
process.env.TZ = 'UTC';

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(() => Promise.resolve()),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

/** The live capability report the 5s session poll hands the view. Mutated
 *  between ticks, exactly as the control plane's own answer changes once the
 *  tunnel is up and the box has measured its exit. */
let capabilityReport: Record<string, unknown> = {
  manual_input_available: true,
  streaming_state: null,
  egress_state: null,
};
const getAgentSession = vi.fn(() =>
  Promise.resolve({
    mode: 'manual',
    pairKind: null,
    terminal: false,
    status: 'active',
    closedReason: null,
    capabilityReport,
  }),
);

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setAgentSessionCookies: vi.fn(),
  navigateAgentSessionHistory: vi.fn(),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const EMPTY_CONN = {
  transport: null,
  relayed: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  decodeFps: null,
  freezeCount: null,
};
vi.mock('../../src/lib/livekit-connection-stats', () => ({
  useConnectionStats: () => EMPTY_CONN,
  useTransportTelemetry: () => undefined,
  CONNECTION_STATS_INTERVAL_MS: 3000,
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

/** 12:00:05 UTC — five seconds PAST a minute boundary, so a 5s poll tick lands
 *  at 12:00:10 while the clock's own minute timer (armed for 12:01:00 + 50ms)
 *  never fires. Any repaint observed in that window is the zone change's doing. */
const T0 = new Date('2026-09-11T12:00:05.000Z');

/** The iOS h:mm the production formatter produces for a zone at `T0` — built
 *  from Intl parts, never from `.format()` (which emits "9:00 PM"). */
function iosTime(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(T0);
  return `${parts.find((p) => p.type === 'hour')?.value ?? ''}:${
    parts.find((p) => p.type === 'minute')?.value ?? ''
  }`;
}

function statusBarTime(container: HTMLElement): string | undefined {
  return (
    container.querySelector('[data-component="simulator-statusbar"]')?.querySelector('span')
      ?.textContent ?? undefined
  );
}

const lsStore = new Map<string, string>();

beforeEach(() => {
  capabilityReport = {
    manual_input_available: true,
    streaming_state: null,
    egress_state: null,
  };
  getAgentSession.mockClear();
  lsStore.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => lsStore.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      lsStore.set(k, v);
    },
    removeItem: (k: string): void => {
      lsStore.delete(k);
    },
    clear: (): void => lsStore.clear(),
    key: (): string | null => null,
    length: 0,
  });
  localStorage.setItem('ds-sim-navigated', '1');
  localStorage.setItem('ds-sim-browser-mode', '0');
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('(n) N13 — the status clock repaints the moment the exit timezone lands', () => {
  it('INSTRUMENT CONTROL — the host zone and the exit zone really do read differently at this instant', () => {
    // Without this, "the clock changed" and "the clock never changed" look the
    // same: the CRITICAL arm below would pass on a Mac set to Asia/Tokyo whether
    // or not the repaint happened.
    expect(iosTime('UTC')).toBe('12:00');
    expect(iosTime('Asia/Tokyo')).toBe('9:00');
    expect(iosTime('UTC')).not.toBe(iosTime('Asia/Tokyo'));
  });

  it('CRITICAL a launch with no tz shows host time, then the report’s exit_timezone repaints the bar WITHOUT waiting for the minute boundary', async () => {
    // A VPN launch with no fresh cached exit: the handoff carries no `tz`.
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <RecordingsProvider>
          <SimulatorWindow />
        </RecordingsProvider>,
      ).container;
      await vi.advanceTimersByTimeAsync(0);
    });
    // Host time — the documented fallback for an absent zone.
    expect(statusBarTime(container)).toBe(iosTime('UTC'));

    // The tunnel comes up and the box measures its exit; the next 5s session
    // poll carries the zone.
    capabilityReport = {
      manual_input_available: true,
      streaming_state: null,
      egress_state: null,
      exit_ip: '198.51.100.9',
      exit_country: 'JP',
      exit_timezone: 'Asia/Tokyo',
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(statusBarTime(container)).toBe(iosTime('Asia/Tokyo'));
    expect(statusBarTime(container)).not.toBe(iosTime('UTC'));
    // …and no minute boundary was crossed to get it: five simulated seconds,
    // and the displayed minute is still :00.
    expect(Date.now()).toBe(T0.getTime() + 5_000);
    expect(statusBarTime(container)).toMatch(/:00$/);
  });

  it('VACUITY CONTROL — with no zone ever reported the bar keeps host time across the same ticks', async () => {
    window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
    let container!: HTMLElement;
    await act(async () => {
      container = render(
        <RecordingsProvider>
          <SimulatorWindow />
        </RecordingsProvider>,
      ).container;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusBarTime(container)).toBe(iosTime('UTC'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // The repaint is driven by the ZONE, not by every poll tick.
    expect(statusBarTime(container)).toBe(iosTime('UTC'));
  });
});
