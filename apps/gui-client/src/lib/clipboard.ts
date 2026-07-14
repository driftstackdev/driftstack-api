/**
 * Write one exact string without assuming the host WebView exposes the
 * Clipboard API. Because this is async, a missing API and a synchronous
 * WebKit permission throw become ordinary rejected promises for UI recovery.
 */
export async function writeClipboardText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    throw new Error('clipboard unavailable');
  }
  await clipboard.writeText(text);
}
