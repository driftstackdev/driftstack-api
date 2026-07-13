// Authenticated fleet WebSocket ingress guard.
//
// The shared socket must allow a ~85.3 MiB base64 download reply, but every
// other harness frame is at most an 8 MiB decoded intent result plus a small
// JSON envelope. Keep the transport cap for real downloads while preventing an
// authenticated-but-compromised node from repeatedly forcing near-cap
// Buffer→string→JSON.parse→Zod allocation on unsolicited frames.

import {
  HARNESS_FRAME_ID_MAX_LENGTH,
  HARNESS_INTENT_OUTPUT_MAX_BYTES,
} from '../schemas/harness-control-protocol.js';

/** Anything larger can only be a correlated downloadData result. */
export const FLEET_INBOUND_LARGE_FRAME_THRESHOLD_BYTES =
  4 * Math.ceil(HARNESS_INTENT_OUTPUT_MAX_BYTES / 3) + 64 * 1024;

/** Ordinary-frame burst and refill budgets, shared across reconnects by node. */
export const FLEET_INBOUND_FRAME_BURST = 256;
export const FLEET_INBOUND_FRAMES_PER_SECOND = 32;
export const FLEET_INBOUND_BYTE_BURST = 64 * 1024 * 1024;
export const FLEET_INBOUND_BYTES_PER_SECOND = 8 * 1024 * 1024;
export const FLEET_INBOUND_LARGE_FRAME_BURST = 4;
export const FLEET_INBOUND_LARGE_FRAMES_PER_SECOND = 1;

export interface LargeDownloadResultHeader {
  readonly requestId: string;
  readonly sessionId: string;
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipWhitespace(raw: Buffer, from: number): number {
  let cursor = from;
  while (cursor < raw.length && isWhitespace(raw[cursor] ?? 0)) cursor += 1;
  return cursor;
}

/** Return the byte immediately after a JSON string, without allocating it. */
function jsonStringEnd(raw: Buffer, start: number): number | null {
  if (raw[start] !== 0x22) return null;
  for (let cursor = start + 1; cursor < raw.length; cursor += 1) {
    const byte = raw[cursor] ?? 0;
    if (byte === 0x22) return cursor + 1;
    if (byte < 0x20) return null;
    if (byte === 0x5c) {
      cursor += 1;
      if (cursor >= raw.length) return null;
      if (raw[cursor] === 0x75) {
        // A JSON unicode escape is exactly four hexadecimal digits. Full JSON
        // validation still happens later, but fail closed here rather than let
        // a malformed oversized header reach the allocating parser.
        for (let offset = 1; offset <= 4; offset += 1) {
          const hex = raw[cursor + offset];
          if (
            hex === undefined ||
            !(
              (hex >= 0x30 && hex <= 0x39) ||
              (hex >= 0x41 && hex <= 0x46) ||
              (hex >= 0x61 && hex <= 0x66)
            )
          ) {
            return null;
          }
        }
        cursor += 4;
      } else if (
        raw[cursor] !== 0x22 &&
        raw[cursor] !== 0x5c &&
        raw[cursor] !== 0x2f &&
        raw[cursor] !== 0x62 &&
        raw[cursor] !== 0x66 &&
        raw[cursor] !== 0x6e &&
        raw[cursor] !== 0x72 &&
        raw[cursor] !== 0x74
      ) {
        return null;
      }
    }
  }
  return null;
}

/** Skip one JSON value lexically. Strings are scanned but never materialized. */
function jsonValueEnd(raw: Buffer, start: number): number | null {
  if (start >= raw.length) return null;
  if (raw[start] === 0x22) return jsonStringEnd(raw, start);
  if (raw[start] === 0x7b || raw[start] === 0x5b) {
    const stack: number[] = [raw[start] ?? 0];
    for (let cursor = start + 1; cursor < raw.length; cursor += 1) {
      const byte = raw[cursor] ?? 0;
      if (byte === 0x22) {
        const end = jsonStringEnd(raw, cursor);
        if (end === null) return null;
        cursor = end - 1;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        if (stack.length >= 64) return null;
        stack.push(byte);
        continue;
      }
      if (byte === 0x7d || byte === 0x5d) {
        const opening = stack.pop();
        if (
          opening === undefined ||
          (byte === 0x7d && opening !== 0x7b) ||
          (byte === 0x5d && opening !== 0x5b)
        ) {
          return null;
        }
        if (stack.length === 0) return cursor + 1;
      }
    }
    return null;
  }

  let cursor = start;
  while (cursor < raw.length) {
    const byte = raw[cursor] ?? 0;
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d || isWhitespace(byte)) break;
    cursor += 1;
  }
  return cursor === start ? null : cursor;
}

function decodeBoundedJsonString(
  raw: Buffer,
  start: number,
  end: number,
  maxDecodedLength: number,
): string | null {
  // Each decoded UTF-16 code unit needs at most one six-byte \uXXXX escape.
  if (end - start > maxDecodedLength * 6 + 2) return null;
  try {
    const value: unknown = JSON.parse(raw.subarray(start, end).toString('utf8'));
    return typeof value === 'string' && value.length <= maxDecodedLength ? value : null;
  } catch {
    return null;
  }
}

/**
 * Extract only the three top-level strings needed to authorize an oversized
 * result. The full Buffer is scanned without copying its base64 body. Duplicate
 * correlation keys, nested decoys, malformed structure, or trailing bytes fail
 * closed. At most a few hundred header bytes are ever converted to strings.
 */
export function readLargeDownloadResultHeader(raw: Buffer): LargeDownloadResultHeader | null {
  let cursor = skipWhitespace(raw, 0);
  if (raw[cursor] !== 0x7b) return null;
  cursor += 1;

  let type: string | undefined;
  let requestId: string | undefined;
  let sessionId: string | undefined;
  const seen = new Set<string>();
  let requiresMember = false;

  for (;;) {
    cursor = skipWhitespace(raw, cursor);
    if (raw[cursor] === 0x7d) {
      if (requiresMember) return null;
      cursor = skipWhitespace(raw, cursor + 1);
      break;
    }

    const keyStart = cursor;
    const keyEnd = jsonStringEnd(raw, keyStart);
    if (keyEnd === null) return null;
    const key = decodeBoundedJsonString(raw, keyStart, keyEnd, 32);
    cursor = skipWhitespace(raw, keyEnd);
    if (raw[cursor] !== 0x3a) return null;
    cursor = skipWhitespace(raw, cursor + 1);
    const valueStart = cursor;
    const valueEnd = jsonValueEnd(raw, valueStart);
    if (valueEnd === null) return null;
    requiresMember = false;

    if (key === 'type' || key === 'requestId' || key === 'sessionId') {
      if (seen.has(key)) return null;
      seen.add(key);
      if (raw[valueStart] !== 0x22) return null;
      const value = decodeBoundedJsonString(raw, valueStart, valueEnd, HARNESS_FRAME_ID_MAX_LENGTH);
      if (value === null || value.length === 0) return null;
      if (key === 'type') type = value;
      else if (key === 'requestId') requestId = value;
      else sessionId = value;
    }

    cursor = skipWhitespace(raw, valueEnd);
    if (raw[cursor] === 0x2c) {
      cursor += 1;
      requiresMember = true;
      continue;
    }
    if (raw[cursor] === 0x7d) {
      cursor = skipWhitespace(raw, cursor + 1);
      break;
    }
    return null;
  }

  if (
    cursor !== raw.length ||
    type !== 'downloadData' ||
    requestId === undefined ||
    sessionId === undefined
  ) {
    return null;
  }
  return { requestId, sessionId };
}

interface NodeBudgetState {
  frameTokens: number;
  byteTokens: number;
  largeFrameTokens: number;
  refilledAtMs: number;
}

/** Reconnect-resistant token buckets; one instance is owned by the registry. */
export class FleetInboundFrameBudget {
  private readonly states = new Map<string, NodeBudgetState>();

  constructor(private readonly clock: () => number = Date.now) {}

  admit(nodeId: string, byteLength: number, largeFrameCandidate: boolean): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    const now = this.clock();
    let state = this.states.get(nodeId);
    if (state === undefined) {
      state = {
        frameTokens: FLEET_INBOUND_FRAME_BURST,
        byteTokens: FLEET_INBOUND_BYTE_BURST,
        largeFrameTokens: FLEET_INBOUND_LARGE_FRAME_BURST,
        refilledAtMs: now,
      };
      this.states.set(nodeId, state);
    }

    const elapsedSeconds = Math.max(0, now - state.refilledAtMs) / 1000;
    state.frameTokens = Math.min(
      FLEET_INBOUND_FRAME_BURST,
      state.frameTokens + elapsedSeconds * FLEET_INBOUND_FRAMES_PER_SECOND,
    );
    state.byteTokens = Math.min(
      FLEET_INBOUND_BYTE_BURST,
      state.byteTokens + elapsedSeconds * FLEET_INBOUND_BYTES_PER_SECOND,
    );
    state.largeFrameTokens = Math.min(
      FLEET_INBOUND_LARGE_FRAME_BURST,
      state.largeFrameTokens + elapsedSeconds * FLEET_INBOUND_LARGE_FRAMES_PER_SECOND,
    );
    state.refilledAtMs = now;

    // A large candidate must be inspected lexically before correlation can be
    // established, so give that O(n) scan its own tight bucket. Do not charge
    // its unavoidable 64 MiB body to the ordinary byte bucket; the one-shot
    // fetch claim separately prevents replay after this admission.
    const byteCost = largeFrameCandidate ? 0 : byteLength;
    if (
      state.frameTokens < 1 ||
      state.byteTokens < byteCost ||
      (largeFrameCandidate && state.largeFrameTokens < 1)
    ) {
      return false;
    }
    state.frameTokens -= 1;
    state.byteTokens -= byteCost;
    if (largeFrameCandidate) state.largeFrameTokens -= 1;
    return true;
  }
}
