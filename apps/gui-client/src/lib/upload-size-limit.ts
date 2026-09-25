// Size limits for the simulator's file picker and cookie import.
//
// A file travels to the device running the session in one message, and each
// device takes messages up to its own size, so the largest file a session
// accepts is usually well under the 64 MiB per-file maximum. The session read
// publishes that figure as `upload_max_file_bytes` (see agent-session-control's
// `uploadMaxFileBytes`). The drop zone names it before a file is picked, and a
// picked file is checked against it here, which saves reading and encoding a
// file the server would refuse.
//
// Every sentence here is the client's own. A 413's `detail` and `title` are
// never shown (lib/api-errors: remote prose is not reflected into the installed
// client); only its `limit_bytes`, a number the server documents, is used.

import { AgentSessionControlError } from './agent-session-control';
import { fixedApiErrorMessage } from './api-errors';

/** The per-file maximum on every session, whatever the device takes. */
export const UPLOAD_ABSOLUTE_MAX_FILE_BYTES = 64 * 1024 * 1024;

const KIB = 2 ** 10;
const MIB = 2 ** 20;
const GIB = 2 ** 30;

function trim(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? rounded.toString()
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** `2.95 MiB`, `64 MiB`, `10 KiB` — the same label the server's message uses. */
export function sizeLabel(bytes: number): string {
  if (bytes >= GIB) return `${trim(bytes / GIB)} GiB`;
  if (bytes >= MIB) return `${trim(bytes / MIB)} MiB`;
  if (bytes >= KIB) return `${trim(bytes / KIB)} KiB`;
  return `${trim(bytes)} bytes`;
}

/**
 * The largest file this session takes, for the drop zone's hint: the device's
 * limit when known, never above the 64 MiB maximum; the maximum when not known.
 */
export function uploadLimitLabel(deviceLimitBytes: number | null): string {
  return sizeLabel(
    deviceLimitBytes === null
      ? UPLOAD_ABSOLUTE_MAX_FILE_BYTES
      : Math.min(deviceLimitBytes, UPLOAD_ABSOLUTE_MAX_FILE_BYTES),
  );
}

function tooLargeForDevice(limitBytes: number): string {
  return `This file is too large to send to this device (limit ${sizeLabel(limitBytes)}).`;
}

/**
 * Why `file` cannot be uploaded to this session, or null when it can be tried.
 * `deviceLimitBytes` is the session's `upload_max_file_bytes`, or null when not
 * known (an older server, or no device connected) — then only the 64 MiB
 * maximum is checked and the server has the final word.
 */
export function uploadRefusalNote(
  file: { name: string; size: number },
  deviceLimitBytes: number | null,
): string | null {
  // The tighter of the two limits names the refusal; a device that takes more
  // than the maximum never raises it.
  if (
    deviceLimitBytes !== null &&
    deviceLimitBytes < UPLOAD_ABSOLUTE_MAX_FILE_BYTES &&
    file.size > deviceLimitBytes
  ) {
    return tooLargeForDevice(deviceLimitBytes);
  }
  if (file.size > UPLOAD_ABSOLUTE_MAX_FILE_BYTES) {
    return `${file.name} is too large (max ${sizeLabel(UPLOAD_ABSOLUTE_MAX_FILE_BYTES)}).`;
  }
  return null;
}

function isTooLarge(err: unknown): err is AgentSessionControlError {
  return err instanceof AgentSessionControlError && err.status === 413;
}

/**
 * The note for an upload request that failed outright (a non-2xx). A 413 is the
 * server refusing the file's size: it names the limit the refusal carried, else
 * the one from the last session read (`deviceLimitBytes`), else fixed copy.
 * Anything else is a reachability gap.
 */
export function uploadFailureNote(err: unknown, deviceLimitBytes: number | null): string {
  if (isTooLarge(err)) {
    const limit = err.limitBytes ?? deviceLimitBytes;
    return limit !== null
      ? tooLargeForDevice(limit)
      : fixedApiErrorMessage('https://errors.driftstack.dev/payload-too-large', 413);
  }
  return "Couldn't upload — the device isn't reachable right now.";
}

/**
 * The note for a cookie import the server refused as too large (a 413): the jar
 * cannot reach this device at that size, so trying again would never work.
 * Null for any other failure.
 */
export function cookieImportRefusalNote(err: unknown): string | null {
  if (!isTooLarge(err)) return null;
  return err.limitBytes !== null
    ? `This cookie jar is too large to send to this device (limit ${sizeLabel(err.limitBytes)}).`
    : 'This cookie jar is too large to send to this device.';
}
