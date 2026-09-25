// Owner item 7 (2026-09-24): "IN a active session i randomly got this; Waiting
// on the phone — it has not reported yet whether it can accept taps -- might
// want to investigate why"
//
// ROOT CAUSE, app side (lib/simulator-input-report.ts): the server keeps the
// phone's capability report in memory and leaves `capability_report` out of the
// session read when it holds none — after a restart (a deploy) it holds none
// until the phone's next periodic report, minutes later. The window REPLACED
// its copy with each read's, so the first read without the key erased a report
// the phone had already given: the badge came back mid-session and taps locked.
//
// Proven here on the real window with the 5 s session poll driven by fake
// timers: a read that leaves the report out keeps the phone's last word; a new
// report (including an explicit "no") still replaces it; and a phone that truly
// has not reported gets a line that says how long and what to do, after a
// short patience.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

const getAgentSession = vi.fn((): Promise<unknown> => new Promise(() => {}));
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

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate: vi.fn(() => Promise.resolve()),
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
const panel: {
  onRoom?: (room: unknown, ownerRoom: unknown) => void;
  onStateChange?: (s: { kind: string }, room: unknown) => void;
  onPublisher?: (p: string, room: unknown) => void;
  interactive?: boolean;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
    interactive?: boolean;
  }) => {
    panel.onRoom = props.onRoom;
    panel.onStateChange = props.onStateChange;
    panel.onPublisher = props.onPublisher;
    panel.interactive = props.interactive;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { INPUT_REPORT_PATIENCE_MS, MANUAL_INPUT_UNREPORTED_LONG_BADGE } =
  await import('../../src/lib/simulator-input-report');
const { MANUAL_INPUT_UNREPORTED_BADGE } = await import('../../src/lib/manual-input-capability');

const LIVE = {
  mode: 'manual',
  pairKind: null,
  terminal: false,
  status: 'active',
  closedReason: null,
};
let current: Record<string, unknown> = LIVE;

function renderLive() {
  getAgentSession.mockImplementation(() => immediateControl(current));
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const utils = render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
  act(() => {
    panel.onRoom?.(fakeRoom, fakeRoom);
    panel.onStateChange?.({ kind: 'connected' }, fakeRoom);
    panel.onPublisher?.('publishing', fakeRoom);
  });
  return utils;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const badge = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="input-capability-unreported-badge"]');
const viewOnly = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="view-only-capability-badge"]');

beforeEach(() => {
  vi.useFakeTimers();
  getAgentSession.mockReset();
  current = LIVE;
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('a phone that already said it accepts taps', () => {
  it('is not waited on again when a later read leaves the report out (the server lost its copy)', async () => {
    current = { ...LIVE, capabilityReport: { manual_input_available: true } };
    const { container } = renderLive();
    await advance(10);
    expect(panel.interactive, 'precondition: control is armed').toBe(true);
    expect(badge(container)).toBeNull();

    // The server restarts: every read now leaves `capability_report` out.
    current = { ...LIVE };
    for (let i = 0; i < 4; i += 1) {
      await advance(5000);
      expect(badge(container), `poll ${String(i + 1)}`).toBeNull();
      expect(panel.interactive, `poll ${String(i + 1)}: taps stay on`).toBe(true);
    }
  });

  it('CONTROL — a new report still replaces it: an explicit "no" is shown as view-only', async () => {
    current = { ...LIVE, capabilityReport: { manual_input_available: true } };
    const { container } = renderLive();
    await advance(10);
    current = { ...LIVE, capabilityReport: { manual_input_available: false } };
    await advance(5000);
    expect(viewOnly(container)).not.toBeNull();
    expect(panel.interactive).toBe(false);
  });
});

describe('a phone that has not reported at all', () => {
  it('first says it is waiting, then — past the patience — how long and what to do', async () => {
    current = { ...LIVE };
    const { container } = renderLive();
    await advance(10);
    expect(badge(container)?.textContent).toBe(MANUAL_INPUT_UNREPORTED_BADGE);
    await advance(INPUT_REPORT_PATIENCE_MS + 10);
    expect(badge(container)?.textContent).toBe(MANUAL_INPUT_UNREPORTED_LONG_BADGE);
    // The report arrives: the badge goes, whatever it said.
    current = { ...LIVE, capabilityReport: { manual_input_available: true } };
    await advance(5000);
    expect(badge(container)).toBeNull();
  });
});
