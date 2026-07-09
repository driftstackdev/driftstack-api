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

    // The action-row Delete arms the confirmation (it does not delete on the
    // first click). Once armed it's disabled, so grab it up front.
    fireEvent.click(view.getByRole('button', { name: /^Delete$/ }));
    // Armed — not deleted yet; a dedicated full-width confirm bar appears BELOW
    // the action row ("Confirm delete?" text + its own Delete + Cancel).
    expect(deleteRecording).not.toHaveBeenCalled();
    const confirmBar = view.getByText('Confirm delete?').closest('div') as HTMLElement;
    expect(confirmBar).toBeTruthy();

    // The confirm bar's own Delete button actually deletes.
    fireEvent.click(within(confirmBar).getByRole('button', { name: /^Delete$/ }));
    expect(deleteRecording).toHaveBeenCalledWith('rec_1');
  });

  it('Cancel disarms the confirm without deleting', () => {
    const view = renderView();
    fireEvent.click(view.getByRole('button', { name: /^Delete$/ }));
    const confirmBar = view.getByText('Confirm delete?').closest('div') as HTMLElement;
    fireEvent.click(within(confirmBar).getByRole('button', { name: 'Cancel' }));
    expect(deleteRecording).not.toHaveBeenCalled();
    // The confirm bar is gone — no "Confirm delete?" prompt remains.
    expect(view.queryByText('Confirm delete?')).toBeNull();
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
