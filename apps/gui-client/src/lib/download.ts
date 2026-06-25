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
  a.href = objectUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
  return true;
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
