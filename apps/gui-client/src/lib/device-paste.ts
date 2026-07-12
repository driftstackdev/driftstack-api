export type DevicePasteResult =
  | 'ok'
  | 'empty'
  | 'too_large'
  | 'clipboard_error'
  | 'send_error'
  | 'stale';

/** Read the host clipboard and deliver one bounded text event to the current device.
 * `isCurrent` is checked across both awaits so an in-place session swap never sends
 * clipboard contents into the room that belonged to the previous session. */
export async function pasteClipboardToDevice(
  readText: () => Promise<string>,
  send: (text: string) => Promise<void>,
  isCurrent: () => boolean,
  maxBytes: number,
): Promise<DevicePasteResult> {
  let value: string;
  try {
    value = await readText();
  } catch {
    return isCurrent() ? 'clipboard_error' : 'stale';
  }
  if (!isCurrent()) return 'stale';
  if (value === '') return 'empty';
  if (new TextEncoder().encode(value).byteLength > maxBytes) return 'too_large';

  try {
    await send(value);
  } catch {
    return isCurrent() ? 'send_error' : 'stale';
  }
  return isCurrent() ? 'ok' : 'stale';
}
