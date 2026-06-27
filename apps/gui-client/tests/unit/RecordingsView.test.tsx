// GUI polish wave — copy-session-id affordance on RecordingsView's detail
// rail. lib/recordings is mocked at module level (matching the
// empty-states.test.tsx pattern); the real ToastProvider wraps the view so
// the "Copied" success toast renders.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Recording } from '../../src/lib/recordings';

const recording: Recording = {
  id: 'rec_1',
  sessionId: 'ses_copy_me',
  label: null,
  startedAt: 1_000,
  endedAt: 11_000,
  frames: [{ at: 1_000, dataUrl: 'data:image/png;base64,AAAA', bytes: 4 }],
  totalCaptured: 1,
  hydrated: false,
  frameCount: 1,
  totalBytes: 4,
};

const deleteRecording = vi.fn(() => Promise.resolve(true));
// Configurable per-test so we can render a still-LIVE (endedAt:null) recording.
let mockRecordings = new Map<string, Recording>([[recording.id, recording]]);

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({
    recordings: mockRecordings,
    deleteRecording,
    loading: false,
  }),
  formatDuration: () => '0:10',
  recordingDurationMs: () => 10_000,
  recordingTotalBytes: () => 4,
  formatBytes: (n: number) => n + ' B',
}));

const { RecordingsView } = await import('../../src/views/RecordingsView');
const { ToastProvider } = await import('../../src/lib/toasts');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  deleteRecording.mockReset();
  deleteRecording.mockResolvedValue(true);
  mockRecordings = new Map<string, Recording>([[recording.id, recording]]);
});

function renderView() {
  const { container } = render(
    <ToastProvider>
      <RecordingsView onOpen={vi.fn()} />
    </ToastProvider>,
  );
  return within(container);
}

describe('RecordingsView — copy session id', () => {
  it('Copy writes the selected session id to the clipboard + shows a "Copied" toast', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const view = renderView();

    fireEvent.click(view.getByRole('button', { name: /copy session id/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ses_copy_me'));
    expect(await view.findByText('Copied')).toBeInTheDocument();
  });
});

describe('RecordingsView — delete confirmation (permanent, no recycle bin)', () => {
  it('the first Delete click only ARMS the confirm; a second click actually deletes', () => {
    const view = renderView();

    const del = view.getByRole('button', { name: /^Delete$/ });
    fireEvent.click(del);
    // Armed — not deleted yet.
    expect(deleteRecording).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: 'Confirm delete?' })).toBeTruthy();

    // Second click confirms.
    fireEvent.click(view.getByRole('button', { name: 'Confirm delete?' }));
    expect(deleteRecording).toHaveBeenCalledWith('rec_1');
  });

  it('Cancel disarms the confirm without deleting', () => {
    const view = renderView();
    fireEvent.click(view.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(deleteRecording).not.toHaveBeenCalled();
    // Back to the plain Delete label.
    expect(view.getByRole('button', { name: /^Delete$/ })).toBeTruthy();
  });
});

describe('RecordingsView — export safety', () => {
  it('Export is disabled while the recording is still live (endedAt === null)', () => {
    const live: Recording = { ...recording, id: 'rec_live', endedAt: null };
    mockRecordings = new Map<string, Recording>([[live.id, live]]);
    const view = renderView();
    const exportBtn = view.getByRole('button', { name: 'Export' });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
    expect(exportBtn.getAttribute('title')).toMatch(/Stop recording before exporting/i);
  });
});
