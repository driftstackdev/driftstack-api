#!/usr/bin/env node
// Smoke test for LiveKit go-live (V-531.B). Mints a short-lived
// publisher token against the env-configured LiveKit credentials and
// reports the WS handshake outcome. Use after wiring LIVEKIT_API_KEY
// + LIVEKIT_API_SECRET + LIVEKIT_WS_URL to /etc/driftstack/api.env
// on prod or staging.
//
// Usage:
//   node scripts/smoke-livekit.mjs \
//     --session-id sess_demo123 \
//     --role publisher \
//     --duration-ms 5000
//
// Requires:
//   LIVEKIT_API_KEY
//   LIVEKIT_API_SECRET
//   LIVEKIT_WS_URL  (wss://<project-id>.livekit.cloud)
//
// What it does:
//   1. Mint a JWT using lib/livekit-token's HS256 format.
//   2. Open a raw WS connection to LIVEKIT_WS_URL?access_token=…
//   3. Wait for the SIGNAL_JOIN response (LiveKit emits this on
//      successful auth + room-join). If we see it within
//      `--duration-ms`, treat it as a green smoke. Anything else
//      (auth failure, network, no response) is a red smoke.
//
// We deliberately do NOT depend on `livekit-client` here — the SDK
// pulls in WebRTC + protobuf code that's overkill for an ops smoke.
// A raw WS handshake + 'connected' message is sufficient signal.
//
// Exits non-zero on failure so CI can gate on it.

import process from 'node:process';

// Node 22+ exposes WebSocket globally. Bail with a helpful message
// otherwise so the operator knows to upgrade rather than getting a
// cryptic ReferenceError mid-handshake.
if (typeof globalThis.WebSocket !== 'function') {
  console.error('error: globalThis.WebSocket is unavailable. Requires Node 22+.');
  process.exit(2);
}
const { WebSocket } = globalThis;

const args = parseArgs(process.argv.slice(2));
if (!args['session-id']) {
  console.error('error: --session-id <id> is required');
  process.exit(2);
}

const role = args.role ?? 'publisher';
if (role !== 'publisher' && role !== 'subscriber') {
  console.error('error: --role must be "publisher" or "subscriber"');
  process.exit(2);
}
const durationMs = Number.parseInt(args['duration-ms'] ?? '5000', 10);
if (!Number.isInteger(durationMs) || durationMs < 1000) {
  console.error('error: --duration-ms must be an integer >= 1000');
  process.exit(2);
}

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const wsUrl = process.env.LIVEKIT_WS_URL;
if (!apiKey || !apiSecret || !wsUrl) {
  console.error('error: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_WS_URL must be set');
  process.exit(2);
}

const token = mintToken({
  apiKey,
  apiSecret,
  identity: args['session-id'],
  ttlSeconds: 600,
  video: {
    room: args['session-id'],
    roomJoin: true,
    canPublish: role === 'publisher',
    canSubscribe: role === 'subscriber',
  },
});

const target = `${wsUrl.replace(/\/+$/, '')}/rtc?access_token=${encodeURIComponent(token)}&auto_subscribe=1`;

console.log(`→ minting ${role} token for room ${args['session-id']}`);
console.log(`→ opening WS to ${maskUrl(target)}`);

const startedAt = Date.now();
let connected = false;
let firstMessageMs = null;

const ws = new WebSocket(target, ['protobuf']);
ws.binaryType = 'arraybuffer';
const timer = setTimeout(() => {
  if (!connected) {
    console.error(`FAIL: WS handshake did not complete within ${durationMs}ms`);
    try {
      ws.close(1000, 'smoke-timeout');
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}, durationMs);

ws.addEventListener('open', () => {
  connected = true;
  const ms = Date.now() - startedAt;
  console.log(`OK ws-open ${ms}ms`);
});

ws.addEventListener('message', (event) => {
  if (firstMessageMs === null) {
    firstMessageMs = Date.now() - startedAt;
    const size =
      event.data instanceof ArrayBuffer
        ? event.data.byteLength
        : typeof event.data === 'string'
          ? event.data.length
          : '?';
    console.log(`OK first-message ${firstMessageMs}ms (${size} bytes)`);
    clearTimeout(timer);
    setTimeout(() => {
      try {
        ws.close(1000, 'smoke-done');
      } catch {
        /* ignore */
      }
      process.exit(0);
    }, 100);
  }
});

ws.addEventListener('error', (event) => {
  const msg = event.message ?? event.error?.message ?? 'unknown';
  console.error(`FAIL: WS error: ${msg}`);
  clearTimeout(timer);
  process.exit(1);
});

ws.addEventListener('close', (event) => {
  if (!connected) {
    console.error(`FAIL: WS closed before open (code=${event.code} reason=${event.reason || '-'})`);
    clearTimeout(timer);
    process.exit(1);
  }
});

// ───── helpers ────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) {
        out[k] = v;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function maskUrl(url) {
  return url.replace(/access_token=[^&]+/, 'access_token=<masked>');
}

// ───── inlined token minter ───────────────────────────────────────
// Mirrors apps/server/src/lib/livekit-token.ts's mintLivekitToken so
// this script is dependency-free. Kept in sync via the lib's
// drift-guard tests + this commit's review.

import { createHmac } from 'node:crypto';

function mintToken(opts) {
  if (!opts.apiKey || !opts.apiSecret || !opts.identity) {
    throw new TypeError('apiKey + apiSecret + identity are required');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    exp: now + (opts.ttlSeconds ?? 600),
    iss: opts.apiKey,
    nbf: now,
    sub: opts.identity,
    jti: randomJti(),
    video: opts.video,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', opts.apiSecret).update(signingInput).digest();
  return `${signingInput}.${toBase64Url(signature)}`;
}

function base64UrlJson(value) {
  return toBase64Url(Buffer.from(JSON.stringify(value), 'utf8'));
}

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomJti() {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((b) => b === 0)) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
