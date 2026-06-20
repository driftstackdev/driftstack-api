// GUI polish wave — keyboard control on RecordingPlayerView.
//
// Space toggles play/pause, but the listener must NOT hijack the keystroke
// when an input/textarea/contenteditable is focused (otherwise typing a
// space in a field would also pause playback). lib/recordings is mocked at
// module level (matching the empty-states.test.tsx pattern) so the test runs
// without the Tauri persistence runtime.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../src/lib/toasts';
import type { Recording } from '../../src/lib/recordings';

const recording: Recording = {
  id: 'rec_1',
  sessionId: 'ses_abc',
  label: null,
  startedAt: 1_000,
  endedAt: 11_000, // 10s duration → cursor starts at 0, not at the end
  frames: [
    { at: 1_000, dataUrl: 'data:image/png;base64,AAAA', bytes: 4 },
    { at: 6_000, dataUrl: 'data:image/png;base64,BBBB', bytes: 4 },
  ],
  totalCaptured: 2,
  hydrated: false,
  frameCount: 2,
  totalBytes: 8,
};

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({
    recordings: new Map<string, Recording>([[recording.id, recording]]),
    hydrateFrames: vi.fn(() => Promise.resolve(recording)),
  }),
  formatDuration: () => '0:00',
  recordingDurationMs: () => 10_000,
  recordingTotalBytes: () => 8,
}));

const { RecordingPlayerView } = await import('../../src/views/RecordingPlayerView');

// The player now surfaces an Export button via useToasts, so renders must sit
// inside <ToastProvider> (the real app wraps the whole tree in one).
function renderPlayer(el: ReactElement): ReturnType<typeof render> {
  return render(<ToastProvider>{el}</ToastProvider>);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RecordingPlayerView — Space play/pause keyboard control', () => {
  it('Space toggles the play/pause button when focus is not on a text field', () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);

    // Starts paused → primary button reads "Play".
    expect(view.getByText('Play')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(view.getByText('Pause')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(view.getByText('Play')).toBeInTheDocument();
  });

  it('Space is IGNORED while an input/textarea is focused (does not hijack typing)', () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);

    // Start with the scrubber range input as the keystroke target — typing
    // context should be respected for any form control.
    const scrubber = view.getByLabelText('Playback progress');
    fireEvent.keyDown(scrubber, { key: ' ', code: 'Space' });
    expect(view.getByText('Play')).toBeInTheDocument();

    // A real text input target must also be skipped.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: ' ', code: 'Space' });
    expect(view.getByText('Play')).toBeInTheDocument();
    input.remove();
  });

  it('the scrubber carries an accessible label', () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    expect(within(container).getByLabelText('Playback progress')).toHaveAttribute('type', 'range');
  });

  it('offers an Export button that confirms via a toast (recordings export is founder-approved)', () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);
    const exportBtn = view.getByText('Export');
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();
    // downloadJson no-ops in jsdom (no URL.createObjectURL); the success toast
    // still fires, so a click confirms the wiring without a real download.
    fireEvent.click(exportBtn);
    expect(view.getByText('Exported')).toBeInTheDocument();
  });
});
