// Client-side file download helper. Mirrors the proven blob → object-URL →
// synthesized-anchor-click → revoke pattern from use-admin-csv-export (works in
// the Tauri WKWebView; revoking immediately avoids leaking the URL). Extracted
// so any view can offer a "download as JSON" affordance (e.g. bulk profile
// export) without re-rolling the mechanism.

/** Stable, filesystem-safe filename: `<prefix>-YYYY-MM-DD.<ext>` (UTC). */
export function timestampedFilename(prefix: string, ext: string, now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `${prefix}-${y}-${m}-${d}.${ext}`;
}

/** Trigger a browser download of an arbitrary Blob via the proven blob → object-URL
 *  → synthesized-anchor-click → revoke pattern (works in the Tauri WKWebView; revoking
 *  immediately avoids leaking the URL). No-op (safe) where URL.createObjectURL is
 *  absent (SSR / test stubs). Shared by downloadJson + the simulator download bar. */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

/** Trigger a browser download of `data` serialised as pretty JSON. No-op (safe)
 *  in environments without URL.createObjectURL (e.g. SSR/test stubs). */
export function downloadJson(filename: string, data: unknown): void {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}
