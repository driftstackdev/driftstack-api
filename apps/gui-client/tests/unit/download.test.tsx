// download helper — timestampedFilename (pure) + the save path. The save path
// must NOT silently no-op in the Tauri WKWebView (where a synthesized
// `<a download>` click is swallowed): in a Tauri context it writes via the fs
// plugin, in a browser it uses the anchor fallback, and EITHER way it resolves
// with whether a save was actually performed so callers can gate the success
// toast (sweep2 HIGH — the toast used to lie while nothing was written).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const writeFile = vi.fn();
// Mocked so the Tauri branch can be exercised without a real plugin.
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile,
  BaseDirectory: { Download: 7 },
}));

import { timestampedFilename, downloadJson, downloadBlob } from '../../src/lib/download';

function tauri(on: boolean): void {
  (globalThis as unknown as { isTauri?: boolean }).isTauri = on || undefined;
}

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

describe('downloadJson (browser / anchor fallback)', () => {
  beforeEach(() => {
    tauri(false);
    writeFile.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serialises data, triggers an anchor download, revokes the URL, and resolves true', async () => {
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

    const saved = await downloadJson('out.json', [{ a: 1 }]);

    expect(saved).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(clicks).toEqual(['out.json']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:abc');
    // Browser path does NOT touch the fs plugin.
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('resolves false (no claimed success) when createObjectURL is unavailable', async () => {
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
    await expect(downloadJson('out.json', { a: 1 })).resolves.toBe(false);
  });
});

describe('downloadBlob (Tauri context)', () => {
  beforeEach(() => {
    tauri(true);
    writeFile.mockReset();
  });
  afterEach(() => {
    tauri(false);
    vi.restoreAllMocks();
  });

  it('writes the bytes to the OS Downloads dir via the fs plugin and resolves true', async () => {
    writeFile.mockResolvedValue(undefined);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' });
    const saved = await downloadBlob('report.pdf', blob);
    expect(saved).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0] as [string, Uint8Array, { baseDir: number }];
    expect(call[0]).toBe('report.pdf');
    expect(call[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(call[1])).toEqual([1, 2, 3]);
    expect(call[2]).toEqual({ baseDir: 7 });
  });

  it('sanitises a path-traversing filename so the write can not escape Downloads', async () => {
    writeFile.mockResolvedValue(undefined);
    await downloadBlob('../../etc/evil.json', new Blob(['x']));
    expect(writeFile.mock.calls[0]?.[0]).toBe('._._etc_evil.json');
  });

  it('resolves false (toast must NOT claim success) when the fs write fails AND no anchor is available', async () => {
    writeFile.mockRejectedValue(new Error('fs scope denied'));
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
    await expect(downloadBlob('x.json', new Blob(['x']))).resolves.toBe(false);
  });
});
