// ITEM 1, rendered half (owner report, live 2026-09-16). The pure derivation is guarded
// in a-locked-session-says-which-signal-it-is-waiting-for.test.ts; this file pins that
// the SIMULATOR actually renders it — that the address bar the owner was looking at
// stops saying the single word "connecting" for six different reasons.
//
// ⛔ The owner's session had already painted its first page, so the toolbar chip (which
// clears on connected + a video track alone) read "Live" while the address bar read
// "connecting" — the blocker was downstream of the stream, and nothing on screen said
// which. Each case below drives the window into one group and reads the chip, its
// group token, the placeholder and the locked tooltip.
//
// The vacuity control is the last case: a fully live session shows NO waiting cue at
// all. Without it, a bar that always rendered a sentence would satisfy every other
// assertion here.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type {
  AgentSessionCapabilityReport,
  SessionMode,
} from '../../src/lib/agent-session-control';
import type * as SettingsModule from '../../src/lib/settings';

const sendNavigate = vi.fn(() => Promise.resolve());
const getAgentSession = vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {}));
const setSessionMode = vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {}));

type ControlState = {
  mode: SessionMode;
  pairKind: null;
  terminal: boolean;
  status: string;
  closedReason: string | null;
  provisioningDetail?: string | null;
  capabilityReport?: Partial<AgentSessionCapabilityReport> | null;
};
const ACTIVE_MANUAL: ControlState = {
  mode: 'manual',
  pairKind: null,
  terminal: false,
  status: 'active',
  closedReason: null,
  capabilityReport: { manual_input_available: true },
};
let controlState: ControlState = ACTIVE_MANUAL;

/** The control read has to settle INSIDE the render act() so the window holds a
 *  confirmed snapshot by the time the bar is read (mirrors the VPN-parity suite). */
function immediateControl<T>(value: T): Promise<T> {
  return {
    then: (onfulfilled: (resolved: T) => unknown) => {
      try {
        return Promise.resolve(onfulfilled(value));
      } catch (err: unknown) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  } as unknown as Promise<T>;
}

/** The REJECTION path, settled inside the same act() — the window's control reads
 *  are `.then(…).catch(…)`, and it is the catch that blanks the confirmed snapshot
 *  and raises "we cannot reach this session". */
function immediateFailure(err: unknown): Promise<never> {
  return {
    then: () => ({
      catch: (onrejected: (e: unknown) => unknown) => {
        onrejected(err);
        return Promise.resolve(undefined);
      },
    }),
  } as unknown as Promise<never>;
}

const localStore = new Map<string, string>();
beforeEach(() => {
  sendNavigate.mockClear();
  setSessionMode.mockClear();
  setSessionMode.mockImplementation(() => new Promise(() => {}));
  controlState = ACTIVE_MANUAL;
  getAgentSession.mockReset();
  getAgentSession.mockImplementation(() => immediateControl(controlState));
  localStore.clear();
  localStore.set('ds-sim-browser-mode', '0');
  localStore.set('ds-sim-navigated', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => localStore.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      localStore.set(k, v);
    },
    removeItem: (k: string): void => {
      localStore.delete(k);
    },
    clear: (): void => localStore.clear(),
    key: (): string | null => null,
    length: 0,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate,
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    DataReceived: 'dataReceived',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

const panelCbs: {
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  onStateChange?: (s: { kind: string }, room: unknown) => void;
  onPublisher?: (p: string, room: unknown) => void;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    panelCbs.onRoom = props.onRoom;
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsModule>()),
  loadSettings: vi.fn(() => Promise.resolve({ apiKey: 'ds_test', baseUrl: 'https://api.test' })),
  loadBaseUrl: vi.fn(() => Promise.resolve('https://api.test')),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode,
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {
    status?: number;
  },
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { MANUAL_INPUT_UNAVAILABLE_BADGE, MANUAL_INPUT_UNREPORTED_BADGE } =
  await import('../../src/lib/manual-input-capability');
const { MANUAL_INPUT_WAIT_COPY } = await import('../../src/lib/manual-input-wait');

function renderSim(): HTMLElement {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const { container } = render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
  // The Controls pane holds the non-browser-mode address bar.
  openPane(container, 'controls');
  return container;
}

/** The rail's panes are mutually exclusive — the Mode switch lives in 'session', the
 *  address bar in 'controls', so case (f) has to visit one and read the other. */
function openPane(container: HTMLElement, pane: 'controls' | 'session'): void {
  fireEvent.click(container.querySelector(`[data-component="sim-rail-${pane}"]`) as Element);
}

function connect(): void {
  act(() => {
    panelCbs.onRoom?.(fakeRoom, fakeRoom);
    panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
  });
}
function goLive(): void {
  connect();
  act(() => panelCbs.onPublisher?.('publishing', fakeRoom));
}

/** What the customer can read on the locked bar: the cue, its group, and the
 *  tooltip/placeholder the field carries. */
function waitCue(container: HTMLElement): {
  group: string | null;
  chip: string;
  placeholder: string | null;
  title: string | null;
} | null {
  const cue = container.querySelector('[data-component="simulator-address-connecting"]');
  const input = container.querySelector('[aria-label="Address bar"]');
  if (cue === null) return null;
  return {
    group: cue.getAttribute('data-wait-group'),
    chip: cue.textContent ?? '',
    placeholder: input?.getAttribute('placeholder') ?? null,
    title: input?.getAttribute('title') ?? null,
  };
}

describe('a locked address bar names the signal it is waiting for', () => {
  it('CRITICAL (a) nothing connected yet — the cue says connecting and is TAGGED as the stream group, so the one state the old copy described still reads the same', () => {
    const cue = waitCue(renderSim());
    expect(cue?.group).toBe('stream');
    expect(cue?.chip).toContain('connecting…');
    expect(cue?.placeholder).toContain('connecting…');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY.stream.sentence);
  });

  it('CRITICAL (b) connected, no screen yet — a DIFFERENT sentence from (a): the room is up and the phone’s screen is what has not arrived', () => {
    const container = renderSim();
    connect();
    const cue = waitCue(container);
    expect(cue?.group).toBe('screen');
    expect(cue?.chip).toBe(MANUAL_INPUT_WAIT_COPY.screen.chip);
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY.screen.sentence);
    expect(cue?.chip).not.toBe(MANUAL_INPUT_WAIT_COPY.stream.chip);
  });

  it('CRITICAL (a) the connection DROPPED — the bar stops promising "a few seconds" and says what actually happened (MUTATION: collapse the transport back to connState !== "connected" → red)', () => {
    const container = renderSim();
    goLive();
    expect(waitCue(container)).toBeNull(); // live first: the drop below is the only change
    act(() => panelCbs.onStateChange?.({ kind: 'disconnected' }, fakeRoom));
    const dropped = waitCue(container);
    expect(dropped?.group).toBe('stream-lost');
    expect(dropped?.title).toBe(MANUAL_INPUT_WAIT_COPY['stream-lost'].sentence);
    // ⛔ The full-screen overlay over the video is showing an error glyph and a
    // Reconnect button at this moment; "Connecting to the phone — this usually takes
    // a few seconds." beside it was a promise nothing behind the bar was keeping.
    expect(dropped?.title).not.toMatch(/usually takes a few seconds/);
    act(() => panelCbs.onStateChange?.({ kind: 'reconnecting' }, fakeRoom));
    const back = waitCue(container);
    expect(back?.group).toBe('stream-reconnecting');
    expect(back?.title).toBe(MANUAL_INPUT_WAIT_COPY['stream-reconnecting'].sentence);
    expect(back?.title).not.toBe(MANUAL_INPUT_WAIT_COPY['stream-lost'].sentence);
  });

  it('CRITICAL (c) screen up, session not active — "isn’t running yet", not "connecting"', () => {
    controlState = { ...ACTIVE_MANUAL, status: 'provisioning' };
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('session-inactive');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY['session-inactive'].sentence);
  });

  it('CRITICAL (c) screen up, the agent is driving — the bar says who holds the controls and how to take them', () => {
    controlState = { ...ACTIVE_MANUAL, mode: 'ai' };
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('session-agent-driving');
    expect(cue?.title).toContain('switch to Manual');
  });

  it('(c) screen up, the session state has not been read yet — the bar says it is checking, and blames neither the phone nor the agent', () => {
    getAgentSession.mockImplementation(() => new Promise(() => {}));
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('session-unconfirmed');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY['session-unconfirmed'].sentence);
  });

  it('CRITICAL (c) the session read FAILED — the bar says we cannot reach this session, not that a check is under way (MUTATION: drop controlReadFailed from the wiring → "Checking this session’s status…" forever → red)', () => {
    // ⛔ The window blanks modeConfirmed/lifecycleConfirmed on every control-read
    // rejection AND raises its own unreachable state in the same breath, and the
    // failing paths do not retry. Given only the blanked fields the bar reported a
    // check in progress — the founder's 2026-06-18 "stuck Connecting… when
    // getAgentSession failed" complaint, one surface over.
    getAgentSession.mockImplementation(() => immediateFailure(new Error('control read failed')));
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('session-unreadable');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY['session-unreadable'].sentence);
    expect(cue?.title).not.toBe(MANUAL_INPUT_WAIT_COPY['session-unconfirmed'].sentence);
    expect(cue?.placeholder).toBe(MANUAL_INPUT_WAIT_COPY['session-unreadable'].placeholder);
  });

  it('CRITICAL (c) a PAUSED session is told it is paused and needs a resume — not that it has not started (MUTATION: fold paused into session-inactive → red)', () => {
    controlState = { ...ACTIVE_MANUAL, status: 'paused' };
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('session-paused');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY['session-paused'].sentence);
    expect(cue?.title).not.toMatch(/isn’t running yet|once it starts/);
    expect(cue?.title).toMatch(/resume/i);
  });

  it('CRITICAL (b) the device REPORTED its video failed — the bar reuses the video overlay’s words instead of promising a screen that is not coming (MUTATION: key the screen group on publisherState alone → red)', () => {
    controlState = {
      ...ACTIVE_MANUAL,
      capabilityReport: { manual_input_available: true, streaming_state: 'failed' },
    };
    const container = renderSim();
    connect(); // connected, no video track — the state a 'failed' capture leaves behind
    const cue = waitCue(container);
    expect(cue?.group).toBe('screen-failed');
    expect(cue?.title).not.toBe(MANUAL_INPUT_WAIT_COPY.screen.sentence);
    // ⛔ The overlay over the video is up in the SAME render. Two surfaces must not
    // disagree about one device — one saying its video failed, one saying the screen
    // is on its way — so the bar speaks the overlay's sentence, not a new one.
    const overlay = container.querySelector('[data-component="streaming-capability-error"]');
    expect(overlay?.textContent ?? '').toContain(cue?.title ?? '');
  });

  it('CRITICAL (d) THE OWNER’S SESSION — live stream, active manual session, and NO word from the phone about input: the bar says that instead of "connecting" forever', () => {
    controlState = { ...ACTIVE_MANUAL, capabilityReport: null };
    const container = renderSim();
    goLive();
    const cue = waitCue(container);
    expect(cue?.group).toBe('input-unreported');
    expect(cue?.placeholder).toBe(MANUAL_INPUT_UNREPORTED_BADGE);
    expect(cue?.chip).not.toContain('connecting');
    // A report that arrives WITHOUT the field is the same fact, not a different one.
    controlState = { ...ACTIVE_MANUAL, capabilityReport: { manual_input_available: null } };
    const second = renderSim();
    goLive();
    expect(waitCue(second)?.group).toBe('input-unreported');
  });

  it('CRITICAL (e) NO REGRESSION — the device’s explicit "input is unavailable" keeps its existing badge and wording, and the bar re-uses those words rather than inventing new ones', () => {
    controlState = { ...ACTIVE_MANUAL, capabilityReport: { manual_input_available: false } };
    const container = renderSim();
    goLive();
    const badge = container.querySelector('[data-component="view-only-capability-badge"]');
    expect(badge?.textContent).toBe(MANUAL_INPUT_UNAVAILABLE_BADGE);
    const cue = waitCue(container);
    expect(cue?.group).toBe('input-unavailable');
    expect(cue?.chip).toBe(MANUAL_INPUT_UNAVAILABLE_BADGE);
  });

  it('(f) a control action of ours in flight — the bar says the last change is finishing, not that the agent is driving', () => {
    const container = renderSim();
    goLive();
    expect(waitCue(container)).toBeNull(); // live first — the flip below is the only change
    openPane(container, 'session');
    // setSessionMode never resolves here, so the mutation stays in flight.
    fireEvent.click(container.querySelector('[aria-label="Agent mode"]') as Element);
    expect(setSessionMode).toHaveBeenCalledTimes(1);
    openPane(container, 'controls');
    const cue = waitCue(container);
    expect(cue?.group).toBe('local');
    expect(cue?.title).toBe(MANUAL_INPUT_WAIT_COPY.local.sentence);
  });

  it('CRITICAL VACUITY CONTROL — a fully live manual session shows NO waiting cue at all and the bar is usable', () => {
    const container = renderSim();
    goLive();
    expect(container.querySelector('[data-component="simulator-address-connecting"]')).toBeNull();
    const input = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('placeholder')).toContain('Search or enter');
    expect(input.getAttribute('title')).toBeNull();
  });

  it('CRITICAL the browser-mode bar carries the same cue and group (both bars, one derivation — the customer sees the same answer wherever they look)', () => {
    localStore.set('ds-sim-browser-mode', '1');
    controlState = { ...ACTIVE_MANUAL, capabilityReport: null };
    const container = renderSim();
    goLive();
    const cue = container.querySelector('[data-component="simulator-address-bar-connecting"]');
    expect(cue?.getAttribute('data-wait-group')).toBe('input-unreported');
    expect(cue?.getAttribute('title')).toBe(MANUAL_INPUT_WAIT_COPY['input-unreported'].sentence);
    // Every locked control in that bar answers with the same sentence, not "Connecting…".
    const reload = container.querySelector('[aria-label="Reload"]');
    const go = container.querySelector('[data-component="simulator-address-bar-go"]');
    expect(reload?.getAttribute('title')).toBe(MANUAL_INPUT_WAIT_COPY['input-unreported'].sentence);
    expect(go?.getAttribute('title')).toBe(MANUAL_INPUT_WAIT_COPY['input-unreported'].sentence);
    // ⛔ …including the locked FIELD, which rendered the chip where the other bar
    // renders the placeholder: one bar read "waiting on the phone…" while the other
    // read the whole badge sentence about the same session, and the module's
    // per-group `placeholder` was dead code on this half of the product.
    const input = container.querySelector('[aria-label="Address bar"]');
    expect(input?.getAttribute('placeholder')).toBe(
      MANUAL_INPUT_WAIT_COPY['input-unreported'].placeholder,
    );
  });
});
