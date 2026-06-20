// GUI polish wave — keyboard control on RecordingPlayerView.
//
// Space toggles play/pause, but the listener must NOT hijack the keystroke
// when an input/textarea/contenteditable is focused (otherwise typing a
// space in a field would also pause playback). lib/recordings is mocked at
// module level (matching the empty-states.test.tsx pattern) so the test runs
// without the Tauri persistence runtime.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('RecordingPlayerView — Space play/pause keyboard control', () => {
  it('Space toggles the play/pause button when focus is not on a text field', () => {
    const { container } = render(<RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />);
    const view = within(container);

    // Starts paused → primary button reads "Play".
    expect(view.getByText('Play')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(view.getByText('Pause')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(view.getByText('Play')).toBeInTheDocument();
  });

  it('Space is IGNORED while an input/textarea is focused (does not hijack typing)', () => {
    const { container } = render(<RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />);
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
    const { container } = render(<RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />);
    expect(within(container).getByLabelText('Playback progress')).toHaveAttribute('type', 'range');
  });
});
