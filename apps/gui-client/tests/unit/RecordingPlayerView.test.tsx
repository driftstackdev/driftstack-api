// GUI polish wave — keyboard control on RecordingPlayerView.
//
// Space toggles play/pause, but the listener must NOT hijack the keystroke
// when an input/textarea/contenteditable is focused (otherwise typing a
// space in a field would also pause playback). lib/recordings is mocked at
// module level (matching the empty-states.test.tsx pattern) so the test runs
// without the Tauri persistence runtime.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../src/lib/toasts';
import type { Recording } from '../../src/lib/recordings';

// downloadJson is mocked so the export toast can be tested against a CONFIRMED
// vs FAILED write (the success toast is now gated on the returned boolean — in
// the real Tauri WKWebView the anchor fallback writes nothing but used to read
// as success).
const mockDownloadJson = vi.fn(() => Promise.resolve(true));
vi.mock('../../src/lib/download', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    downloadJson: (...args: unknown[]) => mockDownloadJson(...args),
  };
});

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
  formatBytes: (n: number) => n + ' B',
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

  it('Space is ignored while a form field is focused (does not hijack typing)', () => {
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

  it("leaves Space on the frame button to native activation so playback doesn't double-toggle", () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);
    const frameButton = view.getByRole('button', { name: 'Play recording' });

    // Browsers dispatch the keydown first and activate the focused button
    // afterwards. The global shortcut must ignore the first half.
    fireEvent.keyDown(frameButton, { key: ' ', code: 'Space' });
    expect(view.getByText('Play')).toBeInTheDocument();

    fireEvent.click(frameButton);
    expect(view.getByText('Pause')).toBeInTheDocument();
    expect(view.getByText('Space to pause')).toBeInTheDocument();
  });

  it('does not hijack Space from local buttons, links, or ARIA controls', () => {
    const onBack = vi.fn();
    const { container } = renderPlayer(<RecordingPlayerView recordingId="rec_1" onBack={onBack} />);
    const view = within(container);

    fireEvent.keyDown(view.getByRole('button', { name: 'Export' }), {
      key: ' ',
      code: 'Space',
    });
    fireEvent.keyDown(view.getByRole('button', { name: '← Recordings' }), {
      key: ' ',
      code: 'Space',
    });

    const ariaControl = document.createElement('div');
    ariaControl.setAttribute('role', 'tab');
    container.appendChild(ariaControl);
    fireEvent.keyDown(ariaControl, { key: ' ', code: 'Space' });

    expect(view.getByText('Play')).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('the scrubber carries an accessible label', () => {
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    expect(within(container).getByLabelText('Playback progress')).toHaveAttribute('type', 'range');
  });

  it('offers an Export button that confirms via a toast ONLY on a confirmed write', async () => {
    mockDownloadJson.mockResolvedValueOnce(true);
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);
    const exportBtn = view.getByText('Export');
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();
    fireEvent.click(exportBtn);
    // Export is async + gated on the confirmed-write boolean → the success toast.
    await waitFor(() => expect(view.getByText('Exported')).toBeInTheDocument());
  });

  it('single-flights export and exposes a busy button until the write settles', async () => {
    let finishExport: ((saved: boolean) => void) | undefined;
    mockDownloadJson.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishExport = resolve;
        }),
    );
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);
    const exportBtn = view.getByRole('button', { name: 'Export' });

    fireEvent.click(exportBtn);
    fireEvent.click(exportBtn);

    const pending = await view.findByRole('button', { name: 'Exporting…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(mockDownloadJson).toHaveBeenCalledTimes(1);

    finishExport?.(true);
    await waitFor(() => expect(view.getByRole('button', { name: 'Export' })).toBeEnabled());
    expect(view.getByText('Exported')).toBeInTheDocument();
  });

  it('shows an Export FAILED toast (not a lying success) when the write does NOT land', async () => {
    // The Tauri WKWebView anchor fallback writes nothing → downloadJson resolves false.
    mockDownloadJson.mockResolvedValueOnce(false);
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);
    fireEvent.click(view.getByText('Export'));
    await waitFor(() => expect(view.getByText('Export failed')).toBeInTheDocument());
    // The success toast must NOT appear.
    expect(view.queryByText('Exported')).not.toBeInTheDocument();
  });

  it('contains a thrown filesystem failure behind customer-safe copy', async () => {
    mockDownloadJson.mockRejectedValueOnce(
      new Error('write failed at /Users/founder/Library/Application Support/private.json'),
    );
    const { container } = renderPlayer(
      <RecordingPlayerView recordingId="rec_1" onBack={vi.fn()} />,
    );
    const view = within(container);

    fireEvent.click(view.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(view.getByText('Export failed')).toBeInTheDocument());
    expect(view.getByText('Could not save the file.')).toBeInTheDocument();
    expect(view.queryByText(/Users\/founder/)).toBeNull();
    expect(view.getByRole('button', { name: 'Export' })).toBeEnabled();
  });
});
