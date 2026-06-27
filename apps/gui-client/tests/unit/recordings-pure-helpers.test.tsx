// Pure-function tests for the three helper exports on recordings.tsx
// used by views (formatDuration + recordingDurationMs +
// recordingTotalBytes). Previously these were mocked-but-not-directly-
// tested at empty-states.test.tsx:54-56 — the mocks let the empty-state
// tests run without instantiating real recordings, but they didn't pin
// the actual behavior.
//
// Why this matters: recordingTotalBytes has a hydration branch (line
// 304: "if hydrated && frames empty, use cached totalBytes; else sum
// frames"). Without a direct test, drift to "always sum frames" would
// silently render persisted-but-not-yet-loaded recordings as 0 bytes
// — exactly the field-name drift class fixed in slices 78/79/80/81.

import { describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  type Recording,
  type RecordingFrame,
} from '../../src/lib/recordings';

function makeRecording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec_test',
    sessionId: 'ses_test',
    label: null,
    startedAt: 1700000000000,
    endedAt: 1700000060000, // +60s
    frames: [],
    totalCaptured: 0,
    hydrated: false,
    frameCount: 0,
    totalBytes: 0,
    ...over,
  };
}

function makeFrame(bytes: number, at: number = 1700000000000): RecordingFrame {
  return { at, dataUrl: 'data:image/png;base64,fake', bytes };
}

// P2 #10 — adaptive byte size: a sub-100KB recording must NOT read "0.0 MB".
describe('formatBytes', () => {
  it('uses B / KB / MB adaptively so small sizes are readable', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    // A 50KB recording used to show "0.0 MB"; now an honest KB value.
    expect(formatBytes(50 * 1024)).toBe('50 KB');
    expect(formatBytes(5 * 1024)).toBe('5.0 KB'); // <10KB keeps a decimal
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
  it('never returns "0.0 MB" for a non-trivial sub-MB size', () => {
    expect(formatBytes(90_000)).not.toMatch(/MB/);
    expect(formatBytes(90_000)).toMatch(/KB/);
  });
});

describe('formatDuration', () => {
  it('renders "0:00" for 0ms', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('renders "0:01" for 999ms (rounds to 1s)', () => {
    expect(formatDuration(999)).toBe('0:01');
  });

  it('renders "0:01" for exactly 1000ms', () => {
    expect(formatDuration(1000)).toBe('0:01');
  });

  it('renders "0:30" for 30000ms', () => {
    expect(formatDuration(30_000)).toBe('0:30');
  });

  it('renders "1:00" for 60_000ms', () => {
    expect(formatDuration(60_000)).toBe('1:00');
  });

  it('renders "1:23" for 83_000ms', () => {
    expect(formatDuration(83_000)).toBe('1:23');
  });

  it('renders "10:05" for 605_000ms (padding works at >1 digit minutes)', () => {
    expect(formatDuration(605_000)).toBe('10:05');
  });

  it('clamps negative input to 0 (defensive)', () => {
    expect(formatDuration(-500)).toBe('0:00');
  });
});

describe('recordingDurationMs', () => {
  it('returns endedAt - startedAt for a completed recording', () => {
    const r = makeRecording({ startedAt: 1000, endedAt: 5000 });
    expect(recordingDurationMs(r)).toBe(4000);
  });

  it('falls back to Date.now() when endedAt is null (still-recording)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      const r = makeRecording({ startedAt: 3000, endedAt: null });
      expect(recordingDurationMs(r)).toBe(7000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps to 0 when endedAt is before startedAt (defensive)', () => {
    // Could happen if the system clock jumps backwards mid-recording.
    const r = makeRecording({ startedAt: 5000, endedAt: 1000 });
    expect(recordingDurationMs(r)).toBe(0);
  });

  it('returns 0 for a recording where startedAt === endedAt (instantaneous)', () => {
    const r = makeRecording({ startedAt: 1000, endedAt: 1000 });
    expect(recordingDurationMs(r)).toBe(0);
  });
});

describe('recordingTotalBytes', () => {
  it('sums frame bytes for a live recording (hydrated=false)', () => {
    const r = makeRecording({
      hydrated: false,
      frames: [makeFrame(100), makeFrame(200), makeFrame(50)],
    });
    expect(recordingTotalBytes(r)).toBe(350);
  });

  it('returns the cached totalBytes for a hydrated-but-unloaded recording (frames.length === 0)', () => {
    // Persisted-but-not-yet-loaded: the index header carries
    // `totalBytes` but `frames` is empty. Without the hydration branch,
    // the dashboard would render "0 bytes" for every persisted
    // recording until the user expanded it.
    const r = makeRecording({
      hydrated: true,
      frames: [],
      totalBytes: 12345,
    });
    expect(recordingTotalBytes(r)).toBe(12345);
  });

  it('once frames are loaded on a hydrated recording, switches to summing the in-memory frames', () => {
    // hydrated=true but frames are populated → use the live frames sum
    // (which is the source-of-truth once they're loaded). The cached
    // totalBytes is stale at this point.
    const r = makeRecording({
      hydrated: true,
      frames: [makeFrame(40), makeFrame(60)],
      totalBytes: 12345, // stale header value — should NOT be used
    });
    expect(recordingTotalBytes(r)).toBe(100);
  });

  it('returns 0 for a fresh recording with no frames captured yet', () => {
    const r = makeRecording({ hydrated: false, frames: [] });
    expect(recordingTotalBytes(r)).toBe(0);
  });

  it('handles a single-frame recording', () => {
    const r = makeRecording({ hydrated: false, frames: [makeFrame(999)] });
    expect(recordingTotalBytes(r)).toBe(999);
  });
});
