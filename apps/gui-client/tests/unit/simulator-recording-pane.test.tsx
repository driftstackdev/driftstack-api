import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatorRecordingPane } from '../../src/components/SimulatorRecordingPane';
import type { Recording } from '../../src/lib/recordings';

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'rec_live',
    sessionId: 'agt_1',
    label: 'Checkout flow',
    startedAt: Date.now() - 5000,
    endedAt: null,
    frames: [{ at: Date.now(), dataUrl: 'data:image/jpeg;base64,AA==', bytes: 2048 }],
    totalCaptured: 1,
    hydrated: false,
    frameCount: 1,
    totalBytes: 2048,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SimulatorRecordingPane', () => {
  it('owns the live elapsed clock without rerendering its parent simulator host', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T10:00:00Z'));
    const live = recording({ startedAt: Date.now() - 5000 });
    let parentRenders = 0;

    function Host(): JSX.Element {
      const stableRecordings = useRef(new Map([[live.id, live]])).current;
      parentRenders += 1;
      return (
        <SimulatorRecordingPane
          recordings={stableRecordings}
          recordingId={live.id}
          sessionAvailable
          confirmingDeleteId={null}
          onToggleRecording={() => {}}
          onExport={() => {}}
          onDelete={() => {}}
        />
      );
    }

    render(<Host />);
    expect(screen.getByText('0:05')).toBeTruthy();
    expect(parentRenders).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(screen.getByText('0:07')).toBeTruthy();
    expect(parentRenders).toBe(1);
  });

  it('preserves recording, export, and two-step delete affordances', () => {
    const onToggle = vi.fn();
    const onExport = vi.fn();
    const onDelete = vi.fn();
    const saved = recording({ id: 'rec_saved', endedAt: Date.now(), label: null });

    render(
      <SimulatorRecordingPane
        recordings={new Map([[saved.id, saved]])}
        recordingId={null}
        sessionAvailable
        confirmingDeleteId={saved.id}
        onToggleRecording={onToggle}
        onExport={onExport}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete recording' }));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledWith(saved);
    expect(onDelete).toHaveBeenCalledWith(saved.id);
    expect(screen.getByText('Delete?')).toBeTruthy();
  });
});
