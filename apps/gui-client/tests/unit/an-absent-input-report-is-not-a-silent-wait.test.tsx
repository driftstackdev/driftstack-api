// ⛔ ITEM 3 (owner report 2026-09-16) — an ABSENT capability report must not read
// as nothing.
//
// The owner opened an OpenVPN session, got the first page, then sat on
// "connecting" and could never take control of the phone. They closed it after 33
// seconds. Remote control is gated on `manual_input_available === true` from the
// device's capability report; when that report says FALSE the simulator explains
// itself ("View only — device input is unavailable" + a matching keyboard
// tooltip), but when the report NEVER ARRIVES every `=== false` test was false,
// so there was no badge, no caption and no tooltip — an indefinite wait that
// looked exactly like a healthy session that is merely slow.
//
// That is an asserted field reading as a measurement, in the opposite direction:
// ABSENCE reading as fine. The fix names the three states once
// (src/lib/manual-input-capability.ts) and gives the absent one WORDS OF ITS OWN
// on the surfaces that already speak about input availability.
//
// The simulator arms drive the room to connected + publishing first, so the ONLY
// missing conjunct is the capability report — the owner's exact shape, where the
// toolbar reads "Live" and the address bar still reads "connecting".

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  MANUAL_INPUT_SESSION_OVER_CAPTION,
  MANUAL_INPUT_UNAVAILABLE_BADGE,
  MANUAL_INPUT_UNREPORTED_BADGE,
  MANUAL_INPUT_UNREPORTED_CAPTION,
  MANUAL_INPUT_UNREPORTED_LABEL,
  MANUAL_INPUT_UNREPORTED_TOOLTIP,
  manualInputCapabilityFromFlag,
  manualInputCapabilityOf,
} from '../../src/lib/manual-input-capability';

describe('manual-input capability — three states, never two', () => {
  it('maps a missing report and a report that never answered to the SAME "unreported", and neither to available/unavailable', () => {
    expect(manualInputCapabilityFromFlag(true)).toBe('available');
    expect(manualInputCapabilityFromFlag(false)).toBe('unavailable');
    // A report arrived but carried no usable manual_input_available (the client
    // parser maps a missing/wrong-typed key to null).
    expect(manualInputCapabilityFromFlag(null)).toBe('unreported');
    // No report at all.
    expect(manualInputCapabilityFromFlag(undefined)).toBe('unreported');

    expect(manualInputCapabilityOf(null)).toBe('unreported');
    expect(manualInputCapabilityOf(undefined)).toBe('unreported');
    expect(manualInputCapabilityOf({ manual_input_available: null })).toBe('unreported');
    expect(manualInputCapabilityOf({ manual_input_available: false })).toBe('unavailable');
    expect(manualInputCapabilityOf({ manual_input_available: true })).toBe('available');
  });

  it('gives the absence its OWN words: it never claims input is unavailable, and never claims it works', () => {
    expect(MANUAL_INPUT_UNREPORTED_BADGE).not.toBe(MANUAL_INPUT_UNAVAILABLE_BADGE);
    for (const copy of [
      MANUAL_INPUT_UNREPORTED_BADGE,
      MANUAL_INPUT_UNREPORTED_CAPTION,
      MANUAL_INPUT_UNREPORTED_TOOLTIP,
    ]) {
      // "has not reported" — the wait is named, not a verdict about the device.
      expect(copy).toMatch(/has not reported yet/);
      expect(copy).not.toMatch(/is unavailable|view only/i);
    }
  });
});

const getAgentSession = vi.fn((): Promise<unknown> => new Promise(() => {}));
type ControlState = {
  mode: 'manual' | 'ai' | 'pair';
  pairKind: string | null;
  terminal: boolean;
  status: string;
  closedReason: string | null;
  capabilityReport?: { manual_input_available: boolean | null } | null;
};
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

beforeEach(() => {
  getAgentSession.mockReset();
  const store = new Map<string, string>([
    ['ds-sim-browser-mode', '1'],
    ['ds-sim-navigated', '1'],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => store.clear(),
    key: (): string | null => null,
    length: 0,
  });
});

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

// Capture the panel's transport callbacks so the arms can bring the room up
// (connected + a publishing video track) exactly as a healthy session does.
const panelCbs: {
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
    panelCbs.onRoom = props.onRoom;
    panelCbs.onStateChange = props.onStateChange;
    panelCbs.onPublisher = props.onPublisher;
    panelCbs.interactive = props.interactive;
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

const { SimulatorWindow, SessionControlSection } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

const liveManual: ControlState = {
  mode: 'manual',
  pairKind: null,
  terminal: false,
  status: 'active',
  closedReason: null,
};

/**
 * Render a session. By default the room is driven to connected + publishing, so
 * the capability report is the only conjunct left in question.
 *
 * `bringUpRoom: false` leaves the transport idle — the state EVERY healthy
 * session passes through for its first seconds — and `'control-read-fails'`
 * stands in for a control poll that never answers. Neither is a statement about
 * the phone, and the arms below exist because a badge derived from the bare
 * tri-state fired in both.
 */
function renderSession(
  control: ControlState | 'control-read-fails',
  opts: { bringUpRoom?: boolean } = {},
) {
  getAgentSession.mockImplementation(
    control === 'control-read-fails'
      ? () => Promise.reject(new Error('control plane unreachable'))
      : () => immediateControl(control),
  );
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  const utils = render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
  if (opts.bringUpRoom !== false) {
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
      panelCbs.onPublisher?.('publishing', fakeRoom);
    });
  }
  return utils;
}

function renderLiveSession(control: ControlState) {
  return renderSession(control);
}

/** What the address bar says it is waiting for, in the same render — the surface
 *  the badge must never contradict. */
function waitGroup(container: HTMLElement): string | null {
  return (
    container
      .querySelector('[data-component="simulator-address-bar-connecting"]')
      ?.getAttribute('data-wait-group') ?? null
  );
}

function unreportedBadge(container: HTMLElement): Element | null {
  return container.querySelector('[data-component="input-capability-unreported-badge"]');
}

function keyboardToggle(container: HTMLElement): Element | null {
  return container.querySelector('[data-component="simulator-keyboard-toggle"]');
}

describe('SimulatorWindow — a phone that has not reported says so', () => {
  it('states the wait when NO capability report has arrived: the not-yet badge, not the view-only badge, and input stays off', async () => {
    // The owner's session: the control plane answers normally, the mode is a
    // confirmed manual, the video is live — and the device has simply never
    // reported its input capability. Before the fix this said NOTHING about input.
    const { container } = renderLiveSession(liveManual);
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-component="input-capability-unreported-badge"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-component="input-capability-unreported-badge"]'),
    ).toHaveTextContent(MANUAL_INPUT_UNREPORTED_BADGE);
    // ⛔ and NOT the device's explicit "no" — we were told nothing, which is a
    // different fact from being told input is unavailable.
    expect(container.querySelector('[data-component="view-only-capability-badge"]')).toBeNull();
    expect(screen.queryByText(MANUAL_INPUT_UNAVAILABLE_BADGE)).toBeNull();
    // The keyboard affordance blamed the agent for a session already in Manual.
    const toggle = container.querySelector('[data-component="simulator-keyboard-toggle"]');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('title', MANUAL_INPUT_UNREPORTED_TOOLTIP);
    // Never claim input IS available when we have not been told.
    expect(panelCbs.interactive).toBe(false);
  });

  it('treats a report that carries no answer exactly like no report — the wait, never a yes', async () => {
    const { container } = renderLiveSession({
      ...liveManual,
      capabilityReport: { manual_input_available: null },
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-component="input-capability-unreported-badge"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector('[data-component="view-only-capability-badge"]')).toBeNull();
    expect(panelCbs.interactive).toBe(false);
  });

  it('keeps the explicit FALSE on the view-only badge — the device answered, so the wait wording must not appear', async () => {
    const { container } = renderLiveSession({
      ...liveManual,
      capabilityReport: { manual_input_available: false },
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-component="view-only-capability-badge"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-component="view-only-capability-badge"]'),
    ).toHaveTextContent(MANUAL_INPUT_UNAVAILABLE_BADGE);
    expect(
      container.querySelector('[data-component="input-capability-unreported-badge"]'),
    ).toBeNull();
    expect(container.querySelector('[data-component="simulator-keyboard-toggle"]')).toHaveAttribute(
      'title',
      'This session is view only because device input is unavailable',
    );
    expect(panelCbs.interactive).toBe(false);
  });

  it('says nothing about input when the device reported TRUE — neither badge, and control is armed', async () => {
    const { container } = renderLiveSession({
      ...liveManual,
      capabilityReport: { manual_input_available: true },
    });
    await vi.waitFor(() => {
      expect(panelCbs.interactive).toBe(true);
    });
    expect(
      container.querySelector('[data-component="input-capability-unreported-badge"]'),
    ).toBeNull();
    expect(container.querySelector('[data-component="view-only-capability-badge"]')).toBeNull();
  });
});

// ⛔ The other half of "absence is not nothing": a wait that is NOT the phone's.
// 'unreported' is the tri-state of every session whose room is still coming up,
// whose control read has not answered, that is not running yet, and — because the
// control plane stops projecting the report at `status === 'closed'` — of every
// session that has ENDED, including one whose phone answered YES all the way
// through. A badge derived from the tri-state alone therefore fires on a healthy
// bring-up and blames the device for our own transport, our own poll and our own
// serialisation rule. Each arm below pins one of those, and each one goes red if
// the surfaces stop reading the shared wait group (lib/manual-input-wait) and
// re-derive a partial condition of their own.
describe('SimulatorWindow — the phone is only blamed once nothing else is missing', () => {
  it('says CONNECTING, not "the phone has not reported", while the transport is still coming up', async () => {
    // The owner's first seconds: a confirmed manual session, no room yet. The
    // phone has not been asked anything, so it has not failed to answer.
    const { container } = renderSession(liveManual, { bringUpRoom: false });
    // Positive control first — the control read HAS landed and the bar is
    // speaking, so the absence below is a measured absence, not an early one.
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('stream');
    });
    expect(
      container
        .querySelector('[data-component="simulator-address-bar-connecting"]')
        ?.getAttribute('title'),
    ).toBe('Connecting to the phone — this usually takes a few seconds.');
    expect(unreportedBadge(container)).toBeNull();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_BADGE)).toBeNull();
    expect(keyboardToggle(container)).not.toHaveAttribute('title', MANUAL_INPUT_UNREPORTED_TOOLTIP);
  });

  it('says the session is not running yet, not that the phone is silent, before it goes active', async () => {
    const { container } = renderLiveSession({ ...liveManual, status: 'provisioning' });
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('session-inactive');
    });
    expect(unreportedBadge(container)).toBeNull();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_BADGE)).toBeNull();
  });

  it('blames OUR failing control poll on the poll, never on the phone', async () => {
    const { container } = renderSession('control-read-fails');
    // Positive control: the failure path actually ran (it lights the
    // control-unreachable badge), so the absence below is measured after it.
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-component="control-unreachable-badge"]'),
      ).not.toBeNull();
    });
    // ⛔ 'session-unreadable', not 'session-unconfirmed': this arm's whole point is
    // that the POLL is blamed, and a read that FAILED is not a check in progress —
    // the failing path fails closed and does not retry, so "checking this session's
    // status…" described a check nobody was running (and sat beside the very badge
    // the positive control above just waited for). The group name moved with the
    // fact; the phone is still not blamed, which is what the three lines below pin.
    expect(waitGroup(container)).toBe('session-unreadable');
    expect(
      container
        .querySelector('[data-component="simulator-address-bar-connecting"]')
        ?.getAttribute('title'),
    ).toBe('We can’t reach this session right now — try again in a moment, or reopen the session.');
    expect(unreportedBadge(container)).toBeNull();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_BADGE)).toBeNull();
  });

  it('keeps the agent wording in AI mode — the phone was never asked to hand over taps', async () => {
    const { container } = renderLiveSession({ ...liveManual, mode: 'ai' });
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('session-agent-driving');
    });
    expect(unreportedBadge(container)).toBeNull();
    expect(keyboardToggle(container)).toHaveAttribute(
      'title',
      'The agent is driving — switch to Manual to type',
    );
    expect(keyboardToggle(container)).toHaveAttribute(
      'aria-label',
      'Keyboard unavailable while the agent is driving',
    );
    expect(panelCbs.interactive).toBe(false);
  });

  it('stops speaking about the phone entirely once the session has ENDED — we dropped that report, the phone did not withhold it', async () => {
    // A closed session: the server omits capability_report for every
    // `status === 'closed'` record, so a device that reported TRUE all session
    // arrives here as 'unreported'. Promising that "input stays off until it
    // does" would state our own serialisation rule as the device's silence,
    // about a session that will never report again.
    const { container } = renderLiveSession({ ...liveManual, terminal: true, status: 'closed' });
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('ended');
    });
    expect(unreportedBadge(container)).toBeNull();
    const toggle = keyboardToggle(container);
    expect(toggle?.getAttribute('title')).not.toMatch(/has not reported/);
    expect(toggle?.getAttribute('aria-label')).not.toMatch(/has not reported/);
    expect(toggle).not.toHaveAttribute('title', MANUAL_INPUT_UNREPORTED_TOOLTIP);
    expect(toggle).not.toHaveAttribute('aria-label', MANUAL_INPUT_UNREPORTED_LABEL);
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_BADGE)).toBeNull();
  });
});

describe('SessionControlSection — the Manual caption never claims input works on no answer', () => {
  const base = {
    pairKind: null,
    action: null,
    composerText: '',
    controlError: null,
    onRetryControl: vi.fn(),
    onSetMode: vi.fn(),
    onTakeover: vi.fn(),
    onHandback: vi.fn(),
    onComposerChange: vi.fn(),
    onSendMessage: vi.fn(),
  };

  it('renders the wait caption for an absent report and for a report with no answer, the view-only caption for FALSE, and the drive caption only for TRUE', () => {
    const { rerender } = render(<SessionControlSection {...base} mode="manual" />);
    expect(screen.getByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeVisible();
    expect(screen.queryByText('Manual — tap the screen to drive')).toBeNull();

    rerender(<SessionControlSection {...base} mode="manual" manualInputAvailable={null} />);
    expect(screen.getByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeVisible();

    rerender(<SessionControlSection {...base} mode="manual" manualInputAvailable={false} />);
    expect(screen.getByText('Manual mode — view only (device input unavailable)')).toBeVisible();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeNull();

    rerender(<SessionControlSection {...base} mode="manual" manualInputAvailable={true} />);
    expect(screen.getByText('Manual — tap the screen to drive')).toBeVisible();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeNull();
  });

  it('says the session has ended instead of blaming the phone, on the very shape a closed session produces', () => {
    // ⛔ The prop is `undefined` for EVERY closed session — the route omits
    // capability_report at `status === 'closed'` — so without the liveness
    // signal the caption reports our own serialisation rule as the phone's
    // silence. Same undefined report as the first arm above; only the liveness
    // differs, which is what makes this a guard on the liveness and not on the
    // tri-state.
    const { rerender } = render(<SessionControlSection {...base} mode="manual" sessionOver />);
    expect(screen.getByText(MANUAL_INPUT_SESSION_OVER_CAPTION)).toBeVisible();
    expect(screen.queryByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeNull();
    expect(screen.queryByText('Manual — tap the screen to drive')).toBeNull();

    // A phone that DID answer yes, on a session that has since ended: still the
    // ended caption — "tap the screen to drive" is an invitation to drive a
    // session that is over.
    rerender(
      <SessionControlSection {...base} mode="manual" manualInputAvailable={true} sessionOver />,
    );
    expect(screen.getByText(MANUAL_INPUT_SESSION_OVER_CAPTION)).toBeVisible();

    // And a LIVE session with no report is untouched by the new gate.
    rerender(<SessionControlSection {...base} mode="manual" sessionOver={false} />);
    expect(screen.getByText(MANUAL_INPUT_UNREPORTED_CAPTION)).toBeVisible();
  });
});

describe('the toolbar pill names the blocker instead of saying Connecting forever', () => {
  /** The amber pill beside the device name. */
  function pill(container: HTMLElement): Element | null {
    return container.querySelector('[data-component="simulator-connecting-indicator"]');
  }

  /**
   * ⛔ THE DEFECT THIS ARM EXISTS FOR, reported five times in the owner's own
   * words — "keeps status 'connecting'", "connected, but no video arrived".
   *
   * `connecting` on the toolbar is true for EVERY state that is not fully live,
   * and the bar rendered the single word "Connecting…" over all of them. A failed
   * stream, a phone that never sent a screen, a session not running yet and a
   * session that has not reported it accepts taps were four different problems
   * wearing one word — and that word says "in progress", so it reads as "wait
   * longer" in every case, including the ones where waiting never helps.
   *
   * The specific sentence was computed in the same render the whole time and
   * thrown away at the prop boundary.
   */
  it('CRITICAL a connected transport with no video says the screen is missing, not "Connecting…"', async () => {
    const { container } = renderSession(liveManual, { bringUpRoom: false });
    // Connected, deliberately WITHOUT a publisher: the exact state behind
    // "connected, but no video arrived".
    act(() => {
      panelCbs.onRoom?.(fakeRoom, fakeRoom);
      panelCbs.onStateChange?.({ kind: 'connected' }, fakeRoom);
    });
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('screen');
    });
    expect(pill(container)).not.toBeNull();
    expect(pill(container)?.textContent).toContain('waiting for the screen');
    // ⛔ THE HALF THAT MATTERS: the old word is GONE. Asserting only that the new
    // text is present would pass against a pill that rendered both.
    expect(pill(container)?.textContent).not.toContain('Connecting…');
    // And the hover carries the full sentence, not the old generic one.
    expect(pill(container)?.getAttribute('title')).toBe(
      'Connected — waiting for the phone’s screen to arrive.',
    );
  });

  it('CONTROL — a transport that has not come up still says "connecting", because there it is true', async () => {
    // ⛔ The fix is not "never say connecting". A session whose transport has not
    // come up yet IS connecting, and that word is the honest one — the defect was
    // using it for the twelve states where it is not.
    //
    // This arm is what stops the one above from passing against a pill that had
    // simply been re-hardcoded to the screen wording: same component, same render
    // path, different wait group, different words.
    const { container } = renderSession(liveManual, { bringUpRoom: false });
    await vi.waitFor(() => {
      expect(waitGroup(container)).toBe('stream');
    });
    expect(pill(container)?.textContent).toContain('connecting');
    expect(pill(container)?.getAttribute('title')).toBe(
      'Connecting to the phone — this usually takes a few seconds.',
    );
  });
});
