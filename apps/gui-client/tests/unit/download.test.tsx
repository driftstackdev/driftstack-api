// download helper — timestampedFilename (pure) + the save path. The save path
// must NOT silently no-op in the Tauri WKWebView (where a synthesized
// `<a download>` click is swallowed): in a Tauri context it writes via the fs
// plugin, in a browser it uses the anchor fallback, and EITHER way it resolves
// with whether a save was actually performed so callers can gate the success
// toast (sweep2 HIGH — the toast used to lie while nothing was written).

import { readFileSync } from 'node:fs';

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const writeFile = vi.fn();
const openFile = vi.fn();
const removeFile = vi.fn();
// Mocked so the Tauri branch can be exercised without a real plugin.
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile,
  open: openFile,
  remove: removeFile,
  BaseDirectory: { Download: 7 },
}));

import {
  DownloadResponseTooLargeError,
  downloadBlob,
  downloadJson,
  downloadResponse,
  readBoundedDownloadBlob,
  timestampedFilename,
} from '../../src/lib/download';

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

describe('readBoundedDownloadBlob', () => {
  it('guards both authenticated response-download hooks', () => {
    for (const relative of [
      '../../src/lib/use-receipt-pdf-download.ts',
      '../../src/lib/use-admin-csv-export.ts',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      expect(source, relative).toContain('readBoundedDownloadBlob');
      expect(source, relative).toContain('downloadBlob');
      expect(source, relative).not.toMatch(/\bres\.blob\(/);
    }
  });

  it('streams a normal body and preserves its response MIME type', async () => {
    const response = new Response('order_id\nord_1\n', {
      headers: { 'content-type': 'text/csv; charset=utf-8' },
    });

    const blob = await readBoundedDownloadBlob(response, 64);
    expect(blob.type).toBe('text/csv; charset=utf-8');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (): void => resolve(reader.result as string);
      reader.onerror = (): void => reject(reader.error ?? new Error('blob read failed'));
      reader.readAsText(blob);
    });
    expect(text).toBe('order_id\nord_1\n');
  });

  it('rejects declared oversize before pulling and cancels the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      headers: { 'content-length': '5' },
    });

    await expect(readBoundedDownloadBlob(response, 4)).rejects.toBeInstanceOf(
      DownloadResponseTooLargeError,
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a chunked response on the first over-cap chunk', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
        },
        cancel,
      }),
    );

    await expect(readBoundedDownloadBlob(response, 4)).rejects.toBeInstanceOf(
      DownloadResponseTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
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

  it('removes the anchor and revokes its URL when the browser click throws', async () => {
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:throw');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click blocked');
    });

    await expect(downloadJson('out.json', { a: 1 })).rejects.toThrow('click blocked');
    expect(document.querySelector('a[href="blob:throw"]')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:throw');
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

describe('downloadResponse (streamed Tauri write)', () => {
  beforeEach(() => {
    tauri(true);
    openFile.mockReset();
    removeFile.mockReset();
  });
  afterEach(() => {
    tauri(false);
    vi.restoreAllMocks();
  });

  it('writes each chunk completely, including partial file-handle writes', async () => {
    const write = vi.fn((bytes: Uint8Array) => Promise.resolve(Math.min(2, bytes.byteLength)));
    const close = vi.fn().mockResolvedValue(undefined);
    openFile.mockResolvedValue({ write, close });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
          controller.close();
        },
      }),
      { headers: { 'content-length': '5' } },
    );

    await expect(downloadResponse('../../report.bin', response, 5)).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith('._._report.bin', {
      write: true,
      create: true,
      truncate: true,
      baseDir: 7,
    });
    expect(write.mock.calls.map((call) => Array.from(call[0]))).toEqual([
      [1, 2, 3, 4, 5],
      [3, 4, 5],
      [5],
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(removeFile).not.toHaveBeenCalled();
  });

  it('cancels an over-cap stream and removes the partial file', async () => {
    const cancel = vi.fn();
    const write = vi.fn().mockResolvedValue(3);
    const close = vi.fn().mockResolvedValue(undefined);
    openFile.mockResolvedValue({ write, close });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
        },
        cancel,
      }),
    );

    await expect(downloadResponse('large.bin', response, 4)).rejects.toBeInstanceOf(
      DownloadResponseTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(removeFile).toHaveBeenCalledWith('large.bin', { baseDir: 7 });
  });

  it('returns false and removes the partial file when a write makes no progress', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    openFile.mockResolvedValue({ write: vi.fn().mockResolvedValue(0), close });

    await expect(downloadResponse('stalled.bin', new Response('abc'), 4)).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(removeFile).toHaveBeenCalledWith('stalled.bin', { baseDir: 7 });
  });
});
