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
import { render, fireEvent, within, act, waitFor } from '@testing-library/react';

const sendTabListUpdate = vi.fn(() => Promise.resolve());
const sendActivateTab = vi.fn(
  (_room: unknown, _payload: unknown, onRequestId?: (requestId: string) => void) => {
    onRequestId?.('req_1');
    return Promise.resolve('req_1');
  },
);
const sendNavigate = vi.fn(() => Promise.resolve());
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
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      // A fully-live session (connected + a publishing video track) so the tab-bar
      // navigation chrome is enabled (canNavigate gates on connected+publishing).
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Controllable page-state poll source (live-state accuracy refactor). Defaults to
// null (no box report) so the existing data-channel tests are unaffected; a test can
// set pageStateValue to simulate a STALE poll frame (the prior tab's url) and assert
// the grace window blocks the just-switched url from being clobbered.
let pageStateValue: {
  state: 'loading' | 'loaded' | 'errored' | 'stalled';
  url: string | null;
  title: string | null;
  tabId?: string | null;
  error: { kind?: string; message?: string } | null;
} | null = null;
const getAgentSessionPageState = vi.fn(() => Promise.resolve(pageStateValue));
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession: () =>
    immediateControl({
      mode: 'manual',
      pairKind: null,
      status: 'active',
      terminal: false,
      capabilityReport: { manual_input_available: true },
    }),
  getAgentSessionPageState,
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
    sendActivateTab.mockReset();
    sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
      onRequestId?.('req_1');
      return Promise.resolve('req_1');
    });
    sendNavigate.mockClear();
    getAgentSessionPageState.mockClear();
    pageStateValue = null;
    dataHandler = null;
  });

  // Inject a page_state frame over the data channel (the box → GUI live path).
  function pushPageState(frame: Record<string, unknown>): void {
    act(() => {
      dataHandler?.(new TextEncoder().encode(JSON.stringify(frame)));
    });
  }
  // The most recent full tab list the GUI published, by id.
  function tabsById(): Map<string, { id: string; url: string; title: string }> {
    const m = new Map<string, { id: string; url: string; title: string }>();
    for (const t of lastTabListCall().tabs as Array<{ id: string; url: string; title: string }>) {
      m.set(t.id, t);
    }
    return m;
  }
  function keyboardPressed(container: HTMLElement): string | null {
    return (
      container
        .querySelector('[data-component="simulator-keyboard-toggle"]')
        ?.getAttribute('aria-pressed') ?? null
    );
  }

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
    sendActivateTab.mockClear();
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
    // The + must ACTIVELY switch the box to the new tab's page (a state-only
    // tabListUpdate does NOT switch the published page per the contract) so the box
    // starts loading NEW_TAB_URL immediately instead of lingering on the prior tab
    // (founder 2026-07-02: "new tab keeps the old tab open until the new page loads").
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    const activateArg = sendActivateTab.mock.calls[0][1] as { tabId: string; url: string };
    expect(activateArg.tabId).toBe((payload.tabs[1] as { id: string }).id);
    expect(activateArg.url).toBe('https://driftstack.dev/newtab/');
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

  // Tab-switch audit wap1x781b (3/3 verified) — the cold-switch "switching…" blank MUST
  // stay up until the target tab genuinely LOADS. The box's page_state fires state:'loading'
  // carrying the TARGET url at nav-START; resolving the switch on that frame dropped the
  // blank while the box was still re-navigating → the OLD/loading page flashed through (the
  // founder's persistent "keeps other tab's content open + not smooth" on switch). A loading
  // frame must NOT resolve the switch. A terminal frame may update the target's stored
  // page, but only the correlated activation success proves it is now foreground.
  it('holds the "switching…" affordance through loading/loaded until correlated success', async () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // 2 tabs, tab2 active
    // Switch back to tab1 → the "switching…" affordance shows on it immediately.
    fireEvent.click(tabEls(container)[0]);
    expect(container.querySelector('[data-component="simulator-tab-switching"]')).not.toBeNull();
    // Box begins re-navigating the target → a loading frame with the TARGET url. This must
    // NOT drop the blank (else the old page is exposed mid-navigation).
    pushPageState({ state: 'loading', url: 'https://example.test/target' });
    expect(container.querySelector('[data-component="simulator-tab-switching"]')).not.toBeNull();
    // A terminal target frame can come from a warm background renderer before the
    // foreground switch commits. It updates page state but must NOT clear the blank.
    pushPageState({ state: 'loaded', url: 'https://example.test/target', title: 'Target' });
    expect(container.querySelector('[data-component="simulator-tab-switching"]')).not.toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    // Once the exact request is acknowledged, the already-seen terminal target frame
    // lets the cover clear without waiting for a duplicate page_state delivery.
    pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: true });
    expect(container.querySelector('[data-component="simulator-tab-switching"]')).toBeNull();
  });

  // #116 warm-tabs pre-flight (workflow w58dcbhxt #5): the WINDOW-GLOBAL page chrome
  // (error overlay / freeze badge / loading bar / nav-target gate) must be driven ONLY by a
  // frame for the ACTIVE tab. Today prod page_state carries no tabId so every frame is
  // implicitly the active tab (unchanged). The moment A3 stamps page_state.tabId AND
  // warm-tabs keeps live BACKGROUND renderers, a background tab's terminal frame would
  // otherwise clobber the FOREGROUND chrome — the #72/#135 false-error, re-introduced
  // cross-tab. url/title still route per-tab; only the global chrome is gated.
  it('a page_state{errored} for a recognised BACKGROUND tab does NOT pop the foreground error overlay; the ACTIVE tab still does', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active, tab1 background
    const payload = lastTabListCall();
    const activeId = payload.activeTabId;
    const bgId = (payload.tabs as { id: string }[]).map((t) => t.id).find((id) => id !== activeId);
    if (bgId === undefined) throw new Error('expected a background tab');
    // Background-tab errored frame → gated out → NO foreground overlay.
    pushPageState({
      tabId: bgId,
      state: 'errored',
      url: 'https://example.test/bg',
      error: { kind: 'dns' },
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
    // The SAME frame routed to the ACTIVE tab surfaces the overlay (chrome applies).
    pushPageState({
      tabId: activeId,
      state: 'errored',
      url: 'https://example.test/active',
      error: { kind: 'dns' },
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
  });

  it('keeps keyboard focus scoped to the active tab across rapid switches and stale frames', async () => {
    const { container } = renderSim();
    // Human input now fails closed until the control read positively resolves to
    // manual/pair. This suite's control mock is manual; wait for that ownership
    // boundary before exercising tab-scoped focus behavior.
    await waitFor(() =>
      expect(
        container.querySelector('[data-component="simulator-keyboard-toggle"]'),
      ).not.toBeDisabled(),
    );
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    const firstPayload = lastTabListCall();
    const tabAId = (firstPayload.tabs[0] as { id: string }).id;
    const tabBId = (firstPayload.tabs[1] as { id: string }).id;
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    const tabCId = (lastTabListCall().tabs[2] as { id: string }).id;

    // A fresh tab transition suppresses inherited DOM focus. The page must first
    // report blur; only the next real false→true edge may open the keyboard.
    pushPageState({ tabId: tabCId, state: 'loaded', inputFocused: true });
    expect(keyboardPressed(container)).toBe('false');
    pushPageState({ tabId: tabCId, state: 'loaded', inputFocused: false });
    expect(keyboardPressed(container)).toBe('false');
    pushPageState({ tabId: tabCId, state: 'loaded', inputFocused: true });
    expect(keyboardPressed(container)).toBe('true');

    // Rapid C→B→A switches hide synchronously. Late tagged frames from either tab
    // we left, plus an old-box tabId-less frame inside the grace period, stay ignored.
    fireEvent.click(tabEls(container)[1]);
    expect(keyboardPressed(container)).toBe('false');
    fireEvent.click(tabEls(container)[0]);
    expect(keyboardPressed(container)).toBe('false');
    pushPageState({ tabId: tabBId, state: 'loaded', inputFocused: true });
    pushPageState({ tabId: tabCId, state: 'loaded', inputFocused: true });
    pushPageState({ state: 'loaded', inputFocused: true });
    expect(keyboardPressed(container)).toBe('false');

    // The now-active tab's inherited focus is suppressed too. Explicit Show remains
    // the escape hatch for an already-focused field, and a background blur cannot
    // close the operator-owned keyboard.
    pushPageState({ tabId: tabAId, state: 'loaded', inputFocused: true });
    expect(keyboardPressed(container)).toBe('false');
    fireEvent.click(container.querySelector('[data-component="simulator-keyboard-toggle"]')!);
    expect(keyboardPressed(container)).toBe('true');
    pushPageState({ tabId: tabBId, state: 'loaded', inputFocused: false });
    expect(keyboardPressed(container)).toBe('true');
    pushPageState({ tabId: tabAId, state: 'loaded', inputFocused: false });
    expect(keyboardPressed(container)).toBe('false');
    pushPageState({ tabId: tabAId, state: 'loaded', inputFocused: true });
    expect(keyboardPressed(container)).toBe('true');
  });

  // workflow w58dcbhxt #4: opening a new tab (+) supersedes an in-flight switch, so a
  // stale ack-miss retry can't later re-issue activateTab for the abandoned tab (which
  // would swing the box's published page back to it behind the new tab). Mirrors the
  // supersede-prune onActivateTab / onCloseTab already do.
  it('opening a new tab supersedes an in-flight switch — no stale retry re-activates the abandoned tab', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
      // Switch to tab1 (in-flight — the harness sends no ack, so tab1's retry timer arms).
      fireEvent.click(tabEls(container)[0]);
      expect(
        sendActivateTab.mock.calls.some((c) => (c[1] as { tabId: string }).tabId === tab1Id),
      ).toBe(true);
      sendActivateTab.mockClear();
      // Before tab1's ack, open a NEW tab → supersedes the in-flight switch to tab1.
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
      sendActivateTab.mockClear();
      // Advance well past the ack-miss retry window: tab1's retry must have been pruned.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(
        sendActivateTab.mock.calls.some((c) => (c[1] as { tabId: string }).tabId === tab1Id),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching to a tab with an empty/seed url sends the branded NEW_TAB_URL (not "") so the box allowlist accepts it', () => {
    const { container } = renderSim();
    // The seed (first) tab stores url='' — switch AWAY (open a "+" tab, which is
    // active) then back to the seed tab and inspect the activate payload.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    const seedTabId = (lastTabListCall().tabs[0] as { id: string; url: string }).id;
    // Sanity: the seed tab really does carry an empty stored url.
    expect((lastTabListCall().tabs[0] as { url: string }).url).toBe('');
    sendActivateTab.mockClear();
    // Switch back to the empty-url seed tab.
    fireEvent.click(tabEls(container)[0]);
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    const arg = sendActivateTab.mock.calls[0][1] as { tabId: string; url: string };
    expect(arg.tabId).toBe(seedTabId);
    // Empty '' would be rejected by the box's navigate allowlist → "Could not
    // switch tab"; instead we send the branded new-tab url (which reads as blank).
    expect(arg.url).toBe('https://driftstack.dev/newtab/');
  });

  it('switching to a tab with a real url sends that url unchanged', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active (newtab)
    // Navigate the active (2nd) tab to a real url.
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    // Open a 3rd tab so we can switch BACK to the real-url 2nd tab.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab3 active
    sendActivateTab.mockClear();
    // tab order: [seed, real(example.com), newtab3]; index 1 is the real-url tab.
    fireEvent.click(tabEls(container)[1]);
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    const arg = sendActivateTab.mock.calls[0][1] as { url: string };
    expect(arg.url).toBe('https://example.com/');
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

  it('closing the ACTIVE tab sends activateTab for the neighbour so the box switches the published page', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    sendActivateTab.mockClear();
    // Close the active (second) tab — focus moves to tab1.
    const closeBtn = within(tabEls(container)[1]).getByLabelText('Close tab');
    fireEvent.click(closeBtn);
    // tabListUpdate alone does NOT switch the published video (it's fire-and-forget
    // state, per agent-tab-ops.ts) — the box only switches on activateTab. So closing
    // the active tab MUST emit an activateTab for the neighbour, else the founder closes
    // a tab and the content doesn't change.
    expect(sendActivateTab).toHaveBeenCalledTimes(1);
    const arg = sendActivateTab.mock.calls[0][1] as { tabId: string };
    expect(arg.tabId).toBe(tab1Id);
  });

  it('closing an INACTIVE tab does NOT send activateTab (the published page is unchanged)', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    sendActivateTab.mockClear();
    // Close the FIRST (inactive) tab — the active tab is unaffected, so no switch.
    const closeBtn = within(tabEls(container)[0]).getByLabelText('Close tab');
    fireEvent.click(closeBtn);
    expect(sendActivateTab).not.toHaveBeenCalled();
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

  it('repopulates the bar from a tabListRestore frame (doc-150 §7.5 — profile reopen)', () => {
    const { container } = renderSim();
    // Sanity: the fresh sim starts with exactly one seed tab.
    expect(tabEls(container)).toHaveLength(1);
    expect(dataHandler).not.toBeNull();
    // The box pushes the decrypted ProfileBlob.openTabs over the page_state channel.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'tabListRestore',
            tabs: [
              { id: 'tab_a', url: 'https://a.example/', scrollY: 0, title: 'Alpha' },
              { id: 'tab_b', url: 'https://b.example/', scrollY: 120, title: 'Bravo' },
              { id: 'tab_c', url: 'https://c.example/', scrollY: 0, title: 'Charlie' },
            ],
            activeTabId: 'tab_b',
          }),
        ),
      );
    });
    // The bar is REPLACED with the restored set (3 tabs, not 1+3).
    const tabs = tabEls(container);
    expect(tabs).toHaveLength(3);
    // The restored active tab (tab_b) is highlighted; the others are not.
    expect(tabs[0].getAttribute('data-active')).toBe('false');
    expect(tabs[1].getAttribute('data-active')).toBe('true');
    expect(tabs[2].getAttribute('data-active')).toBe('false');
    // The address bar reflects the active tab's url (BrowserBar reads liveUrl). While
    // not editing it collapses to the hostname (iOS Safari treatment); the full url is
    // still verified via the tab model elsewhere.
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput.value).toBe('b.example');
  });

  it('ignores a malformed tabListRestore frame (tabs missing / not-an-array) — keeps the current bar', () => {
    const { container } = renderSim();
    expect(tabEls(container)).toHaveLength(1);
    expect(dataHandler).not.toBeNull();
    // tabs missing.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(JSON.stringify({ type: 'tabListRestore', activeTabId: 'x' })),
      );
    });
    expect(tabEls(container)).toHaveLength(1);
    // tabs not-an-array.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ type: 'tabListRestore', tabs: 'nope', activeTabId: 'x' }),
        ),
      );
    });
    expect(tabEls(container)).toHaveLength(1);
    // empty array → nothing usable, keep the current bar.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ type: 'tabListRestore', tabs: [], activeTabId: 'x' }),
        ),
      );
    });
    expect(tabEls(container)).toHaveLength(1);
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

  it('correlates a warm success before the held publish settles and does not retry', async () => {
    vi.useFakeTimers();
    let releasePublish!: () => void;
    const heldPublish = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      sendActivateTab.mockClear();
      sendActivateTab.mockImplementationOnce((_room, _payload, onRequestId) => {
        onRequestId?.('req_fast_warm');
        return heldPublish.then(() => 'req_fast_warm');
      });

      fireEvent.click(tabEls(container)[0]); // switch to tab1; publish remains held
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'activateTabResult',
              requestId: 'req_fast_warm',
              ok: true,
              wasWarm: true,
            }),
          ),
        );
      });

      // The owner existed before publish, so the fast warm ack clears the cover now.
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);

      await act(async () => {
        releasePublish();
        await heldPublish;
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reverts a fast reject before publish settles and an old failure cannot delete the newer owner', async () => {
    vi.useFakeTimers();
    let rejectPublish!: (reason: Error) => void;
    const heldPublish = new Promise<void>((_resolve, reject) => {
      rejectPublish = reject;
    });
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;
      sendActivateTab.mockClear();
      // Deliberately collide ids to prove the old publish's rejection uses owner
      // identity and cannot delete the reject-driven reactivation owner.
      let publishCount = 0;
      sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
        onRequestId?.('req_owner_collision');
        publishCount += 1;
        return publishCount === 1
          ? heldPublish.then(() => 'req_owner_collision')
          : Promise.resolve('req_owner_collision');
      });

      fireEvent.click(tabEls(container)[0]); // optimistic tab1 switch; publish held
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'activateTabResult',
              requestId: 'req_owner_collision',
              ok: false,
            }),
          ),
        );
      });

      // Synchronous activeTabIdRef publication lets the immediate reject restore tab2
      // and issue the exact box-side reactivation before React's passive phase.
      expect(tabEls(container)[1].getAttribute('data-active')).toBe('true');
      expect(sendActivateTab).toHaveBeenCalledTimes(2);
      expect((sendActivateTab.mock.calls[1]?.[1] as { tabId: string }).tabId).toBe(tab2Id);

      await act(async () => {
        rejectPublish(new Error('old publish failed after replacement'));
        await Promise.resolve();
      });
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'activateTabResult',
              requestId: 'req_owner_collision',
              ok: true,
              wasWarm: true,
            }),
          ),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(2); // newer owner acked; no retry
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a rejected switch, re-activates the previous tab on the box (not just the GUI)', async () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;
    sendActivateTab.mockClear();
    fireEvent.click(tabEls(container)[0]); // switch to tab1 (optimistic) — activateTab #1
    await Promise.resolve();
    await Promise.resolve();
    expect(dataHandler).not.toBeNull();
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: false }),
        ),
      );
    });
    // Reverting only the GUI's activeTabId leaves the box publishing the REJECTED tab.
    // The revert must ALSO send an activateTab for the previously-active tab so the
    // published video returns to it — not just flip the strip highlight.
    const reactivate = sendActivateTab.mock.calls.find(
      (c) => (c[1] as { tabId: string }).tabId === tab2Id,
    );
    expect(reactivate).toBeDefined();
  });

  it('a new ("+") tab opens the branded Driftstack new-tab page (NOT about:blank) and does NOT inherit the prior page url/title', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // The box reports a live page on the (single) seed tab.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://example.com/', title: 'Example Domain' }),
        ),
      );
    });
    // The seed tab now tracks the live page (sanity).
    expect((lastTabListCall().tabs[0] as { url: string; title: string }).url).toBe(
      'https://example.com/',
    );
    sendTabListUpdate.mockClear();
    // Open a new tab — it must open the branded new-tab page, not a clone of example.com.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    const payload = lastTabListCall();
    expect(payload.tabs).toHaveLength(2);
    const fresh = payload.tabs[1] as { url: string; title: string };
    // Founder 2026-06-25: the "+" opens our branded /newtab page, never about:blank.
    // The url carries the trailing slash (the served path) to skip the 308 redirect.
    expect(fresh.url).toBe('https://driftstack.dev/newtab/');
    expect(fresh.url).not.toBe('about:blank');
    expect(fresh.title).toBe('New Tab');
    // And the prior page's url/title must NOT have been stamped onto the new tab by
    // the active-tab sync effect (the bug: it carried example.com onto the + tab).
    expect(fresh.url).not.toBe('https://example.com/');
    expect(fresh.title).not.toBe('Example Domain');
    // The new tab's strip label reads "New Tab" (the /newtab url is treated as a blank
    // home tab in the label fallback), not the host.
    const tabs = tabEls(container);
    expect(tabs[1].textContent).toContain('New Tab');
    expect(tabs[1].textContent).not.toContain('driftstack.dev');
  });

  it('switching tabs seeds BOTH url and title from the target tab (no prior-title flicker onto the new tab)', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Tab 1 (the seed) gets a live page: GitHub.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://github.com/', title: 'GitHub' }),
        ),
      );
    });
    // Open + navigate a second tab to Google so it has its own url+title.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active, blank
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ state: 'loaded', url: 'https://google.com/', title: 'Google' }),
        ),
      );
    });
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;
    sendTabListUpdate.mockClear();
    // Switch from Google (tab2) back to GitHub (tab1).
    fireEvent.click(tabEls(container)[0]);
    const tabsAfter = lastTabListCall().tabs as Array<{ id: string; title: string; url: string }>;
    const t1 = tabsAfter.find((t) => t.id === tab1Id);
    const t2 = tabsAfter.find((t) => t.id === tab2Id);
    // The newly-active GitHub tab keeps its OWN title — the prior tab's "Google"
    // must not be stamped onto it (the switch bug).
    expect(t1?.title).toBe('GitHub');
    expect(t1?.url).toBe('https://github.com/');
    expect(t1?.title).not.toBe('Google');
    // Google's tab is untouched.
    expect(t2?.title).toBe('Google');
  });

  // ── Live-state accuracy refactor (founder pain: "2nd switch stays on the same
  //    url"; "title doesn't update realtime") ───────────────────────────────────

  it('(a) a two-tab round-trip switch keeps each tab on its OWN url/title (no convergence)', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Tab 1 (seed) loads site A.
    pushPageState({ state: 'loaded', url: 'https://alpha.example/', title: 'Alpha' });
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    // Open tab 2 and load site B into it.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    pushPageState({ state: 'loaded', url: 'https://bravo.example/', title: 'Bravo' });
    const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;

    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    // The resting bar collapses to the hostname (iOS Safari) — still uniquely identifies
    // each tab's page; the full stored urls are asserted via tabsById() below.
    // Switch back to tab 1 — address bar shows A; both tabs keep their own url.
    fireEvent.click(tabEls(container)[0]);
    expect(addressInput.value).toBe('alpha.example');
    // Switch to tab 2 — this is the exact "2nd switch" the founder hit. It must show
    // B, NOT stay on A (the old self-reinforcing clobber converged both to one url).
    fireEvent.click(tabEls(container)[1]);
    expect(addressInput.value).toBe('bravo.example');
    // And back to tab 1 a THIRD time — still A. Neither tab's stored url drifted.
    fireEvent.click(tabEls(container)[0]);
    expect(addressInput.value).toBe('alpha.example');

    const byId = tabsById();
    expect(byId.get(tab1Id)?.url).toBe('https://alpha.example/');
    expect(byId.get(tab1Id)?.title).toBe('Alpha');
    expect(byId.get(tab2Id)?.url).toBe('https://bravo.example/');
    expect(byId.get(tab2Id)?.title).toBe('Bravo');
  });

  it('(b) a title-only page_state frame after load updates the active tab label (no url)', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Load a page (url + initial title).
    pushPageState({ state: 'loaded', url: 'https://shop.example/', title: 'Shop' });
    const tabId = (lastTabListCall().tabs[0] as { id: string }).id;
    expect(tabsById().get(tabId)?.title).toBe('Shop');
    // A later title-only update (a SPA route change / late <title> mutation): a
    // page_state frame with NO new url, only a new title (here a 'loaded' frame, but
    // the title path fires on ANY state — not just the initial load-commit). It must
    // refresh the active tab's label.
    pushPageState({ state: 'loaded', title: 'Shop — Checkout' });
    const byId = tabsById();
    expect(byId.get(tabId)?.title).toBe('Shop — Checkout');
    // The url is untouched by a title-only frame.
    expect(byId.get(tabId)?.url).toBe('https://shop.example/');
    // The visible tab strip label reflects the new title.
    expect(tabEls(container)[0].textContent).toContain('Shop — Checkout');
  });

  it('(c) a STALE poll within the grace window does NOT clobber a just-switched url', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      expect(dataHandler).not.toBeNull();
      // Tab 1 = site A; tab 2 = site B.
      pushPageState({ state: 'loaded', url: 'https://aaa.example/', title: 'A' });
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
      pushPageState({ state: 'loaded', url: 'https://bbb.example/', title: 'B' });
      const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;

      const addressInput = container.querySelector(
        '[aria-label="Address bar"]',
      ) as HTMLInputElement;
      // Switch back to tab 1 (active = A). Arm a STALE poll that still reports B (the
      // prior tab) with NO tabId — exactly the prod page-state poll lagging a switch.
      fireEvent.click(tabEls(container)[0]);
      // Resting bar shows the hostname (iOS Safari collapse); stored full url asserted below.
      expect(addressInput.value).toBe('aaa.example');
      pageStateValue = {
        state: 'loaded',
        url: 'https://bbb.example/',
        title: 'B',
        tabId: null,
        error: null,
      };
      // Fire a poll tick INSIDE the grace window. The stale B url must be suppressed —
      // the active tab stays on A (the founder's clobber bug). Flush the poll promise.
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(addressInput.value).toBe('aaa.example');
      // Tab 1's stored url is still A; tab 2 (B) is untouched.
      const byId = tabsById();
      expect([...byId.values()].some((t) => t.url === 'https://aaa.example/')).toBe(true);
      expect(byId.get(tab2Id)?.url).toBe('https://bbb.example/');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c2) the one-shot RECONCILE within the grace window does NOT clobber a just-switched url (macrotask resolve)', async () => {
    // This is the faithful prod ordering the existing case-(c) test masks: the explicit
    // reconcile fired by onActivateTab resolves its getAgentSessionPageState on a
    // MACROTASK — AFTER the switch's activeTabIdRef effect has committed — and the box's
    // page-state STILL reflects the PRIOR tab (tabId null). Without grace-gating the
    // reconcile, that stale prior url routes onto the just-switched active tab and
    // re-breaks the founder's "2nd switch stays on the same url" fix.
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      expect(dataHandler).not.toBeNull();
      // Tab 1 = site A; tab 2 = site B (active after open).
      pushPageState({ state: 'loaded', url: 'https://aaa.example/', title: 'A' });
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
      pushPageState({ state: 'loaded', url: 'https://bbb.example/', title: 'B' });
      const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
      const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;

      const addressInput = container.querySelector(
        '[aria-label="Address bar"]',
      ) as HTMLInputElement;

      // ARM the stale box page-state BEFORE the switch: the box still reports B (the
      // PRIOR tab) with NO tabId — and the reconcile fetch resolves on a real MACROTASK
      // (a setTimeout(0), like an HTTP round-trip) so it lands AFTER the activeTabId
      // commit, not in the same synchronous microtask the seed mock uses.
      getAgentSessionPageState.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  state: 'loaded',
                  url: 'https://bbb.example/',
                  title: 'B',
                  tabId: null,
                  error: null,
                }),
              0,
            );
          }),
      );

      // Switch from tab 2 (B) back to tab 1 (A) — the address bar shows A immediately
      // (hostname collapse: 'aaa.example'). The full stored urls are asserted below.
      fireEvent.click(tabEls(container)[0]);
      expect(addressInput.value).toBe('aaa.example');

      // Let the macrotask reconcile resolve INSIDE the grace window. The stale B url
      // must be suppressed — tab 1 stays on A, tab 2 keeps B; NEITHER flips to the
      // prior page.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(addressInput.value).toBe('aaa.example');
      const byId = tabsById();
      expect(byId.get(tab1Id)?.url).toBe('https://aaa.example/');
      expect(byId.get(tab2Id)?.url).toBe('https://bbb.example/');
    } finally {
      getAgentSessionPageState.mockImplementation(() => Promise.resolve(pageStateValue));
      vi.useRealTimers();
    }
  });

  it('(c3) a STALE tabId-less poll within the grace window does NOT resolve the switch (keeps the retry net + spinner alive)', async () => {
    // Regression: a tabId-less poll frame that lands DURING the post-switch grace window
    // still carries the PRIOR tab's page. It used to unconditionally resolve the switch
    // via writeTabPageState → cancelling the activateTab retry net and clearing the
    // "switching…" spinner BEFORE the box actually switched — silently re-introducing the
    // dropped-ack failure the retry net was added to fix. The in-grace tabId-less frame
    // must NOT be treated as authoritative for the switch.
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      expect(dataHandler).not.toBeNull();
      pushPageState({ state: 'loaded', url: 'https://aaa.example/', title: 'A' });
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      pushPageState({ state: 'loaded', url: 'https://bbb.example/', title: 'B' });
      sendActivateTab.mockClear();
      // Switch back to tab 1 → first activateTab send + spinner on tab 1.
      fireEvent.click(tabEls(container)[0]);
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
      // Arm a STALE tabId-less poll (still the prior tab B) and let a poll tick fire
      // INSIDE the grace window. It must NOT resolve the switch.
      pageStateValue = {
        state: 'loaded',
        url: 'https://bbb.example/',
        title: 'B',
        tabId: null,
        error: null,
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // The spinner is still up — the switch was NOT prematurely resolved.
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
      // And the ack-miss retry net is still armed: the next backoff re-issues activateTab
      // (it would have been cancelled if the stale poll had resolved the switch).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a prior tab error overlay + stalled badge when SWITCHING to another tab', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Open a 2nd tab (tab2 active); tab1 = the one that will carry an error.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    // Switch back to tab1, then fail its load → the full-screen error overlay shows.
    fireEvent.click(tabEls(container)[0]);
    pushPageState({
      state: 'errored',
      url: 'https://a.example/',
      error: { kind: 'net', message: 'x' },
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
    // Switch to tab2 (a healthy page). The error overlay must NOT bleed onto it.
    fireEvent.click(tabEls(container)[1]);
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
  });

  it('clears a prior tab stalled badge when OPENING a new tab', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    pushPageState({ state: 'stalled', url: 'https://a.example/' });
    expect(container.querySelector('[data-component="page-stalled-badge"]')).not.toBeNull();
    // Open a fresh tab → the prior tab's stalled badge must not cover the new tab.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    expect(container.querySelector('[data-component="page-stalled-badge"]')).toBeNull();
  });

  it('clears the error overlay when CLOSING the active (errored) tab focuses a neighbour', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Two tabs; make tab2 (active) the errored one, then close it.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    pushPageState({
      state: 'errored',
      url: 'https://b.example/',
      error: { kind: 'net', message: 'x' },
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
    // Close tab2 → focus moves to tab1; the overlay must not linger over it.
    const closeBtn = within(tabEls(container)[1]).getByLabelText('Close tab');
    fireEvent.click(closeBtn);
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
  });

  it('(d) a page_state carrying tabId routes url/title to THAT tab (not the active one)', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Tab 1 = site A (active); tab 2 = site B (active after open).
    pushPageState({ state: 'loaded', url: 'https://one.example/', title: 'One' });
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    pushPageState({ state: 'loaded', url: 'https://two.example/', title: 'Two' });
    const tab2Id = (lastTabListCall().tabs[1] as { id: string }).id;

    // While tab 2 is active, the box reports a background-tab page_state for tab 1
    // (a redirect / push-navigation in the non-foreground renderer). It must land on
    // tab 1 — NOT the active tab 2.
    pushPageState({
      state: 'loaded',
      tabId: tab1Id,
      url: 'https://one.example/redirected',
      title: 'One Redirected',
    });
    const byId = tabsById();
    expect(byId.get(tab1Id)?.url).toBe('https://one.example/redirected');
    expect(byId.get(tab1Id)?.title).toBe('One Redirected');
    // The active tab 2 is untouched by a frame addressed to tab 1.
    expect(byId.get(tab2Id)?.url).toBe('https://two.example/');
    expect(byId.get(tab2Id)?.title).toBe('Two');
    // And the address bar (active = tab 2) still shows tab 2's url, not tab 1's
    // (resting hostname collapse — 'two.example', not the redirected tab 1).
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput.value).toBe('two.example');
  });

  it('(e) a page_state with an UNRECOGNISED tabId falls back to the active tab, never dropped (regression: #63 box tagging must not FREEZE url/title on a box↔GUI id skew)', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Active tab loads site A (establishes a known active tab + its stored url).
    pushPageState({ state: 'loaded', url: 'https://active.example/', title: 'Active' });
    const activeId = (lastTabListCall().tabs[0] as { id: string }).id;
    // The box now stamps a tabId (#63), but sends one THIS window has no tab for —
    // box-internal id / id-scheme skew. It must NOT be dropped (that froze the
    // founder's url/title); fall back to the active tab so it keeps updating live.
    pushPageState({
      state: 'loaded',
      tabId: 'box-internal-id-not-in-gui',
      url: 'https://updated.example/',
      title: 'Updated',
    });
    const byId = tabsById();
    expect(byId.get(activeId)?.url).toBe('https://updated.example/');
    expect(byId.get(activeId)?.title).toBe('Updated');
    // The visible address bar (active tab) reflects the update (hostname collapse).
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput.value).toBe('updated.example');
  });

  // ── Branded new-tab page (founder 2026-06-25) ─────────────────────────────────

  it('a new (+) tab reads as a clean "New Tab" — slashed url + box title chrome are hidden', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    // The new tab seeds the SLASHED served path (no 308 redirect hop).
    const tabs = lastTabListCall().tabs as Array<{ url: string }>;
    expect(tabs[1]?.url).toBe('https://driftstack.dev/newtab/');
    // The box reports the branded page's own title + url (slashed) — both are chrome
    // for a blank tab. The label must still read "New Tab", and the address bar blank.
    pushPageState({
      state: 'loaded',
      url: 'https://driftstack.dev/newtab/',
      title: 'New Tab · Driftstack',
    });
    expect(tabEls(container)[1].textContent).toContain('New Tab');
    expect(tabEls(container)[1].textContent).not.toContain('Driftstack');
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput.value).toBe('');
  });

  it('a blocked new-tab (errored branded page through the proxy) does NOT show a hard error overlay', () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    // The proxy can't reach driftstack.dev → the box reports the new-tab url 'errored'.
    // It must stay graceful (a blank tab), NOT a "Page failed to load" overlay.
    pushPageState({
      state: 'errored',
      url: 'https://driftstack.dev/newtab/',
      error: { kind: 'net' },
    });
    expect(container.querySelector('[data-component="page-error-overlay"]')).toBeNull();
    // A REAL page error (a normal site that failed) still shows the overlay.
    pushPageState({ state: 'errored', url: 'https://blocked.example/', error: { kind: 'net' } });
    expect(container.querySelector('[data-component="page-error-overlay"]')).not.toBeNull();
  });

  // ── Tab-switch UX round 2 (founder 2026-06-25) ────────────────────────────────

  it('stores a target page before ack but clears the switch only after correlated success', async () => {
    const { container } = renderSim();
    expect(dataHandler).not.toBeNull();
    // Two tabs, each with its own loaded page.
    pushPageState({ state: 'loaded', url: 'https://alpha.example/', title: 'Alpha' });
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    pushPageState({ state: 'loaded', url: 'https://bravo.example/', title: 'Bravo' });
    // Switch back to tab 1 — the affordance appears on tab 1 immediately (instant feedback).
    fireEvent.click(tabEls(container)[0]);
    await Promise.resolve();
    const tab1 = tabEls(container)[0];
    expect(tab1.getAttribute('data-switching')).toBe('true');
    expect(tab1.querySelector('[data-component="simulator-tab-switching"]')).not.toBeNull();
    // A title-only update is useful tab metadata, but it is not a terminal
    // navigation state. Missing `state` must not be mistaken for foreground proof.
    pushPageState({ type: 'page_state', tabId: tab1Id, title: 'Alpha — updated' });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
    // A target-tagged loaded frame may be emitted by its background renderer. Store it,
    // but keep the foreground cover/retry owner until the exact activation succeeds.
    pushPageState({
      state: 'loaded',
      tabId: tab1Id,
      url: 'https://alpha.example/',
      title: 'Alpha',
    });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
    pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: true });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
    expect(
      tabEls(container)[0].querySelector('[data-component="simulator-tab-switching"]'),
    ).toBeNull();
  });

  it('a WARM activateTabResult ack (wasWarm:true) clears the "switching…" affordance immediately (#116 warm-tabs — live view is already front)', async () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    sendActivateTab.mockClear();
    fireEvent.click(tabEls(container)[0]); // switch to tab1 → switching affordance on tab1
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
    // Flush the sendActivateTab resolve so the pending record (req_1) is tracked.
    await Promise.resolve();
    await Promise.resolve();
    // The harness ACKS a WARM swap — the target's live view is already front, so the
    // affordance clears instantly (no re-navigation to wait on).
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'activateTabResult',
            requestId: 'req_1',
            ok: true,
            wasWarm: true,
          }),
        ),
      );
    });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
  });

  it('a COLD activateTabResult ack KEEPS the "switching…" affordance until the target LOADS (#116 — a cold re-nav must not flash the old/loading page)', async () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
    sendActivateTab.mockClear();
    fireEvent.click(tabEls(container)[0]); // switch to tab1 → affordance on tab1
    const tab1Id = (lastTabListCall().tabs[0] as { id: string }).id;
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
    await Promise.resolve();
    await Promise.resolve();
    // A COLD ack (no wasWarm) — the box RE-NAVIGATES, so the affordance must STAY up so
    // the reload never flashes the prior/loading page. Only the re-issue timer is cancelled.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: true }),
        ),
      );
    });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true'); // still up
    // The target tab's `loaded` page_state (tabId-tagged, #63) then hides the reload →
    // the affordance clears.
    act(() => {
      dataHandler?.(
        new TextEncoder().encode(
          JSON.stringify({
            state: 'loaded',
            tabId: tab1Id,
            url: 'https://loaded.example/',
            title: 'Loaded',
          }),
        ),
      );
    });
    expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
  });

  it('an old same-tab cover timeout cannot clear a later A→B→A switch owner', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // B active

      // First B→A switch at t=0. A warm ack clears its visible cover, but the old
      // implementation left the anonymous six-second timeout alive.
      fireEvent.click(tabEls(container)[0]);
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_1',
        ok: true,
        wasWarm: true,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // A→B, then B→A again at t=2s. Leave the successor as a cold acknowledged
      // switch: its cover must remain until its own terminal frame or its own t=8s net.
      fireEvent.click(tabEls(container)[1]);
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_1',
        ok: true,
        wasWarm: true,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      fireEvent.click(tabEls(container)[0]);
      pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: true });
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');

      // The first A owner's former deadline lands at t=6s. It has no authority over
      // the distinct successor owner for the same tab id.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the visual escape keeps correlated ownership bounded; a stale old ack cannot settle a later same-tab switch', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
        const requestId = `req_escape_${++n}`;
        onRequestId?.(requestId);
        return Promise.resolve(requestId);
      });
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // B active
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_escape_1',
        ok: true,
        wasWarm: true,
      });

      fireEvent.click(tabEls(container)[0]); // B→A, req2
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      const escape = container.querySelector(
        '[data-component="switch-blank-escape"]',
      ) as HTMLButtonElement;
      expect(escape).not.toBeNull();
      fireEvent.click(escape);
      expect(container.querySelector('[data-component="simulator-switch-blank"]')).toBeNull();

      // Visual dismissal must not orphan req2/req3/req4. Its final bounded retry
      // deadline still retires the logical owner and surfaces the soft outcome.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(container.querySelector('[role="status"]')?.textContent).toContain('switching');

      fireEvent.click(tabEls(container)[1]); // A→B, req5
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_escape_5',
        ok: true,
        wasWarm: true,
      });
      fireEvent.click(tabEls(container)[0]); // B→A successor, req6
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');

      // The retired first A owner's late reject is inert against the same-tab successor.
      pushPageState({ type: 'activateTabResult', requestId: 'req_escape_2', ok: false });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_escape_6',
        ok: true,
        wasWarm: true,
      });
      const sendsAfterSuccess = sendActivateTab.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(sendsAfterSuccess);
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('RE-SENDS activateTab on a missed ack (retry), then SOFT-fails without an alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      sendActivateTab.mockClear();
      // Switch to tab1 → the FIRST activateTab is sent immediately.
      fireEvent.click(tabEls(container)[0]);
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      // The ack never arrives. Each backoff (1200ms) re-issues activateTab — up to 3
      // total (initial + 2 retries). Advance two backoffs → two more sends.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(3);
      // The third backoff exhausts the retries → SOFT-fail: a non-blocking notice, NO
      // alert, no further re-send, and the affordance clears (never hangs).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(3); // no 4th send
      expect(alertSpy).not.toHaveBeenCalled();
      // The operator stays on the tab they tapped (a dropped ack is NOT a reject — we
      // don't yank them back); the switching affordance is cleared.
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
      // A soft toast was surfaced (role=status), never a blocking alert.
      expect(container.querySelector('[role="status"]')?.textContent).toContain('switching');
    } finally {
      vi.useRealTimers();
      alertSpy.mockRestore();
    }
  });

  it('a CONFIRMED ack (ok) cancels the retry timer — no re-send fires', async () => {
    vi.useFakeTimers();
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      sendActivateTab.mockClear();
      fireEvent.click(tabEls(container)[0]); // switch to tab1 → first send
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
      // Flush the resolve so req_1 is the tracked pending requestId.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // The harness ACKS before the backoff elapses → the retry timer is cancelled.
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: true }),
          ),
        );
      });
      // Advance well past several backoffs — no re-send because the ack cleared it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one logical switch when an older retry errors before a newer sibling succeeds', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
        const requestId = `req_${++n}`;
        onRequestId?.(requestId);
        return Promise.resolve(requestId);
      });
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
      sendActivateTab.mockClear();
      n = 0;

      fireEvent.click(tabEls(container)[0]);
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(2);

      // R1 fails after R2 is already live. It cannot revert, clear the cover, show a
      // failure notice or issue a reject-driven activation of the previous tab.
      pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: false });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('true');
      expect(sendActivateTab).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="status"]')?.textContent ?? '').not.toContain(
        'Could not switch tab',
      );

      // Any sibling success wins exactly once. The older error is now permanently inert.
      pushPageState({
        type: 'activateTabResult',
        requestId: 'req_2',
        ok: true,
        wasWarm: true,
      });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
      pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      expect(sendActivateTab).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale/superseded error-ack does NOT revert a switch that already landed (two in-flight requestIds)', async () => {
    // Each re-issue mints a NEW requestId for the SAME tab, so 2+ requestIds can be
    // outstanding at once (R1, R2). When R1 acks ok the switch lands; a LATE R2
    // error-ack (a colliding duplicate wd.navigate → -1005 even though the page
    // switched) must NOT yank the operator back to the previous tab.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      // Distinct requestIds per activateTab send so R1 and R2 are separately tracked.
      let n = 0;
      sendActivateTab.mockImplementation((_room, _payload, onRequestId) => {
        const requestId = `req_${++n}`;
        onRequestId?.(requestId);
        return Promise.resolve(requestId);
      });
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      sendActivateTab.mockClear();
      n = 0;
      // Switch to tab1 → R1 sent. A missed ack re-issues after the 1200ms backoff → R2.
      fireEvent.click(tabEls(container)[0]); // optimistic switch to tab1
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(1); // R1
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200); // backoff → R2
      });
      expect(sendActivateTab).toHaveBeenCalledTimes(2); // R1 + R2
      // R1 acks OK → the switch to tab1 lands (affordance clears, tab1 active).
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: true }),
          ),
        );
      });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      // R2's LATE error-ack arrives — it must be ignored (R1 already resolved the tab),
      // NOT revert to tab2.
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({ type: 'activateTabResult', requestId: 'req_2', ok: false }),
          ),
        );
      });
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true'); // still tab1
      expect(tabEls(container)[1].getAttribute('data-active')).toBe('false');
      // No "Could not switch tab" toast for the stale ack.
      expect(container.querySelector('[role="status"]')?.textContent ?? '').not.toContain(
        'Could not switch tab',
      );
      expect(alertSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      alertSpy.mockRestore();
    }
  });

  it('a hard reject (activateTabResult ok:false) reverts the tab and shows a soft notice (no alert)', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    try {
      const { container } = renderSim();
      fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element); // tab2 active
      sendActivateTab.mockClear();
      fireEvent.click(tabEls(container)[0]); // optimistic switch to tab1
      expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
      await Promise.resolve();
      await Promise.resolve();
      act(() => {
        dataHandler?.(
          new TextEncoder().encode(
            JSON.stringify({ type: 'activateTabResult', requestId: 'req_1', ok: false }),
          ),
        );
      });
      // Reverted to tab2, affordance cleared, soft notice (no alert).
      expect(tabEls(container)[1].getAttribute('data-active')).toBe('true');
      expect(tabEls(container)[0].getAttribute('data-switching')).toBe('false');
      expect(alertSpy).not.toHaveBeenCalled();
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'Could not switch tab',
      );
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('a final reject never selects a previous tab that closed while the switch was pending', () => {
    const { container } = renderSim();
    // The + activation owns B with previous=A. Close inactive A before B's result.
    fireEvent.click(container.querySelector('[aria-label="New tab"]') as Element);
    const tabs = tabEls(container);
    const survivingId = lastTabListCall().activeTabId;
    fireEvent.click(within(tabs[0]).getByLabelText('Close tab'));
    expect(tabEls(container)).toHaveLength(1);

    // Deliver synchronously after close — before a passive tabsRef mirror could
    // rescue a stale implementation. Active ownership must stay on surviving B.
    pushPageState({ type: 'activateTabResult', requestId: 'req_1', ok: false });
    expect(tabEls(container)).toHaveLength(1);
    expect(tabEls(container)[0].getAttribute('data-active')).toBe('true');
    expect(lastTabListCall().activeTabId).toBe(survivingId);
  });
});
