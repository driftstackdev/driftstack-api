// The device frame guard — every control-plane → device frame passes through it,
// and nothing else writes to a device's control socket.
//
// WHY IT EXISTS. The device reads its control WebSocket with a fixed maximum
// message size (`URLSessionWebSocketTask.maximumMessageSize`, 4 MiB on every
// build before `maxInboundFrameBytes` existed). That API cannot refuse ONE
// message: a larger inbound message fails the receive, and the device closes the
// whole socket with 1009. The socket is shared — it carries every session on
// the device — so one oversized upload or cookie import dropped the control link
// for all of them, and nothing anywhere said why. A per-frame reject on the
// device side is impossible, so the server must never send a frame the device
// cannot take.
//
// WHAT IT DOES. `DeviceFrameGuard.send(frame)` serialises the frame, measures
// the EXACT string it is about to write in UTF-8 bytes (what the device counts,
// not `string.length`), and compares that with the device's current limit. A
// frame over the limit is never written: the caller gets a typed
// `DeviceFrameTooLargeError` (frame type, size, limit) and one WARN line records
// the refusal — type, sizes, device and session only, never the frame, which
// carries customer files, cookies and page data. It is the only line: callers
// that log their own send failures skip this error. The socket is untouched, so
// every other session on the device carries on.
//
// THE LIMIT IS PER DEVICE. A device advertises `maxInboundFrameBytes` on its
// heartbeat (the first beat goes out as soon as it connects, and every beat
// repeats it). The owning connection hands each beat's value in through
// `observeAdvertisedMaxInboundFrameBytes`; a beat without it — or a connection
// that has not beaten yet — gets the 4 MiB default every earlier device used.
// See `deviceFrameLimitBytes` for the margin and the clamp.
//
// ⛔ BYPASS. The raw socket write is held in a `#private` field and called in
// exactly one place, after the size check. FleetControlConnection hands the raw
// send it is constructed with straight to this class and keeps no copy. The
// scanner `only-the-device-frame-guard-writes-to-a-device-socket` walks
// apps/server/src and fails on any other socket write, any other call of the raw
// send, and any frame serialised straight into a send.

import type { Logger } from '../lib/logger.js';

/** What a device reads when it advertises nothing: every device build before
 *  `maxInboundFrameBytes` set `maximumMessageSize` to 4 MiB. */
export const DEVICE_DEFAULT_MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Taken off every limit — the default and every advertised value alike — before
 * a frame is compared with it.
 *
 * The device's check is on its side of a boundary we cannot see: whether it
 * counts the WebSocket frame header (up to 10 bytes server→client), whether a
 * fragmented message is counted before or after reassembly, whether the
 * comparison is `>` or `>=`, and what a future OS release does to any of that.
 * Crossing it costs every session on the device, while staying 64 KiB short
 * costs 1.6% of a 4 MiB frame. The protocol's own overhead is at most 10 bytes
 * per server→client frame header, so 64 KiB covers it many times over even for
 * a message split into hundreds of fragments, and is still small enough that a
 * device advertising 1 MiB — URLSession's own default — keeps 94% of it.
 */
export const DEVICE_FRAME_SAFETY_MARGIN_BYTES = 64 * 1024;

/**
 * An advertised value above this is treated as this.
 *
 * The largest frame the server ever builds is a 64 MiB upload, which is about
 * 85.4 MiB once base64-encoded into its envelope, and the route queues at most
 * 96 MiB per socket (`FLEET_WS_MAX_BUFFERED_BYTES`), so no limit above ~96 MiB
 * changes what is sent. 256 MiB sits well clear of both, so it never refuses a
 * frame a device honestly accepts, while keeping a buggy or hostile value
 * (2^53, a byte count sent in bits) from turning the limit into "anything".
 */
export const DEVICE_MAX_ADVERTISED_INBOUND_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * The largest serialised frame, in UTF-8 bytes, that may be sent to a device
 * that advertised `advertised` (undefined: it advertised nothing, or nothing
 * valid). Clamped to DEVICE_MAX_ADVERTISED_INBOUND_FRAME_BYTES, then less
 * DEVICE_FRAME_SAFETY_MARGIN_BYTES. A value at or under the margin leaves room
 * for nothing: every frame is refused (and logged), which is what the device
 * asked for — sending anything would close its socket.
 */
export function deviceFrameLimitBytes(advertised: number | undefined): number {
  const accepted =
    advertised === undefined
      ? DEVICE_DEFAULT_MAX_INBOUND_FRAME_BYTES
      : Math.min(advertised, DEVICE_MAX_ADVERTISED_INBOUND_FRAME_BYTES);
  return Math.max(0, accepted - DEVICE_FRAME_SAFETY_MARGIN_BYTES);
}

/** A frame the device could not take was refused before it reached the socket.
 *  Nothing was sent; the socket and every other session on it are unaffected. */
export class DeviceFrameTooLargeError extends Error {
  constructor(
    readonly frameType: string,
    readonly frameBytes: number,
    readonly limitBytes: number,
  ) {
    // The message can travel on into a correlator's error outcome, so it names
    // the sizes and not the wire frame; the type is on the error and in the log.
    super(
      `this request is too large to send to this device (${frameBytes} bytes; its limit is ${limitBytes})`,
    );
    this.name = 'DeviceFrameTooLargeError';
  }
}

/** Every control-plane → device frame is a flat `{ type, … }` object. */
export interface DeviceFrame {
  readonly type: string;
}

/** Serialised size of a frame in UTF-8 bytes — exactly what `send` measures. */
export function deviceFrameBytes(frame: DeviceFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

export class DeviceFrameGuard {
  // The raw socket write. Private to this class at runtime, not only in types,
  // and called once — in `send`, after the size check.
  readonly #rawSend: (data: string) => void;
  #advertised: number | undefined = undefined;

  constructor(
    rawSend: (data: string) => void,
    private readonly context: { readonly nodeId: string; readonly logger: Logger | null },
  ) {
    this.#rawSend = rawSend;
  }

  /** Record the limit from the device's latest heartbeat. `undefined` — the
   *  beat did not carry a valid value — restores the default. */
  observeAdvertisedMaxInboundFrameBytes(advertised: number | undefined): void {
    this.#advertised = advertised;
  }

  /** The largest frame this device may be sent right now, in UTF-8 bytes. */
  limitBytes(): number {
    return deviceFrameLimitBytes(this.#advertised);
  }

  /**
   * Serialise `frame`, and write it to the device only if it fits.
   * @throws DeviceFrameTooLargeError when it does not; nothing is written.
   * Other throws are the raw write's own (socket not open, queue full).
   */
  send(frame: DeviceFrame): void {
    const data = JSON.stringify(frame);
    const frameBytes = Buffer.byteLength(data, 'utf8');
    const limitBytes = this.limitBytes();
    if (frameBytes > limitBytes) {
      // The ONE line for this refusal: callers that log their own send failures
      // skip a DeviceFrameTooLargeError, so this line carries the session too.
      const sessionId = (frame as { sessionId?: unknown }).sessionId;
      this.context.logger?.warn(
        {
          component: 'device-frame-guard',
          event: 'outbound_frame_refused',
          nodeId: this.context.nodeId,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          frameType: frame.type,
          frameBytes,
          limitBytes,
          advertisedMaxInboundFrameBytes: this.#advertised ?? null,
        },
        'refused a frame larger than the device accepts — it was NOT sent; the socket stays open',
      );
      throw new DeviceFrameTooLargeError(frame.type, frameBytes, limitBytes);
    }
    this.#rawSend(data);
  }
}

// ── Uploads ───────────────────────────────────────────────────────────────────
// An upload is one `uploadFile` frame: the file base64-encoded inside a JSON
// envelope. So the largest file a device can take is whatever leaves room for
// the envelope, times 3/4.

/** Longest `name` and `mime` the upload route accepts (UTF-16 code units). */
export const UPLOAD_NAME_MAX_LENGTH = 255;

// Every character of a name or type at its worst JSON cost: a control character
// or a lone surrogate is escaped as `\uXXXX`, six bytes. Nothing costs more.
const WORST_CASE_UPLOAD_TEXT = '\u0000'.repeat(UPLOAD_NAME_MAX_LENGTH);
// The route mints every upload's requestId with randomUUID().
const UUID_SHAPE = '00000000-0000-4000-8000-000000000000';

/**
 * The largest decoded file, in bytes, whose `uploadFile` frame for `sessionId`
 * fits in `frameLimitBytes` — whatever name and type it carries, up to their
 * 255-character maximum. A file this size or smaller always fits; the guard
 * still measures the real frame before it is sent.
 */
export function maxUploadFileBytesForFrame(frameLimitBytes: number, sessionId: string): number {
  const envelopeBytes = deviceFrameBytes({
    type: 'uploadFile',
    requestId: UUID_SHAPE,
    sessionId,
    name: WORST_CASE_UPLOAD_TEXT,
    mime: WORST_CASE_UPLOAD_TEXT,
    dataB64: '',
  } as DeviceFrame);
  const room = frameLimitBytes - envelopeBytes;
  // Base64 carries 3 bytes in every 4 characters (all ASCII, never escaped).
  return room <= 0 ? 0 : Math.floor(room / 4) * 3;
}
