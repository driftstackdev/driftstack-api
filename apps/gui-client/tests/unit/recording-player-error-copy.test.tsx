import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Recording } from '../../src/lib/recordings';
import { ToastProvider } from '../../src/lib/toasts';

const recording: Recording = {
  id: 'rec_error',
  sessionId: 'ses_error',
  label: null,
  startedAt: 1_000,
  endedAt: 2_000,
  frames: [],
  totalCaptured: 1,
  // Persisted index stubs use hydrated:true with no in-memory frames; opening
  // the player then asks the provider to hydrate the on-disk frame payload.
  hydrated: true,
  frameCount: 1,
  totalBytes: 4,
};

const hydrateFrames = vi.hoisted(() =>
  vi
    .fn()
    .mockRejectedValue(
      new Error('permission denied: /Users/founder/Library/Application Support/recordings.json'),
    ),
);

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({
    recordings: new Map([[recording.id, recording]]),
    hydrateFrames,
  }),
  formatDuration: () => '0:00',
  recordingDurationMs: () => 1_000,
  recordingTotalBytes: () => 4,
  formatBytes: (n: number) => `${n.toString()} B`,
}));

const { RecordingPlayerView } = await import('../../src/views/RecordingPlayerView');

describe('RecordingPlayerView local failure copy', () => {
  it('keeps local paths out of the retry state', async () => {
    render(
      <ToastProvider>
        <RecordingPlayerView recordingId={recording.id} onBack={vi.fn()} />
      </ToastProvider>,
    );

    expect(await screen.findByText("Couldn't load frames")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Couldn't read the saved recording. Check the app's file permissions and try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Users\/founder/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
