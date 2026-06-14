// download helper — timestampedFilename (pure) + downloadJson (the blob →
// anchor → revoke mechanism, the precedent reused for bulk profile export).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { timestampedFilename, downloadJson } from '../../src/lib/download';

describe('timestampedFilename', () => {
  it('formats <prefix>-YYYY-MM-DD.<ext> in UTC, zero-padded', () => {
    expect(
      timestampedFilename('driftstack-profiles', 'json', new Date('2026-06-14T23:59:00Z')),
    ).toBe('driftstack-profiles-2026-06-14.json');
    expect(timestampedFilename('x', 'csv', new Date('2026-01-05T00:00:00Z'))).toBe(
      'x-2026-01-05.csv',
    );
  });
});

describe('downloadJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serialises data + triggers an anchor download and revokes the URL', () => {
    const createObjectURL = vi.fn(() => 'blob:abc');
    const revokeObjectURL = vi.fn();
    // jsdom lacks createObjectURL — stub the pair.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => clicks.push((el as HTMLAnchorElement).download);
      }
      return el;
    });

    downloadJson('out.json', [{ a: 1 }]);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(clicks).toEqual(['out.json']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:abc');
  });

  it('is a safe no-op when createObjectURL is unavailable', () => {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
    expect(() => downloadJson('out.json', { a: 1 })).not.toThrow();
  });
});
