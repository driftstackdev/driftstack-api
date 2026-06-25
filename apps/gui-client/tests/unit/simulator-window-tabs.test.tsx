// SimulatorWindow — browser-style page TAB strip (doc-150 item 4; locked A2↔A3
// contract). The GUI owns the tab model and emits two ops over the SAME reliable
// LiveKit data channel as taps/navigate:
//   - tabListUpdate (full list, fire-and-forget) on every new / close / switch
//   - activateTab (with a correlation requestId) on a switch; the harness replies
//     activateTabResult { ok?, error? } which we handle for revert-on-reject.
//
// Mirrors the navigate suite's harness: a mocked AgentSessionPanel fires onRoom so
// the simulator's `room` is non-null (the wrappers no-op until connected), and the
// control transport is stubbed to 'manual' so the full chrome (including the tab
// strip, gated on the default-ON browser mode) renders.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, within, act } from '@testing-library/react';

const sendTabListUpdate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(() => Promise.resolve('req_1'));
const sendNavigate = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate,
  sendTabListUpdate,
  sendActivateTab,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
  },
}));

// Surface a fake connected Room upward (jsdom can't do a real WebRTC connect) so the
// tab strip's sends are enabled. Capture the DataReceived handler so the test can
// inject an activateTabResult reply frame.
let dataHandler: ((p: Uint8Array) => void) | null = null;
const fakeRoom = {
  on: vi.fn((event: string, cb: (p: Uint8Array) => void) => {
    if (event === 'dataReceived') dataHandler = cb;
  }),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  navigateAgentSessionHistory: vi.fn(() => Promise.resolve()),
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

function tabEls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-component="simulator-tab"]'));
}

function lastTabListCall(): { sessionId: string; tabs: unknown[]; activeTabId: string } {
  const calls = sendTabListUpdate.mock.calls as unknown as Array<
    [unknown, { sessionId: string; tabs: unknown[]; activeTabId: string }]
  >;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('sendTabListUpdate was not called');
  return last[1];
}

describe('SimulatorWindow — page tab strip', () => {
  beforeEach(() => {
    sendTabListUpdate.mockClear();
    sendActivateTab.mockClear();
    sendNavigate.mockClear();
    dataHandler = null;
  });

  it('renders a single seed tab with a + new-tab button (always ≥1 tab)', () => {
    const { container } = renderSim();
    expect(container.querySelector('[data-component="simulator-tab-strip"]')).not.toBeNull();
    expect(tabEls(container)).toHaveLength(1);
    expect(container.querySelector('[aria-label="New tab"]')).not.toBeNull();
    // The lone tab has no close button (never go below one tab).
    expect(within(tabEls(container)[0]).queryByLabelText('Close tab')).toBeNull();
  });

  it('the + button appends a tab, activates it, and publishes the full list', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    const tabs = tabEls(container);
    expect(tabs).toHaveLength(2);
    // The new tab is active (highlighted).
    expect(tabs[1].getAttribute('data-active')).toBe('true');
    expect(tabs[0].getAttribute('data-active')).toBe('false');
    // The full list was published with the new tab active.
    const payload = lastTabListCall();
    expect(payload.sessionId).toBe('agt_x');
    expect(payload.tabs).toHaveLength(2);
    expect(payload.activeTabId).toBe((payload.tabs[1] as { id: string }).id);
  });

  it('clicking an inactive tab activates it + sends activateTab (correlation) and a fresh list', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // 2 tabs, tab2 active
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    sendTabListUpdate.mockClear();
    sendActivateTab.mockClear();
    // Switch back to the first tab.
    fireEvent.click(tabEls(container)[0]);
    expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    const activateArg = sendActivateTab.mock.calls[0][1] as { sessionId: string; tabId: string };
    expect(activateArg.sessionId).toBe('agt_x');
    expect(activateArg.tabId).toBe(tab1Id);
    // The list was re-published with tab1 active.
    expect(lastTabListCall().activeTabId).toBe(tab1Id);
  });

  it('closing a non-active tab removes it; never drops below one (no close ✕ on the last)', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // 2 tabs, tab2 active
    // Close the FIRST (inactive) tab via its ✕.
    const closeBtn = within(tabEls(container)[0]).getByLabelText('Close tab');
    fireEvent.click(closeBtn);
    expect(tabEls(container)).toHaveLength(1);
    // The remaining (was-active) tab stays active + has no close button.
    expect(within(tabEls(container)[0]).queryByLabelText('Close tab')).toBeNull();
    // The close published the new single-tab list.
    expect(lastTabListCall().tabs).toHaveLength(1);
  });

  it('closing the ACTIVE tab activates the left neighbor', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;
    // Close the active (second) tab.
    const closeBtn = within(tabEls(container)[1]).getByLabelText('Close tab');
    fireEvent.click(closeBtn);
    const remaining = tabEls(container);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].getAttribute('data-active')).toBe('true');
    // The neighbor (the first tab) became active — not the closed id.
    expect(lastTabListCall().activeTabId).not.toBe(tab2Id);
  });

  it('a navigate updates the ACTIVE tab url + publishes the list', () => {
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://example.com/');
    // The active tab's url tracked the navigate + the list was re-published.
    const payload = lastTabListCall();
    expect((payload.tabs[0] as { url: string }).url).toBe('https://example.com/');
  });

  it('reverts the optimistic switch when the harness replies activateTabResult{ok:false}', async () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    // sendActivateTab resolves req_1; capture which tab we tried to activate.
    sendActivateTab.mockClear();
    fireEvent.click(tabEls(container)[0]); // switch to tab1 (optimistic)
    expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
    // The pending-activation record is set in sendActivateTab's resolve microtask —
    // flush it before injecting the reply so the requestId is tracked for revert.
    await Promise.resolve();
    await Promise.resolve();
    // The harness REJECTS the switch; the GUI reverts to the previously-active tab.
    expect(dataHandler).not.toBeNull();
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: false }),
        ),
      );
    });
    // Reverted: the second tab is active again.
    expect(tabEls(container)[1].getAttribute('data-active')).toBe('true');
    expect(tabEls(container)[0].getAttribute('data-active')).toBe('false');
  });
});
