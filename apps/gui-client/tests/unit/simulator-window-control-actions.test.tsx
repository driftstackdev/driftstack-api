// SimulatorWindow — in-flight control-action feedback + session-swap safety.
//
// Own focused harness because the standalone Simulator swaps its sessionId in place
// (without remounting) and the real AgentSessionPanel requires a live WebRTC room.

import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sendMessageMock = vi.fn();
const endSessionMock = vi.fn();
const tauriInvoke = vi.fn();

// Capture the relaunch listener so the second test can swap the standalone
// Simulator to a new session without remounting it.
let dsSessionCb: ((event: { payload: string }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (event: { payload: string }) => void) => {
    if (name === 'ds-session') dsSessionCb = cb;
    return Promise.resolve(() => {});
  },
}));

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
    DataReceived: 'dataReceived',
  },
}));

const fakeRoom = {
  on: vi.fn(),
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
  getAgentSession: () => Promise.resolve({ mode: 'ai', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  uploadAgentSessionFile: vi.fn(() => Promise.resolve({ status: 'unavailable', handle: null })),
  listAgentSessionDownloads: vi.fn(() => Promise.resolve({ status: 'unavailable', files: null })),
  fetchAgentSessionDownload: vi.fn(() => Promise.resolve({ status: 'unavailable', file: null })),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: (...args: unknown[]) => sendMessageMock(...args) as unknown,
  endAgentSession: (...args: unknown[]) => endSessionMock(...args) as unknown,
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');

function renderSimulator() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_x');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function openSessionControls(container: HTMLElement): void {
  fireEvent.click(container.querySelector('[data-component="sim-rail-session"]') as Element);
}

describe('SimulatorWindow — control actions', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    endSessionMock.mockReset();
    dsSessionCb = null;
    tauriInvoke.mockReset();
    tauriInvoke.mockImplementation((command: string) => {
      if (command === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (command === 'plugin:window|inner_size') {
        return Promise.resolve({ width: 430, height: 820 });
      }
      return Promise.resolve();
    });
    // The in-place relaunch listener registers only in the Tauri environment.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'simulator' },
        currentWebview: { label: 'simulator' },
      },
      invoke: tauriInvoke,
    };
  });
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('clears a sent draft immediately, shows Sending, and restores the exact draft on rejection', async () => {
    const send = deferred<void>();
    sendMessageMock.mockReturnValue(send.promise);
    const { container } = renderSimulator();
    openSessionControls(container);

    const input = await waitFor(() => {
      const el = container.querySelector('[aria-label="Tell the agent"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    const originalDraft = '  keep my exact wording  ';
    fireEvent.change(input, { target: { value: originalDraft } });
    fireEvent.click(container.querySelector('[aria-label="Send to agent"]') as Element);

    expect(sendMessageMock).toHaveBeenCalledWith('agt_x', originalDraft.trim(), null);
    expect(input.value).toBe('');
    expect(container.textContent).toMatch(/Sending(?: to agent)?…/i);

    await act(async () => {
      send.reject(new Error('temporary control failure'));
      await send.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(
        (container.querySelector('[aria-label="Tell the agent"]') as HTMLInputElement).value,
      ).toBe(originalDraft);
    });
  });

  it('disarms a first-click End confirmation when ds-session swaps in a new session', async () => {
    const { container } = renderSimulator();

    const endButton = container.querySelector('[aria-label="End session"]') as HTMLButtonElement;
    expect(endButton).not.toBeNull();
    fireEvent.click(endButton);
    expect(container.querySelector('[aria-label="Confirm — end session"]')).not.toBeNull();
    expect(endSessionMock).not.toHaveBeenCalled();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Confirm — end session"]')).toBeNull();
      expect(container.textContent).not.toMatch(/click End again/i);
    });
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it('does not destroy the newly bound window when an old End request settles after a swap', async () => {
    const end = deferred<void>();
    endSessionMock.mockReturnValue(end.promise);
    const { container } = renderSimulator();

    fireEvent.click(container.querySelector('[aria-label="End session"]') as Element);
    fireEvent.click(container.querySelector('[aria-label="Confirm — end session"]') as Element);
    expect(endSessionMock).toHaveBeenCalledWith('agt_x', null);
    expect(container.querySelector('[aria-label="Ending session"]')).not.toBeNull();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull(),
    );

    await act(async () => {
      end.resolve();
      await end.promise;
    });

    expect(tauriInvoke.mock.calls.some(([command]) => command === 'plugin:window|destroy')).toBe(
      false,
    );
  });

  it('cancels the failed-End close fallback when a new session arrives during its grace period', async () => {
    endSessionMock.mockRejectedValue(new Error('control API unavailable'));
    const { container } = renderSimulator();

    fireEvent.click(container.querySelector('[aria-label="End session"]') as Element);
    fireEvent.click(container.querySelector('[aria-label="Confirm — end session"]') as Element);
    expect(
      await screen.findByText('Ending — closing the window (the session will stop on the box).'),
    ).not.toBeNull();

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="End session"]')).not.toBeNull(),
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
    });
    expect(tauriInvoke.mock.calls.some(([command]) => command === 'plugin:window|destroy')).toBe(
      false,
    );
  });

  it('drops an old-session completion without unlocking or rewriting the new session action', async () => {
    const oldSend = deferred<void>();
    const newSend = deferred<void>();
    sendMessageMock.mockReturnValueOnce(oldSend.promise).mockReturnValueOnce(newSend.promise);
    const { container } = renderSimulator();
    openSessionControls(container);

    const input = await waitFor(() => {
      const el = container.querySelector('[aria-label="Tell the agent"]');
      expect(el?.disabled).toBe(false);
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: 'old session draft' } });
    fireEvent.click(container.querySelector('[aria-label="Send to agent"]') as Element);

    await waitFor(() => expect(dsSessionCb).not.toBeNull());
    act(() => {
      dsSessionCb?.({
        payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y'),
      });
    });

    const newInput = await waitFor(() => {
      const el = container.querySelector('[aria-label="Tell the agent"]');
      expect(el?.disabled).toBe(false);
      return el as HTMLInputElement;
    });
    fireEvent.change(newInput, { target: { value: 'new session draft' } });
    fireEvent.click(container.querySelector('[aria-label="Send to agent"]') as Element);
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, 'agt_y', 'new session draft', null);

    await act(async () => {
      oldSend.reject(new Error('old session failed late'));
      await oldSend.promise.catch(() => undefined);
    });

    // The old catch/finally must neither restore its draft nor clear the NEW
    // request's busy state. Only the new request may settle this composer.
    expect(container.querySelector('form[aria-busy="true"]')).not.toBeNull();
    expect(newInput.value).toBe('');
    expect(container.textContent).not.toContain('old session draft');

    await act(async () => {
      newSend.reject(new Error('new session failed'));
      await newSend.promise.catch(() => undefined);
    });
    await waitFor(() => expect(newInput.value).toBe('new session draft'));
  });
});
