// The simulator names a device's size limit before a file is picked, and after a
// refusal.
//
// Each device takes a file or a cookie jar up to its own size — on every device
// that advertises nothing, about 2.95 MiB for a file — and the session read
// carries that figure as `upload_max_file_bytes`. So:
//
//   - the upload drop zone says the session's limit BEFORE a file is picked,
//     instead of the old fixed "max 64 MB", 20x too high for those devices;
//   - a picked file over it is refused before it is read or sent;
//   - a 413 from the upload route is shown in the client's own words with the
//     limit it carried, never the server's detail;
//   - a 413 from the cookie import says the jar is too large for the device,
//     instead of "please try again", which could never succeed.
//
// Own file (the AgentSessionPanel → room mock pattern of the other
// simulator-window suites), with the network calls mocked and the REAL error
// class, so the refusal is the one the client really builds.

import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type * as AgentSessionControlModule from '../../src/lib/agent-session-control';

const getSessionMock = vi.fn();
const uploadMock = vi.fn();
const setCookiesMock = vi.fn();

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
  AgentSessionPanel: (props: { onRoom?: (room: unknown, ownerRoom: unknown) => void }) => {
    useEffect(() => {
      props.onRoom?.(fakeRoom, fakeRoom);
    }, [props]);
    return <div data-component="agent-session-panel-mock" />;
  },
}));

vi.mock('../../src/lib/agent-session-control', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionControlModule>();
  return {
    getAgentSession: (...a: unknown[]) => getSessionMock(...a) as unknown,
    getAgentSessionPageState: () => Promise.resolve(null),
    getAgentSessionCookies: () => Promise.resolve({ status: 'ok', cookies: [] }),
    setAgentSessionCookies: (...a: unknown[]) => setCookiesMock(...a) as unknown,
    uploadAgentSessionFile: (...a: unknown[]) => uploadMock(...a) as unknown,
    listAgentSessionDownloads: () => Promise.resolve({ status: 'unavailable', files: null }),
    fetchAgentSessionDownload: () => Promise.resolve({ status: 'unavailable', file: null }),
    setSessionMode: vi.fn(),
    takeoverSession: vi.fn(),
    handbackSession: vi.fn(),
    sendAgentMessage: vi.fn(),
    endAgentSession: vi.fn(),
    AgentSessionControlError: actual.AgentSessionControlError,
  };
});

const { SimulatorWindow } = await import('../../src/views/SimulatorWindow');
const { RecordingsProvider } = await import('../../src/lib/recordings');
const { AgentSessionControlError } = await import('../../src/lib/agent-session-control');

/** What every device that advertises nothing takes in one file. */
const DEFAULT_DEVICE_FILE_LIMIT = 3_093_504;

function renderSim() {
  window.history.pushState({}, '', '/?window=simulator&ws=wss://lk&token=tok&session=agt_lim');
  return render(
    <RecordingsProvider>
      <SimulatorWindow />
    </RecordingsProvider>,
  );
}

function openRail(c: HTMLElement, rail: 'files' | 'cookies'): void {
  const icon = c.querySelector(`[data-component="sim-rail-${rail}"]`);
  if (icon) fireEvent.click(icon);
}

function filesText(c: HTMLElement): string {
  return c.querySelector('[data-component="simulator-files"]')?.textContent ?? '';
}

function fileInput(c: HTMLElement): HTMLInputElement {
  return c.querySelector('[data-component="simulator-files"] input[type=file]') as HTMLInputElement;
}

function sessionRead(uploadMaxFileBytes?: number) {
  return {
    mode: 'manual',
    pairKind: null,
    status: 'active',
    terminal: false,
    ...(uploadMaxFileBytes !== undefined ? { uploadMaxFileBytes } : {}),
  };
}

describe('the simulator names a device size limit before a pick and after a refusal', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    uploadMock.mockReset();
    setCookiesMock.mockReset();
  });

  it('CRITICAL the drop zone names the session’s device limit before a file is picked', async () => {
    getSessionMock.mockResolvedValue(sessionRead(DEFAULT_DEVICE_FILE_LIMIT));
    const { container } = renderSim();
    openRail(container, 'files');
    await waitFor(() => {
      expect(filesText(container)).toContain('max 2.95 MiB');
    });
    expect(filesText(container), 'the fixed 64 MB hint is 20x what this device takes').not.toMatch(
      /max 64 MB/,
    );
  });

  it('CRITICAL with no limit on the session read the drop zone names the 64 MiB maximum', async () => {
    getSessionMock.mockResolvedValue(sessionRead());
    const { container } = renderSim();
    openRail(container, 'files');
    await waitFor(() => {
      expect(getSessionMock).toHaveBeenCalled();
      expect(filesText(container)).toContain('max 64 MiB');
    });
  });

  it('CRITICAL a picked file over the limit is refused before it is sent, in the server’s words', async () => {
    getSessionMock.mockResolvedValue(sessionRead(DEFAULT_DEVICE_FILE_LIMIT));
    const { container } = renderSim();
    openRail(container, 'files');
    await waitFor(() => {
      expect(filesText(container)).toContain('max 2.95 MiB');
    });
    const big = new File([new Uint8Array(DEFAULT_DEVICE_FILE_LIMIT + 1)], 'big.bin');
    fireEvent.change(fileInput(container), { target: { files: [big] } });
    await waitFor(() => {
      expect(filesText(container)).toContain(
        'This file is too large to send to this device (limit 2.95 MiB).',
      );
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('CRITICAL a 413 on upload shows the client’s sentence with the refusal’s limit — never the server’s detail', async () => {
    // No limit on the read (an older server), so the file goes to the server.
    getSessionMock.mockResolvedValue(sessionRead());
    uploadMock.mockRejectedValue(
      new AgentSessionControlError(
        'SERVER-DETAIL-NOT-FOR-THE-CLIENT',
        413,
        'payload-too-large',
        null,
        1_048_576,
      ),
    );
    const { container } = renderSim();
    openRail(container, 'files');
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['hello'], 'a.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => {
      expect(filesText(container)).toContain(
        'This file is too large to send to this device (limit 1 MiB).',
      );
    });
    expect(filesText(container)).not.toContain('SERVER-DETAIL');
  });

  it('CRITICAL a 413 on cookie import says the jar is too large for the device — not "please try again"', async () => {
    getSessionMock.mockResolvedValue(sessionRead());
    setCookiesMock.mockRejectedValue(
      new AgentSessionControlError(
        'SERVER-DETAIL-NOT-FOR-THE-CLIENT',
        413,
        'payload-too-large',
        null,
        4_128_768,
      ),
    );
    const { container } = renderSim();
    openRail(container, 'cookies');
    const input = (await waitFor(() => {
      const i = container.querySelector('[data-component="simulator-cookies-import-input"]');
      if (!i) throw new Error('not yet');
      return i;
    })) as HTMLInputElement;
    const jar = [{ domain: 'example.com', name: 'sid', value: 'abc' }];
    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(jar)], 'cookies.json', { type: 'application/json' })],
      },
    });
    const note = await waitFor(() => {
      const n = container.querySelector('[data-component="simulator-cookies-import-note"]');
      if (!n?.textContent) throw new Error('not yet');
      return n;
    });
    expect(note.textContent).toBe(
      'This cookie jar is too large to send to this device (limit 3.94 MiB).',
    );
  });
});
