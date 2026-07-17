// SimulatorWindow — the file-upload "Files" drawer section (A3 W2851 / founder
// "control files"). Selecting a file uploads its bytes and lists the returned
// OPAQUE handle; an 'unavailable' result shows the calm pending note. Own file
// (the AgentSessionPanel→room mock pattern) so it doesn't leak into the base suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

const uploadMock = vi.fn();

// Capture the 'ds-session' relaunch listener so a test can drive an in-place session
// swap (the standalone window changes sessionId WITHOUT a remount).
let dsSessionCb: ((e: { payload: string }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: string }) => void) => {
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

// Surface a fake connected Room so the drawer renders in the running state.
const fakeRoom = {
  on: vi.fn(),
  off: vi.fn(),
  localParticipant: { publishData: vi.fn(() => Promise.resolve()) },
};
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  uploadAgentSessionFile: (...a: unknown[]) => uploadMock(...a) as unknown,
  listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
  fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
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

// The Files section lives in the activity-bar drawer (an always-docked icon RAIL
// + a single content PANE that expands on icon click). Click the Files rail icon
// so its pane renders (the rail is always visible — no Show-controls chevron
// anymore; default is collapsed).
function openDrawer(c: HTMLElement): void {
  const filesRail = c.querySelector('[data-component="sim-rail-files"]');
  if (filesRail) fireEvent.click(filesRail);
}

function fileInput(c: HTMLElement): HTMLInputElement {
  return c.querySelector('[data-component="simulator-files"] input[type=file]') as HTMLInputElement;
}

describe('SimulatorWindow — file-upload Files section (A3 W2851)', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    dsSessionCb = null;
    // The ds-session relaunch listener only registers in a Tauri window. Mark the env
    // so the listener mounts and captures the callback for the swap test.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  it('uploading a file lists the returned opaque handle in the Files section', async () => {
    uploadMock.mockResolvedValue({
      status: 'ok',
      handle: { id: 'f1', name: 'a.txt', mime: 'text/plain', size: 1024 },
    });
    const { container } = renderSim();
    openDrawer(container);
    const input = fileInput(container);
    expect(input).not.toBeNull();
    fireEvent.change(input, {
      target: { files: [new File(['hello'], 'a.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-component="simulator-files"]')?.textContent).toMatch(
        /a\.txt/,
      );
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('clears the uploaded-handle list on an in-place session swap (the handles are bound to the OLD session jail)', async () => {
    uploadMock.mockResolvedValue({
      status: 'ok',
      handle: { id: 'f1', name: 'old-session.txt', mime: 'text/plain', size: 1024 },
    });
    const { container } = renderSim();
    openDrawer(container);
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['hi'], 'old-session.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-component="simulator-files"]')?.textContent).toMatch(
        /old-session\.txt/,
      );
    });
    // The 'ds-session' relaunch swaps the live session in place (new sessionId, no
    // remount). The prior session's handles are invalid for the new jail → the list clears.
    expect(dsSessionCb).not.toBeNull();
    act(() => {
      dsSessionCb?.({ payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y') });
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-component="simulator-files"]')?.textContent,
      ).not.toMatch(/old-session\.txt/);
    });
  });

  it('never uploads a file selected before a session swap when FileReader finishes afterward', async () => {
    const NativeFileReader = FileReader;
    let pendingReader: {
      result: string | null;
      onload: (() => void) | null;
      onerror: (() => void) | null;
    } | null = null;
    class DelayedFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        // Test seam: expose the exact instance SimulatorWindow owns so this test can
        // release its delayed onload after the in-place relaunch.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        pendingReader = this;
      }
      readAsDataURL(): void {
        // Deliberately held until after the ds-session swap below.
      }
    }
    vi.stubGlobal('FileReader', DelayedFileReader);
    try {
      const { container } = renderSim();
      openDrawer(container);
      fireEvent.change(fileInput(container), {
        target: { files: [new File(['private'], 'old-session.txt', { type: 'text/plain' })] },
      });
      expect(pendingReader).not.toBeNull();
      await waitFor(() => expect(dsSessionCb).not.toBeNull());

      act(() => {
        dsSessionCb?.({ payload: btoa('?window=simulator&ws=wss://lk&token=tok&session=agt_y') });
      });
      pendingReader!.result = 'data:text/plain;base64,cHJpdmF0ZQ==';
      act(() => pendingReader!.onload?.());

      expect(uploadMock).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('FileReader', NativeFileReader);
    }
  });

  it("an 'unavailable' upload result shows the honest 'not live on a device' note (not an error)", async () => {
    uploadMock.mockResolvedValue({ status: 'unavailable', handle: null });
    const { container } = renderSim();
    openDrawer(container);
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['x'], 'b.bin', { type: '' })] },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-component="simulator-files"]')?.textContent).toMatch(
        /can't upload/i,
      );
    });
  });
});
