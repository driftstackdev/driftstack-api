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
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';

const sendNavigate = vi.fn(() => Promise.resolve());
let terminalSession = false;
const getAgentSession = vi.fn(() =>
  Promise.resolve({
    mode: 'manual' as const,
    pairKind: null,
    terminal: terminalSession,
    closedReason: terminalSession ? 'browser-closed' : null,
  }),
);
vi.mock('../../src/lib/livekit', () => ({
  createLivekitRoom: () => ({ on: vi.fn(), disconnect: vi.fn() }),
  connectToAgentSession: () => new Promise(() => {}),
  sendInputEvent: vi.fn(() => Promise.resolve()),
  sendNavigate,
  // Browser-style page tabs (doc-150 item 4) — onNavigate now also updates the active
  // tab + publishes the list, and the seed tab publishes on mount, so the mock must
  // export these or the calls throw.
  sendTabListUpdate: vi.fn(() => Promise.resolve()),
  sendActivateTab: vi.fn(() => Promise.resolve('req_test')),
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    DataReceived: 'dataReceived',
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
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onStateChange?: (s: { kind: string }, room: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
  }) => {
    // Fire onRoom + a fully-live connection state in an effect (not during render) to
    // avoid a setState-in-render warning — mirrors the real panel surfacing a connected
    // room with a publishing video track. canNavigate now gates on connected+publishing.
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onStateChange?.({ kind: 'connected' }, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

// The control transport — mode 'manual' so the panel renders the full chrome.
vi.mock('../../src/lib/agent-session-control', () => ({
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  getAgentSession,
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
const { normalizeNavigateUrl, resolveAddressBarInput } = await import('../../src/lib/address-bar');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

// Reveal an address bar. In this suite jsdom's localStorage throws, so browser
// mode defaults ON → the BrowserBar's address field (always visible) is the one
// under test, and the Controls-pane field never renders. The activity-bar rail is
// always docked (no Show-controls chevron anymore); clicking the Controls rail icon
// expands its pane harmlessly. Tolerate the icon being absent so the test stays
// state-independent — the BrowserBar address bar is present either way.
function openControlPanel(container: HTMLElement): void {
  const rail = container.querySelector('[data-component="sim-rail-controls"]');
  if (rail) fireEvent.click(rail);
}

function fireDataFrame(frame: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(frame));
  fakeRoom.on.mock.calls
    .filter((call) => call[0] === 'dataReceived')
    .forEach((call) => {
      (call[1] as (data: Uint8Array) => void)(payload);
    });
}

describe('SimulatorWindow — address bar navigate', () => {
  beforeEach(() => {
    sendNavigate.mockClear();
    getAgentSession.mockClear();
    terminalSession = false;
    fakeRoom.on.mockClear();
    fakeRoom.off.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('expanding the panel reveals an address bar; submitting a URL publishes {type:navigate} via the data channel', () => {
    const { container } = renderSim();
    // Open the control panel (the address bar lives in the expandable area).
    openControlPanel(container);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    expect(addressInput).not.toBeNull();
    // Type a scheme-less host + submit the form.
    fireEvent.change(addressInput, { target: { value: 'example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    // The scheme is prepended (https://) and the navigate rides the data channel.
    expect(sendNavigate).toHaveBeenCalledTimes(1);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://example.com/');
  });

  it('typing a non-URL search query publishes a navigate to a web search (omnibox)', () => {
    const { container } = renderSim();
    openControlPanel(container);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'driftstack pricing' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).toHaveBeenCalledWith(
      fakeRoom,
      'https://www.google.com/search?q=driftstack%20pricing',
    );
  });

  it('passes an explicit https URL through unchanged', () => {
    const { container } = renderSim();
    openControlPanel(container);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'https://news.example.org/page' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://news.example.org/page');
  });

  it('does NOT emit a navigate for an explicit non-http(s) scheme (the harness re-validates too)', () => {
    const { container } = renderSim();
    openControlPanel(container);
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    // file:// scheme — dropped client-side (defense in depth). A bare-colon
    // pseudo-scheme without // would instead be searched as harmless text; an
    // explicit non-http(s) scheme like this must never navigate.
    fireEvent.change(addressInput, { target: { value: 'file:///etc/passwd' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).not.toHaveBeenCalled();
  });

  it('Reload re-loads the LIVE page, NOT a half-typed draft (audit P2 fix)', () => {
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    // Establish a live URL by navigating once (sets liveUrl optimistically).
    fireEvent.change(addressInput, { target: { value: 'live.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    expect(sendNavigate).toHaveBeenLastCalledWith(fakeRoom, 'https://live.example.com/');
    sendNavigate.mockClear();
    // Operator starts typing a DIFFERENT address but never submits it.
    fireEvent.change(addressInput, {
      target: { value: 'typed-but-not-submitted.example.org' },
    });
    // Clicking Reload must reload the live page, not silently navigate to the draft.
    fireEvent.click(container.querySelector('[aria-label="Reload"]') as Element);
    expect(sendNavigate).toHaveBeenCalledTimes(1);
    expect(sendNavigate).toHaveBeenCalledWith(fakeRoom, 'https://live.example.com/');
  });

  it('shows a determinate, seeded loading bar when a navigate is in flight (realistic progress, not a 0→100 jump)', () => {
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    const bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    const width = parseFloat(bar.style.width);
    expect(width).toBeGreaterThan(0); // seeded to a visible base, not 0
    expect(width).toBeLessThan(100); // climbs toward ~90%, never a 0→100 jump
  });

  it('keeps a slow load active past 6s, then replaces it with Retry at the non-sliding 45s deadline', () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'slow.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);

    act(() => {
      vi.advanceTimersByTime(6_001);
    });
    let bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.opacity).toBe('1');

    // A same-target loading frame at 40s must not slide the original deadline.
    act(() => {
      vi.advanceTimersByTime(33_999);
      fireDataFrame({
        type: 'page_state',
        state: 'loading',
        url: 'https://slow.example.com/',
        progress: 0,
      });
      vi.advanceTimersByTime(4_999);
    });
    expect(container.querySelector('[data-component="page-load-stalled-banner"]')).toBeNull();
    expect(container.querySelector('[data-component="simulator-loadbar"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      container.querySelector('[data-component="page-load-stalled-banner"]'),
    ).toHaveTextContent(/taking longer than usual/i);
    bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(bar.style.opacity).toBe('0');

    // A stale same-target loading frame after expiry cannot erase the fallback
    // advisory or relight the progress bar.
    act(() => {
      fireDataFrame({
        type: 'page_state',
        state: 'loading',
        url: 'https://slow.example.com/',
        progress: 0.8,
      });
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-component="page-load-stalled-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-component="simulator-loadbar"]')).toBeNull();
  });

  it('gives a changed box target its own load deadline', () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'first.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    act(() => {
      fireDataFrame({
        type: 'page_state',
        state: 'loading',
        url: 'https://redirected.example.com/',
        progress: 0,
      });
    });
    expect(addressInput.value).toContain('redirected.example.com');
    act(() => {
      // Cross the first target's old 45s deadline.
      vi.advanceTimersByTime(5_001);
    });

    expect(container.querySelector('[data-component="page-load-stalled-banner"]')).toBeNull();
    const bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.opacity).toBe('1');
  });

  it('cancels the load deadline when the session terminally ends', async () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'still-loading.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);

    terminalSession = true;
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(45_300);
    });

    expect(container.querySelector('[data-component="page-load-stalled-banner"]')).toBeNull();
    expect(container.querySelector('[data-component="simulator-loadbar"]')).toBeNull();
  });

  it('resets a completed bar when a new navigation starts during the 300ms fade', () => {
    vi.useFakeTimers();
    const { container } = renderSim();
    const addressInput = container.querySelector('[aria-label="Address bar"]') as HTMLInputElement;
    fireEvent.change(addressInput, { target: { value: 'first.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    act(() => {
      fireDataFrame({
        type: 'page_state',
        state: 'loaded',
        url: 'https://first.example.com/',
        progress: 1,
      });
      vi.advanceTimersByTime(150);
    });

    fireEvent.change(addressInput, { target: { value: 'second.example.com' } });
    fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
    let bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(parseFloat(bar.style.width)).toBeGreaterThan(0);
    expect(parseFloat(bar.style.width)).toBeLessThan(100);
    expect(bar.style.opacity).toBe('1');

    // A mid-load external progress sample cannot jump the trickle to 80%.
    act(() => {
      fireDataFrame({
        type: 'page_state',
        state: 'loading',
        url: 'https://second.example.com/',
        progress: 0.8,
      });
      vi.advanceTimersByTime(150);
    });
    bar = container.querySelector('[data-component="simulator-loadbar"]') as HTMLElement;
    expect(parseFloat(bar.style.width)).toBeLessThan(80);
    expect(bar.style.opacity).toBe('1');
  });

  it('Copy URL writes the live address to the clipboard', () => {
    const writeText = vi.fn(() => Promise.resolve());
    const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const { container } = renderSim();
      const addressInput = container.querySelector(
        '[aria-label="Address bar"]',
      ) as HTMLInputElement;
      // Establish a live URL, then copy it.
      fireEvent.change(addressInput, { target: { value: 'live.example.com' } });
      fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
      fireEvent.click(container.querySelector('[aria-label="Copy URL"]') as Element);
      expect(writeText).toHaveBeenCalledWith('https://live.example.com/');
    } finally {
      if (orig) Object.defineProperty(navigator, 'clipboard', orig);
      else delete (navigator as Partial<Navigator>).clipboard;
    }
  });

  it.each([
    ['the clipboard API is unavailable', false],
    ['the clipboard API throws synchronously', true],
  ])('Copy URL reports failure and remains retryable when %s', async (_scenario, throws) => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const unavailableOrThrowing = throws
      ? {
          writeText: vi.fn(() => {
            throw new Error('clipboard denied');
          }),
        }
      : undefined;
    Object.defineProperty(navigator, 'clipboard', {
      value: unavailableOrThrowing,
      configurable: true,
    });
    try {
      const { container } = renderSim();
      const addressInput = container.querySelector(
        '[aria-label="Address bar"]',
      ) as HTMLInputElement;
      fireEvent.change(addressInput, { target: { value: 'retry.example.com' } });
      fireEvent.submit(addressInput.closest('form') as HTMLFormElement);
      fireEvent.click(container.querySelector('[aria-label="Copy URL"]') as Element);

      await waitFor(() => {
        expect(container.querySelector('[aria-label="Couldn\'t copy"]')).not.toBeNull();
      });

      const recoveredWrite = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: recoveredWrite },
        configurable: true,
      });
      fireEvent.click(container.querySelector('[aria-label="Couldn\'t copy"]') as Element);

      await waitFor(() =>
        expect(recoveredWrite).toHaveBeenCalledWith('https://retry.example.com/'),
      );
      await waitFor(() => {
        expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull();
      });
    } finally {
      if (orig) Object.defineProperty(navigator, 'clipboard', orig);
      else delete (navigator as Partial<Navigator>).clipboard;
    }
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

describe('resolveAddressBarInput (omnibox: URL vs search)', () => {
  it('navigates a thing that looks like a URL', () => {
    expect(resolveAddressBarInput('example.com')).toBe('https://example.com/');
    expect(resolveAddressBarInput('shop.example.com/x?y=1')).toBe('https://shop.example.com/x?y=1');
    expect(resolveAddressBarInput('https://news.example.org/p')).toBe('https://news.example.org/p');
    expect(resolveAddressBarInput('localhost:3000/health')).toBe('https://localhost:3000/health');
    expect(resolveAddressBarInput('192.168.1.1')).toBe('https://192.168.1.1/');
  });

  it('navigates internationalized domains with non-ASCII TLDs, trailing-dot FQDNs, and bare IPv6 (audit fixes)', () => {
    // IDN with a non-Latin ccTLD — punycoded by normalize, NOT searched.
    expect(resolveAddressBarInput('файл.рф')).toBe('https://xn--80asg7a.xn--p1ai/');
    // Trailing-dot absolute FQDN.
    expect(resolveAddressBarInput('example.com.')).toBe('https://example.com./');
    // Bare bracketed IPv6 literal (+ port).
    expect(resolveAddressBarInput('[::1]:8080')).toBe('https://[::1]:8080/');
    expect(resolveAddressBarInput('[2606:4700::1]')).toBe('https://[2606:4700::1]/');
  });

  it('searches anything that does NOT look like a URL (multi-word or single bare word)', () => {
    expect(resolveAddressBarInput('best coffee near me')).toBe(
      'https://www.google.com/search?q=best%20coffee%20near%20me',
    );
    expect(resolveAddressBarInput('weather')).toBe('https://www.google.com/search?q=weather');
    // A query that happens to contain URL-ish punctuation but has spaces → search.
    expect(resolveAddressBarInput('C++ vs Rust')).toBe(
      'https://www.google.com/search?q=C%2B%2B%20vs%20Rust',
    );
  });

  it('drops an explicit non-http(s) scheme that carries // (never navigates to it)', () => {
    expect(resolveAddressBarInput('file:///etc/passwd')).toBeNull();
    expect(resolveAddressBarInput('ftp://host/x')).toBeNull();
    expect(resolveAddressBarInput('')).toBeNull();
    expect(resolveAddressBarInput('   ')).toBeNull();
  });

  it('a bare-colon pseudo-scheme (no //) is searched as literal text — so the box only ever receives an https URL, never an executable scheme', () => {
    // javascript:/data: without // are not URL schemes here; they get searched as
    // plain text. The resulting nav is a safe https google-search URL — the
    // box never sees an executable scheme. (The // forms above are dropped.)
    expect(resolveAddressBarInput('javascript:alert(1)')).toBe(
      `https://www.google.com/search?q=${encodeURIComponent('javascript:alert(1)')}`,
    );
    expect(resolveAddressBarInput('data:text/html,x')).toBe(
      `https://www.google.com/search?q=${encodeURIComponent('data:text/html,x')}`,
    );
  });
});
