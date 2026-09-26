// The phone's next harness batch changes its focus frames. Each point is held
// against what the window does with frames shaped exactly as the batch sends
// them:
//   (1) a focus frame carries the tab id (and tabIncarnation once the tab's
//       renderer was replaced) — it drives the keyboard for the ACTIVE tab and
//       is ignored for any other;
//   (2) room frames carry tabIncarnation — a frame from a replaced renderer (a
//       lower incarnation, or none after a bump) is inert; the current
//       renderer's frames, and untagged legacy frames, still land;
//   (3) `inputRefocus: true` — a tap on the field that already has focus — is a
//       fresh focus edge: it re-shows the keyboard, even after a Hide — also in
//       a session with no tabs, where the frame carries no tab id at all;
//   (4) the phone replays its last `focused: true` once per connect / publisher
//       registration — together with the window's own first-control replay it
//       must show the keyboard once, never hide it in between;
//   (5) focus edges arrive in order, latest wins, and every focus frame keeps a
//       `state` — which is not a page load and must not act like one.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

let latestDataHandler: ((p: Uint8Array) => void) | null = null;
const fakeRoom = {
  on: vi.fn((event: string, cb: (p: Uint8Array) => void) => {
    if (event === 'dataReceived') latestDataHandler = cb;
  }),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};

vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => fakeRoom,
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

vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, []);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// The session read. `reported` flips the phone's capability report on and off,
// which is what grants or withholds manual control here. `grant.held` holds
// every read back until a test releases it; `grant.reads` are the reads made.
const phone = { reported: true };
const grant: { held: Promise<void> | null; reads: Promise<unknown>[] } = { held: null, reads: [] };
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () => {
    const session = {
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
      ...(phone.reported ? { capabilityReport: { manual_input_available: true } } : {}),
    };
    const read = grant.held === null ? Promise.resolve(session) : grant.held.then(() => session);
    grant.reads.push(read);
    return read;
  },
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

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function push(frame: Record<string, unknown>): void {
  act(() => {
    latestDataHandler?.(new TextEncoder().encode(JSON.stringify(frame)));
  });
}

const toggle = (c: HTMLElement): Element | null =>
  c.querySelector('[data-component="simulator-keyboard-toggle"]');
const pressed = (c: HTMLElement): string | null | undefined =>
  toggle(c)?.getAttribute('aria-pressed');

const PAGE = 'https://shop.example.com/';

beforeEach(() => {
  latestDataHandler = null;
  phone.reported = true;
  grant.held = null;
  grant.reads = [];
});
const TAB_A = 'tab_a';
const TAB_B = 'tab_b';

function restoreTwoTabs(): void {
  push({
    type: 'tabListRestore',
    tabs: [
      { id: TAB_A, url: PAGE, scrollY: 0, title: 'Shop' },
      { id: TAB_B, url: 'https://news.example.com/', scrollY: 0, title: 'News' },
    ],
    activeTabId: TAB_A,
  });
}

async function twoTabs(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(toggle(container)).not.toBeDisabled());
  restoreTwoTabs();
}

/** Every value the keyboard toggle's aria-pressed takes, in order. */
function watchPressed(container: HTMLElement): string[] {
  const seen: string[] = [];
  const el = toggle(container);
  if (el === null) throw new Error('no keyboard toggle');
  seen.push(el.getAttribute('aria-pressed') ?? '');
  new MutationObserver(() => {
    const v = el.getAttribute('aria-pressed') ?? '';
    if (seen[seen.length - 1] !== v) seen.push(v);
  }).observe(el, { attributes: true, attributeFilter: ['aria-pressed'] });
  return seen;
}

describe('(1) a focus frame that names its tab', () => {
  it('for the ACTIVE tab it shows the keyboard at once — no legacy grace', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    // Straight after the restore (inside the 2.5 s switch grace a tab-less frame waits out).
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  // The read that grants manual control moves the window's authority at once,
  // but the room listener for it is subscribed only when React commits that —
  // a render later. The phone's restore and its focus report can land in
  // between (the case above hit it about one run in seven under load). They
  // are applied when the window can apply them, not dropped: the phone sends
  // that focus once, so dropping it left the keyboard down until a second tap.
  it('for the ACTIVE tab, sent while the window is still taking control, it still shows the keyboard', async () => {
    let release = (): void => undefined;
    grant.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container } = renderSim();
    await waitFor(() => expect(latestDataHandler).not.toBeNull());
    expect(toggle(container)).toBeDisabled();
    const reads = [...grant.reads];
    expect(reads.length).toBeGreaterThan(0);
    release();
    // Every read's own handler runs before this continuation: the grant is
    // applied. No task has run since, so it is not yet rendered.
    await Promise.all(reads);
    expect(toggle(container), 'the grant is not rendered yet').toBeDisabled();
    restoreTwoTabs();
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    expect(
      container.querySelectorAll('[data-component="simulator-tab"]'),
      'the restore landed too',
    ).toHaveLength(2);
  });

  it('for ANOTHER tab it is ignored', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: 'https://news.example.com/', tabId: TAB_B, inputFocused: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('false');
  });
});

describe('(2) the incarnation fence', () => {
  it('a frame from the current renderer lands; one from the replaced renderer is inert', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    // The renderer for tab A was replaced: its frames now say incarnation 1.
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, tabIncarnation: 1, inputFocused: false });
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, tabIncarnation: 1, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    // A late frame from the OLD renderer (unbumped: no incarnation) says blur.
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container), 'a stale renderer does not hide the keyboard').toBe('true');
    // …and a stale incarnation (0 < 1) is inert too, while the current one still lands.
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, tabIncarnation: 0, inputFocused: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('true');
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, tabIncarnation: 1, inputFocused: false });
    await waitFor(() => expect(pressed(container)).toBe('false'));
  });

  it("CONTROL — one tab's bump does not fence its sibling, nor untagged legacy frames", async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: 'https://news.example.com/', tabId: TAB_B, tabIncarnation: 3 });
    // Tab A never bumped: its unstamped frames are its current renderer's.
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: false });
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });
});

describe('(3) inputRefocus — the already-focused field tapped again', () => {
  it('re-shows the keyboard after a Hide, without a blur first', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element); // Hide
    expect(pressed(container)).toBe('false');
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true, inputRefocus: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it('CONTROL — a plain focus frame after a Hide still respects it', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element);
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('false');
  });

  it('CONTROL — a refocus for another tab does nothing', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({
      state: 'loaded',
      url: 'https://news.example.com/',
      tabId: TAB_B,
      inputFocused: true,
      inputRefocus: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('false');
  });
});

describe('(3b) inputRefocus in a session with NO tab identity', () => {
  // The device sends exactly this shape when the session has no tabs: the
  // frames are untagged, and there is no tab list to name one.
  async function focusedThenHidden(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(toggle(container)).not.toBeDisabled());
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element); // Hide
    expect(pressed(container)).toBe('false');
  }

  it('an untagged refocus after a Hide re-shows the keyboard', async () => {
    const { container } = renderSim();
    await focusedThenHidden(container);
    push({ state: 'loaded', url: PAGE, inputFocused: true, inputRefocus: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it('the bare shape — { inputFocused: true, inputRefocus: true } and nothing else — does too', async () => {
    const { container } = renderSim();
    await focusedThenHidden(container);
    push({ inputFocused: true, inputRefocus: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it('CONTROL — an untagged plain focus after a Hide still respects the Hide', async () => {
    const { container } = renderSim();
    await focusedThenHidden(container);
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    push({ inputFocused: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('false');
  });
});

describe("(4) the phone's replay and the window's own", () => {
  it('together they show the keyboard once and never hide it in between', async () => {
    phone.reported = false; // no manual control yet
    const { container } = renderSim();
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="input-capability-unreported-badge"]'),
      ).not.toBeNull(),
    );
    const seen = watchPressed(container);
    push({ state: 'loaded', url: PAGE, inputFocused: true }); // before control
    phone.reported = true;
    await waitFor(() => expect(pressed(container)).toBe('true'), { timeout: 12_000 });
    // The phone's one-slot replay on (re)connect.
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['false', 'true']);
  }, 20_000);
});

describe('(5) ordered edges, and a `state` on every focus frame', () => {
  it('blur then focus (a move between fields): latest wins, the keyboard is up', async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: false });
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it("a focus frame's `state: loading` is not a page load: it does not lift a Hide", async () => {
    const { container } = renderSim();
    await twoTabs(container);
    push({ state: 'loaded', url: PAGE, tabId: TAB_A, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element); // Hide
    push({ state: 'loading', tabId: TAB_A, inputFocused: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(pressed(container)).toBe('false');
  });
});
