// SimulatorWindow — the file-upload "Files" drawer section (A3 W2851 / founder
// "control files"). Selecting a file uploads its bytes and lists the returned
// OPAQUE handle; an 'unavailable' result shows the calm pending note. Own file
// (the AgentSessionPanel→room mock pattern) so it doesn't leak into the base suite.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const uploadMock = vi.fn();

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
  AgentSessionPanel: (props: { onRoom?: (room: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom);
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

// The Files section lives in the expandable drawer; open it if collapsed (mirrors
// the navigate test). No-op when it already defaults expanded.
function openDrawer(c: HTMLElement): void {
  const show = c.querySelector('[aria-label="Show controls"]');
  if (show) fireEvent.click(show);
}

function fileInput(c: HTMLElement): HTMLInputElement {
  return c.querySelector('[data-component="simulator-files"] input[type=file]') as HTMLInputElement;
}

describe('SimulatorWindow — file-upload Files section (A3 W2851)', () => {
  beforeEach(() => {
    uploadMock.mockReset();
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

  it("an 'unavailable' upload result shows the calm pending note (not an error)", async () => {
    uploadMock.mockResolvedValue({ status: 'unavailable', handle: null });
    const { container } = renderSim();
    openDrawer(container);
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['x'], 'b.bin', { type: '' })] },
    });
    await waitFor(() => {
      expect(container.querySelector('[data-component="simulator-files"]')?.textContent).toMatch(
        /pending/i,
      );
    });
  });
});
