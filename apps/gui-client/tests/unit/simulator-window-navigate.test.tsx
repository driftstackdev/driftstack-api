// SimulatorWindow — address bar → data-channel navigate (founder 2026-06-19
// "can't press the URL bar"; A3 W2668). The fork's rendered iOS-Safari URL bar
// is browser CHROME, un-tappable via the WebDriver page-touch path, so the GUI
// provides its own address control that emits {type:'navigate',url} on the SAME
// LiveKit data channel as taps (no server route — it would 401 for the
// keychain-less Simulator app).
//
// Kept in its own file so the AgentSessionPanel mock (which fires onRoom so the
// address bar is connected/enabled) doesn't leak into the base simulator suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(),
  sendNavigate,
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
  },
}));

// Mock AgentSessionPanel to immediately surface a (fake) connected Room upward so
// the simulator's `room` state is non-null → the address bar is enabled. The real
// panel only fires onRoom after a live WebRTC connect, which jsdom can't do. The
// room needs `on`/`off` (the latency-ping hook subscribes to DataReceived) +
// `localParticipant.publishData` (the ping send) so its effect doesn't throw.
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown) => void }) => {
    // Fire onRoom in an effect (not during render) to avoid a setState-in-render
    // warning — mirrors the real panel surfacing the room post-connect.
    useEffect(() => {
      props.onRoom?.(fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// The control transport — mode 'manual' so the panel renders the full chrome.
vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow, normalizeNavigateUrl } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

describe('SimulatorWindow — address bar navigate', () => {
  beforeEach(() => {
    sendNavigate.mockClear();
  });

  it('expanding the panel reveals an address bar; submitting a URL publishes {type:navigate} via the data channel', () => {
    const { container } = renderSim();
    // Open the control panel (the address bar lives in the expandable area).
    fireEvent.click(container.querySelector('[aria-label="Show controls"]') as Element);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput).not.toBeNull();
    // Type a scheme-less host + submit the form.
    fireEvent.change(addressInput, { target: { value: 'example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    // The scheme is prepended (https://) and the navigate rides the data channel.
    expect(sendNavigate).toHaveBeenCalledTimes(1);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://example.com/');
  });

  it('passes an explicit https URL through unchanged', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="Show controls"]') as Element);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'https://news.example.org/page' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://news.example.org/page');
  });

  it('does NOT emit a navigate for an empty or non-http(s) entry (the harness re-validates too)', () => {
    const { container } = renderSim();
    fireEvent.click(container.querySelector('[aria-label="Show controls"]') as Element);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    // javascript: scheme — must be dropped client-side (defense in depth).
    fireEvent.change(addressInput, { target: { value: 'javascript:alert(1)' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).not.toHaveBeenCalled();
  });
});

describe('normalizeNavigateUrl', () => {
  it('prepends https:// when there is no scheme', () => {
    expect(normalizeNavigateUrl('example.com')).toBe('https://example.com/');
    expect(normalizeNavigateUrl('  shop.example.com/x  ')).toBe('https://shop.example.com/x');
  });

  it('keeps an explicit http/https scheme', () => {
    expect(normalizeNavigateUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeNavigateUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
  });

  it('rejects empty / whitespace / non-http(s) schemes', () => {
    expect(normalizeNavigateUrl('')).toBeNull();
    expect(normalizeNavigateUrl('   ')).toBeNull();
    expect(normalizeNavigateUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeNavigateUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeNavigateUrl('data:text/html,x')).toBeNull();
    expect(normalizeNavigateUrl('about:blank')).toBeNull();
  });
});
