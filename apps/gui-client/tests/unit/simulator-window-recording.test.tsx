// SimulatorWindow — the Recording drawer pane (SLICE 3 of the founder-approved
// drawer redesign, task #50). The pane wires the EXISTING #36 recordings store
// (useRecordings) into a Start/Stop record control with a live elapsed/frames/
// size readout, plus a saved-recordings list with per-row Export / Delete. Own
// file so the recordings-provider state doesn't leak into the base suite.
// Mirrors the AgentSessionPanel→room mock pattern of simulator-window-downloads.

import { useEffect } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

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
// A sized, "publishing" video so toggleRecord's no-video guard passes and captureFrame
// grabs real frames (a recording with frames). The empty-recording test overrides
// videoWidth to 0 to exercise the black/connecting/frozen path.
let fakeVideoWidth = 402;
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: (props: {
    onRoom?: (room: unknown, ownerRoom: unknown) => void;
    onPublisher?: (p: string, room: unknown) => void;
    onVideoEl?: (el: HTMLVideoElement | null) => void;
  }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
      props.onPublisher?.('publishing', fakeRoom);
      const el = document.createElement('video');
      Object.defineProperty(el, 'videoWidth', { get: () => fakeVideoWidth, configurable: true });
      Object.defineProperty(el, 'videoHeight', { value: 874, configurable: true });
      props.onVideoEl?.(el);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  getAgentSession: () => Promise.resolve({ mode: 'manual', pairKind: null }),
  getAgentSessionPageState: () => Promise.resolve(null),
  getAgentSessionCookies: () => Promise.resolve({ status: 'unavailable', cookies: null }),
  uploadAgentSessionFile: () => Promise.resolve({ status: 'unavailable', handle: null }),
  listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
  fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
  setSessionMode: vi.fn(),
  takeoverSession: vi.fn(),
  handbackSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  endAgentSession: vi.fn(),
  AgentSessionControlError: class extends Error {},
}));

const { SimulatorWindow, dataUrlByteSize } = await import('../../src/views/SimulatorWindow');
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
// expands on icon click. Click the Recording rail icon so its pane renders (the
// rail is always visible — no Show-controls chevron anymore; default is collapsed).
function openRecordingPane(c: HTMLElement): HTMLElement {
  const rail = c.querySelector('[data-component="sim-rail-recording"]');
  if (rail) fireEvent.click(rail);
  const pane = c.querySelector('[data-component="drawer-recording"]');
  expect(pane).not.toBeNull();
  return pane as HTMLElement;
}

describe('SimulatorWindow — Recording pane (SLICE 3)', () => {
  // jsdom in this project ships a non-functional localStorage; install a
  // working Map-backed one + default the discoverability/browser-mode flags
  // (mirrors simulator-window.test.tsx).
  const lsStore = new Map<string, string>();
  beforeEach(() => {
    fakeVideoWidth = 402; // default: a live, sized stream
    lsStore.clear();
    // jsdom has no canvas backend; stub the 2d context + toDataURL so captureFrame
    // produces a (non-empty) frame instead of throwing — mirrors a real capture.
    const proto = HTMLCanvasElement.prototype as unknown as {
      getContext: () => unknown;
      toDataURL: () => string;
    };
    proto.getContext = () => ({ drawImage: () => undefined });
    proto.toDataURL = () => 'data:image/jpeg;base64,AAAA';
    vi.stubGlobal('localStorage', {
      getItem: (k: string): string | null => lsStore.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        lsStore.set(k, v);
      },
      removeItem: (k: string): void => {
        lsStore.delete(k);
      },
      clear: (): void => lsStore.clear(),
      key: (): string | null => null,
      length: 0,
    });
    localStorage.setItem('ds-sim-navigated', '1');
    localStorage.setItem('ds-sim-browser-mode', '0');
  });

  it('shows Start recording + the empty saved-recordings state initially', () => {
    const { container } = renderSim();
    const pane = openRecordingPane(container);
    expect(pane.querySelector('[aria-label="Start recording"]')).not.toBeNull();
    expect(pane.querySelector('[aria-label="Stop recording"]')).toBeNull();
    expect(pane.textContent).toContain('No recordings yet.');
  });

  it('Start → live readout + Stop, then Stop adds the recording to the saved list', async () => {
    const { container } = renderSim();
    let pane = openRecordingPane(container);

    // Start the recording from the pane (reuses the same toggleRecord wiring the
    // toolbar ● button uses — single source of truth via useRecordings).
    fireEvent.click(pane.querySelector('[aria-label="Start recording"]') as Element);

    // While recording: the control flips to Stop and the live readout shows the
    // capturing state (frames/size readout). jsdom has no <video> so 0 frames are
    // captured, but the elapsed/frames/size readout still renders.
    await waitFor(() => {
      pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
      expect(pane.querySelector('[aria-label="Stop recording"]')).not.toBeNull();
    });
    expect(pane.querySelector('[aria-label="Start recording"]')).toBeNull();
    expect(pane.textContent).toMatch(/capturing…/);

    // Stop finalizes the recording → it moves into the saved list.
    fireEvent.click(pane.querySelector('[aria-label="Stop recording"]') as Element);
    await waitFor(() => {
      pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
      expect(pane.querySelector('[data-component="sim-recording-row"]')).not.toBeNull();
    });
    expect(pane.querySelector('[aria-label="Start recording"]')).not.toBeNull();
    expect(pane.textContent).not.toContain('No recordings yet.');
    expect(pane.textContent).toContain('Saved recordings');
  });

  it('Export on a saved recording triggers the JSON download (buildRecordingExport → downloadJson)', async () => {
    // downloadJson → downloadBlob calls URL.createObjectURL; jsdom lacks it, so
    // stub it and assert it fired (the proven blob/anchor download path).
    const u = URL as unknown as {
      createObjectURL?: (blob: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    };
    const createObjectURL = vi.fn(() => 'blob:mock');
    u.createObjectURL = createObjectURL;
    u.revokeObjectURL = () => {};
    try {
      const { container } = renderSim();
      let pane = openRecordingPane(container);
      fireEvent.click(pane.querySelector('[aria-label="Start recording"]') as Element);
      await waitFor(() => {
        pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
        expect(pane.querySelector('[aria-label="Stop recording"]')).not.toBeNull();
      });
      fireEvent.click(pane.querySelector('[aria-label="Stop recording"]') as Element);
      const exportBtn = await waitFor(() => {
        pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
        const b = pane.querySelector('button[aria-label^="Export "]');
        expect(b).not.toBeNull();
        return b as HTMLButtonElement;
      });
      fireEvent.click(exportBtn);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      delete u.createObjectURL;
      delete u.revokeObjectURL;
    }
  });

  it('Record while the stream is black/connecting (videoWidth 0) is blocked with an honest notice — no empty recording', async () => {
    fakeVideoWidth = 0; // no video yet (black / connecting / frozen)
    const { container } = renderSim();
    const pane = openRecordingPane(container);
    // The Start control is present, but clicking it must NOT start a recording.
    fireEvent.click(pane.querySelector('[aria-label="Start recording"]') as Element);
    // No transition to Stop (recording never started), and an honest notice surfaces.
    expect(
      container
        .querySelector('[data-component="drawer-recording"]')
        ?.querySelector('[aria-label="Stop recording"]'),
    ).toBeNull();
    await waitFor(() => {
      expect(container.textContent).toMatch(/no video yet/i);
    });
    // No recording was created (still the empty saved-list state).
    expect(container.textContent).toContain('No recordings yet.');
  });

  it('Delete removes the recording → returns to the empty state', async () => {
    const { container } = renderSim();
    let pane = openRecordingPane(container);
    fireEvent.click(pane.querySelector('[aria-label="Start recording"]') as Element);
    await waitFor(() => {
      pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
      expect(pane.querySelector('[aria-label="Stop recording"]')).not.toBeNull();
    });
    fireEvent.click(pane.querySelector('[aria-label="Stop recording"]') as Element);
    const deleteBtn = await waitFor(() => {
      pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
      const b = pane.querySelector('button[aria-label^="Delete "]');
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    // Delete is a two-step confirm (audit 2026-07-08, permanent + dense list): the first
    // click arms (× → "Delete?"), a second click actually deletes.
    fireEvent.click(deleteBtn); // arm
    await waitFor(() => expect(deleteBtn.textContent).toContain('Delete?'));
    fireEvent.click(deleteBtn); // confirm
    await waitFor(() => {
      pane = container.querySelector('[data-component="drawer-recording"]') as HTMLElement;
      expect(pane.textContent).toContain('No recordings yet.');
    });
  });
});

describe('dataUrlByteSize — real encoded bytes (not the dataUrl.length×0.75 approximation)', () => {
  it('returns the true base64 payload size, excluding the data: prefix + padding', () => {
    // "Man" → base64 "TWFu" (no padding) = 3 bytes.
    expect(dataUrlByteSize('data:image/jpeg;base64,TWFu')).toBe(3);
    // "Ma" → "TWE=" (1 pad) = 2 bytes.
    expect(dataUrlByteSize('data:image/jpeg;base64,TWE=')).toBe(2);
    // "M" → "TQ==" (2 pad) = 1 byte.
    expect(dataUrlByteSize('data:image/jpeg;base64,TQ==')).toBe(1);
  });

  it('does NOT count the data: prefix (the old approximation over-counted)', () => {
    const dataUrl = 'data:image/jpeg;base64,TWFu';
    // The honest size is 3; the old `dataUrl.length * 0.75` would be much larger
    // because it counted the 23-char prefix too.
    expect(dataUrlByteSize(dataUrl)).toBe(3);
    expect(dataUrlByteSize(dataUrl)).toBeLessThan(Math.round(dataUrl.length * 0.75));
  });

  it('handles an empty payload and a raw (prefix-less) base64 string', () => {
    expect(dataUrlByteSize('data:image/jpeg;base64,')).toBe(0);
    expect(dataUrlByteSize('TWFu')).toBe(3); // no comma → treat the whole string as base64
  });
});
