// SimulatorWindow — the file-download "Downloads" drawer section (A3 W2856 / founder
// "control files"). Polls the session's download jail, lists the files, and Save
// fetches the bytes. Own file (the AgentSessionPanel→room mock pattern) so it doesn't
// leak into the base suite. Mirrors simulator-window-files.test.tsx.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const listMock = vi.fn();
const fetchMock = vi.fn();

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
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  uploadAgentSessionFile: () => Promise.resolve({ status: 'unavailable', handle: null }),
  listAgentSessionDownloads: (...a: unknown[]) => listMock(...a) as unknown,
  fetchAgentSessionDownload: (...a: unknown[]) => fetchMock(...a) as unknown,
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

// Approach B drawer = an icon RAIL + a single content PANE. Open the drawer if
// collapsed, then select the Downloads rail icon so its pane renders (the default
// active pane is Session).
function openDrawer(c: HTMLElement): void {
  const show = c.querySelector('[aria-label="Show controls"]');
  if (show) fireEvent.click(show);
  const dlRail = c.querySelector('[data-component="sim-rail-downloads"]');
  if (dlRail) fireEvent.click(dlRail);
}

describe('SimulatorWindow — file-download Downloads section (A3 W2856)', () => {
  beforeEach(() => {
    listMock.mockReset();
    fetchMock.mockReset();
  });

  it('lists files the page wrote into the download jail', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
    });
    const { container } = renderSim();
    openDrawer(container);
    await waitFor(() => {
      expect(
        container.querySelector('[data-component="simulator-downloads"]')?.textContent,
      ).toMatch(/report\.pdf/);
    });
  });

  it('clicking Save fetches the file bytes by name', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
    });
    fetchMock.mockResolvedValue({
      status: 'ok',
      file: { name: 'report.pdf', mime: 'application/pdf', dataB64: 'aGVsbG8=' },
    });
    // jsdom lacks URL.createObjectURL/revokeObjectURL — define them for the save path
    // (assign, don't read the originals — reading the unbound method trips eslint).
    const u = URL as unknown as {
      createObjectURL?: (blob: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    };
    u.createObjectURL = () => 'blob:mock';
    u.revokeObjectURL = () => {};
    try {
      const { container } = renderSim();
      openDrawer(container);
      const saveBtn = await waitFor(() => {
        const b = container.querySelector(
          '[data-component="simulator-downloads"] button[aria-label^="Save "]',
        );
        expect(b).not.toBeNull();
        return b as HTMLButtonElement;
      });
      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      expect(fetchMock.mock.calls[0]?.slice(0, 2)).toEqual(['agt_x', 'report.pdf']);
    } finally {
      delete u.createObjectURL;
      delete u.revokeObjectURL;
    }
  });
});
