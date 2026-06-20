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

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({
    recordings: new Map<string, Recording>([[recording.id, recording]]),
    deleteRecording: vi.fn(() => Promise.resolve()),
    loading: false,
  }),
  formatDuration: () => '0:10',
  recordingDurationMs: () => 10_000,
  recordingTotalBytes: () => 4,
}));

const { RecordingsView } = await import('../../src/views/RecordingsView');
const { ToastProvider } = await import('../../src/lib/toasts');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RecordingsView — copy session id', () => {
  it('Copy writes the selected session id to the clipboard + shows a "Copied" toast', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { container } = render(
      <ToastProvider>
        <RecordingsView onOpen={vi.fn()} />
      </ToastProvider>,
    );
    const view = within(container);

    fireEvent.click(view.getByRole('button', { name: /copy session id/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ses_copy_me'));
    expect(await view.findByText('Copied')).toBeInTheDocument();
  });
});
