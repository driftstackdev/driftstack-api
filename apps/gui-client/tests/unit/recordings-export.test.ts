// Unit coverage for lib/recordings-export — the pure builder + filename for the
// founder-approved recordings export. Frame counts/bytes are recomputed from the
// actual frames (not the cached header values) so the envelope is internally
// consistent; the filename is filesystem-safe and correlatable by session id.

import { describe, expect, it } from 'vitest';
import {
  RECORDING_EXPORT_VERSION,
  buildRecordingExport,
  recordingExportFilename,
} from '../../src/lib/recordings-export';
import type { Recording } from '../../src/lib/recordings';

function frame(at: number, bytes: number): { at: number; dataUrl: string; bytes: number } {
  return { at, dataUrl: `data:image/png;base64,AAAA${at}`, bytes };
}

function rec(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec-1',
    sessionId: 'ses_abc123',
    label: null,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    frames: [frame(1_700_000_000_500, 100), frame(1_700_000_001_000, 200)],
    totalCaptured: 5,
    hydrated: false,
    frameCount: 2,
    totalBytes: 300,
    ...over,
  };
}

describe('buildRecordingExport', () => {
  it('produces a versioned, self-contained envelope with every frame', () => {
    const env = buildRecordingExport(rec(), new Date('2026-06-20T10:00:00.000Z'));
    expect(env.driftstack_recording_export).toBe(RECORDING_EXPORT_VERSION);
    expect(env.exportedAt).toBe('2026-06-20T10:00:00.000Z');
    expect(env.id).toBe('rec-1');
    expect(env.sessionId).toBe('ses_abc123');
    expect(env.frames).toHaveLength(2);
    expect(env.frames[0]).toEqual(frame(1_700_000_000_500, 100));
  });

  it('recomputes frameCount + totalBytes from the actual frames (not the cached header)', () => {
    // Header claims 99 frames / 9999 bytes but only 2 frames are present — the
    // envelope must reflect what it actually contains, so an importer is never
    // told there are more frames than the file holds.
    const env = buildRecordingExport(rec({ frameCount: 99, totalBytes: 9999 }), new Date(0));
    expect(env.frameCount).toBe(2);
    expect(env.totalBytes).toBe(300);
  });

  it('passes through a null label and a live (endedAt === null) recording', () => {
    const env = buildRecordingExport(rec({ label: null, endedAt: null }), new Date(0));
    expect(env.label).toBeNull();
    expect(env.endedAt).toBeNull();
  });

  it('preserves a non-null label', () => {
    const env = buildRecordingExport(rec({ label: 'Checkout flow' }), new Date(0));
    expect(env.label).toBe('Checkout flow');
  });
});

describe('recordingExportFilename', () => {
  it('is filesystem-safe: driftstack-recording-<session>-YYYY-MM-DD.json (UTC)', () => {
    const name = recordingExportFilename(rec(), new Date('2026-06-20T23:30:00.000Z'));
    expect(name).toBe('driftstack-recording-ses_abc123-2026-06-20.json');
  });

  it('strips unsafe characters from the session id', () => {
    const name = recordingExportFilename(
      rec({ sessionId: 'ses/../weird name:!' }),
      new Date('2026-01-02T00:00:00.000Z'),
    );
    // Only [A-Za-z0-9_-] survive.
    expect(name).toBe('driftstack-recording-sesweirdname-2026-01-02.json');
  });

  it('falls back to the recording id when the session id sanitises to empty', () => {
    const name = recordingExportFilename(
      rec({ sessionId: '///', id: 'rec-xyz' }),
      new Date('2026-01-02T00:00:00.000Z'),
    );
    expect(name).toBe('driftstack-recording-rec-xyz-2026-01-02.json');
  });
});
