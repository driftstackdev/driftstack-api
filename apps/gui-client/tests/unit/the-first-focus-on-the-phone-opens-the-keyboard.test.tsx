// Owner item 11 (2026-09-24): "Auto on screen keyboard still not always working
// especially on first …"
//
// HOW THE APP DECIDES: the phone reports a focus CHANGE (`inputFocused` on a
// page-state frame, over the live data channel, with no tab id) and the window
// shows or hides its keyboard from it. The phone never repeats a focus it has
// already reported — tapping a field that is already focused sends nothing.
//
// WHY THE FIRST FOCUS WAS MISSED, app side:
//   1. A focus that arrived before the window had manual control (an autofocus
//      while the session was still coming up) was dropped, and never re-sent.
//   2. The session's own tab restore at start-up armed the tab-switch grace,
//      which drops every tab-less focus frame for 2.5 s — and the phone's focus
//      frames are ALL tab-less. With one tab there is nothing else they could
//      describe.
//   3. An explicit Hide outlived its page: the phone clears focus on navigation
//      without reporting a blur, and only a blur lifted the Hide, so the next
//      page's first focus was swallowed.
//
// Each has its control that the pinned rules still hold.

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
// which is what grants or withholds manual control here.
const phone = { reported: true };
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    Promise.resolve({
      mode: 'manual',
      pairKind: null,
      terminal: false,
      status: 'active',
      closedReason: null,
      ...(phone.reported ? { capabilityReport: { manual_input_available: true } } : {}),
    }),
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
});

describe('the first focus on the phone opens the keyboard', () => {
  it('a focus reported BEFORE control arrives opens the keyboard once it does', async () => {
    phone.reported = false; // still coming up: no manual control yet
    const { container } = renderSim();
    // Wait until the window has read the session (it now says it is waiting on
    // the phone): a frame delivered to a listener that the read has just
    // superseded is dropped by design, and that is not what this arm is about.
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="input-capability-unreported-badge"]'),
      ).not.toBeNull(),
    );
    await waitFor(() => expect(latestDataHandler).not.toBeNull());
    // The first page autofocuses its search box while the session comes up.
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    expect(pressed(container)).not.toBe('true');
    // The phone reports it accepts taps: control arrives.
    phone.reported = true;
    // The window re-reads the session every 5 s; wait for that read, however
    // slow the machine is today.
    await waitFor(() => expect(pressed(container)).toBe('true'), { timeout: 12_000 });
  }, 20_000);

  it('the first focus right after the session restores its single tab is not swallowed', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(toggle(container)).not.toBeDisabled());
    push({
      type: 'tabListRestore',
      tabs: [{ id: 'tab_real_1', url: PAGE, scrollY: 0, title: 'Shop' }],
      activeTabId: 'tab_real_1',
    });
    // What the phone actually sends: a focus frame with NO tab id.
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it('CONTROL — with two tabs, a tab-less focus right after a switch still waits (it may be the tab just left)', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(toggle(container)).not.toBeDisabled());
    push({
      type: 'tabListRestore',
      tabs: [
        { id: 'tab_real_1', url: PAGE, scrollY: 0, title: 'Shop' },
        { id: 'tab_real_2', url: 'https://news.example.com/', scrollY: 0, title: 'News' },
      ],
      activeTabId: 'tab_real_2',
    });
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    expect(pressed(container)).toBe('false');
  });

  it("a new page's first focus is not swallowed by the last page's Hide", async () => {
    const { container } = renderSim();
    await waitFor(() => expect(toggle(container)).not.toBeDisabled());
    push({ state: 'loaded', url: PAGE, inputFocused: false });
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element); // the customer hides it
    expect(pressed(container)).toBe('false');
    // They go to another page (the phone clears focus there WITHOUT a blur)…
    push({ state: 'loading', url: 'https://shop.example.com/search', progress: 0 });
    push({ state: 'loaded', url: 'https://shop.example.com/search', progress: 1 });
    // …whose search box takes focus.
    push({ state: 'loaded', url: 'https://shop.example.com/search', inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
  });

  it('CONTROL — on the SAME page, Hide still holds until a real blur→focus edge', async () => {
    const { container } = renderSim();
    await waitFor(() => expect(toggle(container)).not.toBeDisabled());
    push({ state: 'loaded', url: PAGE, inputFocused: false });
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    await waitFor(() => expect(pressed(container)).toBe('true'));
    fireEvent.click(toggle(container) as Element);
    push({ state: 'loaded', url: PAGE, inputFocused: true });
    expect(pressed(container)).toBe('false');
  });
});
