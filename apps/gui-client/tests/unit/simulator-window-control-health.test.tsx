// SimulatorWindow — control-channel health + address-bar connect state.
//
// Two quick-win fixes covered here:
//   1. The amber "control may not be reaching the device" badge (set on the
//      first failed input-publish) used to LATCH forever — it was never reset on
//      recovery. It must clear when a fresh/reconnected room arrives.
//   2. While the room is still connecting (up to ~30s) the address bar is
//      disabled. A bare disabled field reads as broken, so the bar surfaces an
//      explicit "connecting…" affordance, distinct from a real failure (which
//      surfaces as a navigate-error notice toast).
//
// A controllable AgentSessionPanel mock exposes onPublishError + onRoom so the
// test can drive the failed-publish → recovery sequence (the real panel needs a
// live WebRTC connect jsdom can't do).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

// Browser mode defaults ON (founder 2026-06-21), which hosts the URL bar in the
// toolbar and hides the panel's NavigateAddressBar. These tests exercise the
// panel address bar's connecting affordance, so pin Browser mode OFF with a
// working localStorage stub (jsdom's is non-functional here).
beforeEach(() => {
  const store = new Map<string, string>([
    ['ds-sim-browser-mode', '0'],
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
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
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

// Capture the panel's callbacks so the test can fire onPublishError / onRoom on
// demand (the real panel only surfaces these after a live connect).
const panelCbs: {
  onPublishError?: () => void;
  onRoom?: (room: unknown) => void;
} = {};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onPublishError?: () => void; onRoom?: (room: unknown) => void }) => {
    panelCbs.onPublishError = props.onPublishError;
    panelCbs.onRoom = props.onRoom;
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// Control transport stays pending so a control round-trip can't itself clear the
// badge — isolates the room-recovery reset path.
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  getAgentSession: () => new Promise(() => {}),
  getAgentSessionPageState: () => Promise.resolve(null),
  // The cookies drawer poll (founder #48) calls this once the room connects; the
  // mock must export it or the poll's tick throws + crashes the component.
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

describe('SimulatorWindow — controlUnreachable badge does not latch', () => {
  it('shows the badge on a failed input-publish, then CLEARS it when a room (re)connects', () => {
    const { container } = renderSim();
    // No badge initially.
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
    // A failed publish raises the badge.
    act(() => panelCbs.onPublishError?.());
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).not.toBeNull();
    // A fresh/reconnected room clears it (the latch is gone).
    act(() => panelCbs.onRoom?.(fakeRoom));
    expect(container.querySelector('[data-component="control-unreachable-badge"]')).toBeNull();
  });
});

describe('SimulatorWindow — address bar connect state', () => {
  it('reads "connecting…" (not broken) while the room is still connecting, and unlocks once connected', () => {
    const { container } = renderSim();
    // Open the control panel (the address bar lives in the expandable area).
    fireEvent.click(container.querySelector('[aria-label="Show controls"]') as Element);

    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput).not.toBeNull();
    // While connecting: disabled, an explicit connecting placeholder + tooltip,
    // and a "connecting…" caption beside the Address label.
    expect(addressInput.disabled).toBe(true);
    expect(addressInput.getAttribute('placeholder')).toContain('connecting…');
    expect(addressInput.getAttribute('title')).toContain('Connecting');
    expect(
      container.querySelector('[data-component="simulator-address-connecting"]'),
    ).not.toBeNull();

    // Once the room connects the bar unlocks and the connecting caption is gone.
    act(() => panelCbs.onRoom?.(fakeRoom));
    const connectedInput = container.querySelector(
      '[aria-label="Address bar"]',
    ) as HTMLInputElement;
    expect(connectedInput.disabled).toBe(false);
    expect(connectedInput.getAttribute('placeholder')).toContain('Search or enter');
    expect(container.querySelector('[data-component="simulator-address-connecting"]')).toBeNull();
  });
});
