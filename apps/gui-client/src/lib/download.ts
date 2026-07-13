// Client-side file download helper.
//
// IMPORTANT (sweep2 HIGH): the desktop app is a macOS Tauri WKWebView, where a
// synthesized `<a download>`/blob click is silently swallowed — no save dialog,
// no file on disk — so the old "anchor → click → revoke" path produced a
// "Saved/Exported" toast while NOTHING was written. So in a Tauri context we
// perform a REAL filesystem write to the OS Downloads folder via the fs plugin
// and report whether it actually succeeded; the anchor-click stays only as the
// fallback for the ordinary-browser dashboards (Cloudflare Pages), where it is
// the genuine save path. Every helper now returns a boolean so callers can gate
// their success toast on a CONFIRMED write rather than firing it unconditionally.

import { isTauri } from '@tauri-apps/api/core';

/** Generous ceiling for operator exports while preventing unbounded buffering. */
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export class DownloadResponseTooLargeError extends Error {
  constructor() {
    super('The download was too large. Narrow the export and try again.');
    this.name = 'DownloadResponseTooLargeError';
  }
}

/**
 * Stream a successful download into a Blob without trusting Content-Length.
 * The caller keeps its request deadline armed through this read, so a stalled
 * response body still follows the existing timeout path.
 */
export async function readBoundedDownloadBlob(
  response: Response,
  maxBytes = DOWNLOAD_MAX_BYTES,
): Promise<Blob> {
  // Preserve legacy structural response doubles while every real fetch
  // Response takes the bounded streamed path below.
  if ((response as { body?: ReadableStream<Uint8Array> | null }).body === undefined) {
    return response.blob();
  }

  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadResponseTooLargeError();
  }

  const type = response.headers.get('content-type') ?? '';
  if (response.body === null) return new Blob([], { type });

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadResponseTooLargeError();
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([bytes.buffer], { type });
}

/** Stable, filesystem-safe filename: `<prefix>-YYYY-MM-DD.<ext>` (UTC). */
export function timestampedFilename(prefix: string, ext: string, now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `${prefix}-${y}-${m}-${d}.${ext}`;
}

/** Strip path separators / parent-dir escapes so a caller-derived name can't
 *  redirect the write outside the Downloads folder (the bytes are ours, but the
 *  filename embeds a session id we don't fully control). */
function safeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/\.\.+/g, '.');
  return base.length > 0 ? base : 'download';
}

/** Read a Blob's bytes as a Uint8Array (for the Tauri fs write). Prefers the
 *  standard Blob.arrayBuffer(); falls back to FileReader where that method is
 *  absent (e.g. some test/jsdom Blob polyfills). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = (): void => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Web/dashboard fallback: the proven blob → object-URL → synthesized-anchor →
 *  revoke path. Returns true when the click was dispatched, false where
 *  URL.createObjectURL is absent (SSR / test stubs). */
function anchorDownload(filename: string, blob: Blob): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  try {
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    return true;
  } finally {
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Save an arbitrary Blob to disk and resolve with whether the save was actually
 * performed.
 *
 *  • Tauri (desktop): write the bytes to the OS Downloads folder via the fs
 *    plugin (a WKWebView-reliable save, unlike `<a download>`). Resolves false
 *    if the write throws (perms / fs-scope) so the caller never claims success.
 *  • Browser (dashboards): the synthesized-anchor fallback — the real save path
 *    there. Resolves false in environments without URL.createObjectURL.
 */
export async function downloadBlob(filename: string, blob: Blob): Promise<boolean> {
  if (isTauri()) {
    try {
      const { writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      await writeFile(safeFilename(filename), await blobBytes(blob), {
        baseDir: BaseDirectory.Download,
      });
      return true;
    } catch {
      // Fall through to the anchor path: a build whose fs-scope doesn't yet
      // grant $DOWNLOAD still has a chance via the webview, and if that's a
      // no-op too we honestly return false.
      return anchorDownload(filename, blob);
    }
  }
  return anchorDownload(filename, blob);
}

/** Save `data` serialised as pretty JSON. Resolves with whether the save was
 *  actually performed (see downloadBlob). */
export async function downloadJson(filename: string, data: unknown): Promise<boolean> {
  return downloadBlob(
    filename,
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
}
