// SimulatorWindow — the file-download "Downloads" drawer section (A3 W2856 / founder
// "control files"). Polls the session's download jail, lists the files, and Save
// fetches the bytes. Own file (the AgentSessionPanel→room mock pattern) so it doesn't
// leak into the base suite. Mirrors simulator-window-files.test.tsx.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';

const listMock = vi.fn();
const fetchMock = vi.fn();
const downloadResponseMock = vi.fn();

vi.mock('../../src/lib/download', () => ({
  downloadBlob: vi.fn(() => Promise.resolve(true)),
  downloadJson: vi.fn(() => Promise.resolve(true)),
  downloadResponse: (...a: unknown[]) => downloadResponseMock(...a) as unknown,
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

// Activity-bar drawer = an always-docked icon RAIL + a single content PANE that
// expands on icon click. Click the Downloads rail icon so its pane renders (the
// rail is always visible — no Show-controls chevron anymore; default is collapsed).
function openDrawer(c: HTMLElement): void {
  const dlRail = c.querySelector('[data-component="sim-rail-downloads"]');
  if (dlRail) fireEvent.click(dlRail);
}

describe('SimulatorWindow — file-download Downloads section (A3 W2856)', () => {
  beforeEach(() => {
    listMock.mockReset();
    fetchMock.mockReset();
    downloadResponseMock.mockReset();
    downloadResponseMock.mockResolvedValue(true);
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

  it('labels a long poll as refreshing while retaining the last good download list', async () => {
    let resolveRefresh:
      | ((value: { status: 'ok'; files: Array<Record<string, unknown>> }) => void)
      | undefined;
    listMock
      .mockResolvedValueOnce({
        status: 'ok',
        files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const { container, unmount } = renderSim();
    openDrawer(container);

    try {
      const liveBadge = await waitFor(() => {
        const badge = container.querySelector('[data-component="simulator-downloads-live"]');
        expect(badge?.textContent).toContain('live');
        return badge as HTMLElement;
      });
      expect(liveBadge.getAttribute('data-refreshing')).toBe('false');

      const scheduledPoll = [...timerSpy.mock.calls]
        .reverse()
        .find((call) => call[1] === 3000 && typeof call[0] === 'function');
      expect(scheduledPoll).toBeDefined();
      act(() => {
        (scheduledPoll?.[0] as () => void)();
      });

      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
      expect(liveBadge.textContent).toContain('refreshing');
      expect(liveBadge.getAttribute('data-refreshing')).toBe('true');
      expect(container.textContent).toContain('report.pdf');

      await act(async () => {
        resolveRefresh?.({ status: 'ok', files: [] });
        await Promise.resolve();
      });
      await waitFor(() => expect(liveBadge.textContent).toContain('live'));
      expect(liveBadge.getAttribute('data-refreshing')).toBe('false');
    } finally {
      unmount();
      timerSpy.mockRestore();
    }
  });

  // Browser-bar download indicator (GUI chrome — like the address bar; never touches
  // the rendered iPhone/fingerprint). Reuses the SAME `downloads` state the Downloads
  // pane polls; browser mode is on by default so the indicator shows without opening
  // the drawer.
  it('shows a count badge in the browser bar when the session has downloads', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [
        { name: 'report.pdf', size: 2048, mime: 'application/pdf' },
        { name: 'photo.jpg', size: 4096, mime: 'image/jpeg' },
      ],
    });
    const { container } = renderSim();
    const indicator = await waitFor(() => {
      const b = container.querySelector('[data-component="simulator-download-indicator"]');
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    expect(indicator.getAttribute('aria-label')).toBe('Downloads (2)');
    expect(
      container.querySelector('[data-component="simulator-download-count"]')?.textContent,
    ).toBe('2');
  });

  it('clicking the browser-bar indicator opens the Downloads pane', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
    });
    const { container } = renderSim();
    const indicator = await waitFor(() => {
      const b = container.querySelector('[data-component="simulator-download-indicator"]');
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    // The Downloads pane is not rendered until the indicator is clicked.
    expect(container.querySelector('[data-component="simulator-downloads"]')).toBeNull();
    fireEvent.click(indicator);
    await waitFor(() => {
      expect(container.querySelector('[data-component="simulator-downloads"]')).not.toBeNull();
    });
  });

  it('hides the browser-bar indicator when there are no downloads', async () => {
    listMock.mockResolvedValue({ status: 'ok', files: [] });
    const { container } = renderSim();
    // Let the poll resolve, then confirm the indicator never renders for an empty jar.
    await waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-component="simulator-download-indicator"]')).toBeNull();
  });

  // #73 — the OLD copy promised "downloads ship with the next device update", a
  // misleading future-feature claim (the download path is actually LIVE; the jail is
  // just empty until a page saves a file). The honest copy must NEVER promise a
  // device update — for an 'unavailable' fetch result OR a failed list poll.
  it('an unavailable download fetch shows honest copy, never a "device update" promise', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
    });
    fetchMock.mockResolvedValue({
      status: 'unavailable',
      file: null,
      reason: 'session is not live on a node',
    });
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
      const txt =
        container.querySelector('[data-component="simulator-downloads"]')?.textContent ?? '';
      expect(txt).not.toMatch(/device update/i);
      expect(txt).toMatch(/session is not live on a node/i);
    });
  });

  it('a failed downloads list poll shows an honest "retrying" note, never a "device update" promise', async () => {
    class CtrlErr extends Error {
      status: number;
      constructor(status: number) {
        super('boom');
        this.status = status;
      }
    }
    // 503 (gated) → the catch-path; must read as a transient reachability gap, not a
    // missing future feature. (401/403 has its own reopen note, covered by the impl.)
    listMock.mockRejectedValue(new CtrlErr(503));
    const { container } = renderSim();
    openDrawer(container);
    await waitFor(() => {
      const txt =
        container.querySelector('[data-component="simulator-downloads"]')?.textContent ?? '';
      expect(txt).toMatch(/retrying/i);
      expect(txt).not.toMatch(/device update/i);
    });
  });

  it('clicking Save streams the raw response without base64/atob decoding', async () => {
    listMock.mockResolvedValue({
      status: 'ok',
      files: [{ name: 'report.pdf', size: 2048, mime: 'application/pdf' }],
    });
    const response = new Response(new Uint8Array([1, 2, 3]));
    fetchMock.mockResolvedValue({
      status: 'ok',
      file: { name: 'report.pdf', response },
    });
    const atobSpy = vi.spyOn(globalThis, 'atob').mockImplementation(() => {
      throw new Error('base64 decoder must not run');
    });
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
      await waitFor(() => {
        expect(downloadResponseMock).toHaveBeenCalledWith('report.pdf', response);
      });
      expect(atobSpy).not.toHaveBeenCalled();
    } finally {
      atobSpy.mockRestore();
    }
  });
});
