// W586.C — drift guard for packages/sdk-python/src/driftstack/webhook_signature.py.
// HMAC webhook signature verifier (Stripe-style t=...,v1=...). Drift
// here either breaks the constant-time HMAC compare (timing attack
// risk), drops the V-359 24h dual-signature rollover support, or
// flips the 300-second default tolerance.
//
//   • Header format: t=<unix-seconds>,v1=<hex hmac>; order-independent.
//   • HMAC = HMAC-SHA256(<unix-seconds>.<raw body>, <secret>).
//   • DEFAULT_TOLERANCE_SEC = 300.
//   • V-359 header_prev: optional 24h grace window signature.
//   • hmac.compare_digest constant-time compare.
//   • Returns False on every failure mode — never raises.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/webhook_signature.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W586.C packages/sdk-python/src/driftstack/webhook_signature.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + Stripe-style t=...,v1=... wire format + HMAC-SHA256(<unix-seconds>.<raw body>, <secret>) + verifyWebhookSignature TS SDK mirror + Flask/FastAPI/Django raw-body example pinned', () => {
    expect(body).toMatch(/^"""Webhook signature verification helper\.\n/);
    expect(body).toMatch(/Header format \(Stripe-style\): ``t=<unix-seconds>,v1=<hex hmac>``\./);
    expect(body).toMatch(/HMAC = HMAC-SHA256\(``<unix-seconds>\.<raw body>``, ``<secret>``\)\./);
    expect(body).toMatch(/Mirrors :func:`verifyWebhookSignature` from the TypeScript SDK so a/);
    expect(body).toMatch(/multi-language receiver fleet works against the same wire format\./);
    expect(body).toMatch(/from driftstack import verify_webhook_signature/);
    expect(body).toMatch(/sig = request\.headers\["x-driftstack-signature"\]/);
    expect(body).toMatch(/ok = verify_webhook_signature\(/);
    expect(body).toMatch(/secret=os\.environ\["DRIFTSTACK_WEBHOOK_SECRET"\],/);
  });

  it('Imports + DEFAULT_TOLERANCE_SEC = 300 + _ParsedSignature dataclass (timestamp_seconds + signature_hex) pinned', () => {
    expect(body).toMatch(/^import hashlib$/m);
    expect(body).toMatch(/^import hmac$/m);
    expect(body).toMatch(/^import time$/m);
    expect(body).toMatch(/^from dataclasses import dataclass$/m);
    expect(body).toMatch(/^DEFAULT_TOLERANCE_SEC = 300$/m);
    expect(body).toMatch(
      /^@dataclass\nclass _ParsedSignature:\s*\n\s*timestamp_seconds: int\s*\n\s*signature_hexes: list\[str\]$/m,
    );
  });

  it('_parse_signature_header: split on , + split on = + accept t (int) + v1 (hex) + order-independent + None if either missing or unparseable', () => {
    expect(body).toMatch(
      /^def _parse_signature_header\(header: str\) -> _ParsedSignature \| None:/m,
    );
    expect(body).toMatch(/timestamp: int \| None = None\s*\n\s*signatures: list\[str\] = \[\]/);
    expect(body).toMatch(/for part in header\.split\(","\):/);
    expect(body).toMatch(/eq_idx = part\.find\("="\)\s*\n\s*if eq_idx < 0:\s*\n\s*continue/);
    expect(body).toMatch(
      /key = part\[:eq_idx\]\.strip\(\)\s*\n\s*value = part\[eq_idx \+ 1 :\]\.strip\(\)/,
    );
    expect(body).toMatch(
      /if key == "t":\s*\n\s*try:\s*\n\s*timestamp = int\(value\)\s*\n\s*except ValueError:\s*\n\s*continue\s*\n\s*elif key == "v1" and value:\s*\n\s*signatures\.append\(value\)/,
    );
    expect(body).toMatch(
      /if timestamp is None or not signatures:\s*\n\s*return None\s*\n\s*return _ParsedSignature\(timestamp_seconds=timestamp, signature_hexes=signatures\)/,
    );
  });

  it('_verify_single_header: header-must-be-string + parsed-not-None + abs(now - ts) <= tolerance + payload = f"{ts}.".encode() + body_bytes + HMAC-SHA256 + constant-time compare via hmac.compare_digest', () => {
    expect(body).toMatch(
      /^def _verify_single_header\(\s*\n\s*header: str \| None,\s*\n\s*body_bytes: bytes,\s*\n\s*secret: str,\s*\n\s*tolerance_sec: int,\s*\n\s*now: float,\s*\n\) -> bool:/m,
    );
    expect(body).toMatch(/if not header or not isinstance\(header, str\):\s*\n\s*return False/);
    expect(body).toMatch(
      /parsed = _parse_signature_header\(header\)\s*\n\s*if parsed is None:\s*\n\s*return False/,
    );
    expect(body).toMatch(
      /if abs\(now - parsed\.timestamp_seconds\) > tolerance_sec:\s*\n\s*return False/,
    );
    expect(body).toMatch(
      /payload = f"\{parsed\.timestamp_seconds\}\."\.encode\(\) \+ body_bytes\s*\n\s*expected = hmac\.new\(\s*\n\s*secret\.encode\("utf-8"\),\s*\n\s*payload,\s*\n\s*hashlib\.sha256,\s*\n\s*\)\.hexdigest\(\)/,
    );
    // Accept if computed HMAC matches ANY of the parsed v1= signatures
    // (Stripe-style multi-signature for rotation dual-sign).
    expect(body).toMatch(
      // Candidates are DECODED before comparison — hex is case-insensitive, and
      // comparing the text made this the only SDK of the three to reject an
      // upper-case signature. Still hmac.compare_digest, so still constant-time;
      // invalid hex simply does not match. Cross-SDK parity for the decode lives
      // in cross-sdk-webhook-signature-parity.
      /for sig in parsed\.signature_hexes:[\s\S]{0,200}hmac\.compare_digest\(expected_bytes, candidate\)/,
    );
  });

  it('verify_webhook_signature: kwarg-only surface (body+header+secret+header_prev+tolerance_sec+now_seconds) + V-359 dual-signature rollover (EITHER header OR header_prev passes during 24h grace) + bytes-or-str body coercion + never-raises framing', () => {
    expect(body).toMatch(
      /^def verify_webhook_signature\(\s*\n\s*\*,\s*\n\s*body: bytes \| str,\s*\n\s*header: str \| None,\s*\n\s*secret: str,\s*\n\s*header_prev: str \| None = None,\s*\n\s*tolerance_sec: int = DEFAULT_TOLERANCE_SEC,\s*\n\s*now_seconds: float \| None = None,\s*\n\) -> bool:/m,
    );
    expect(body).toMatch(/"""Verify an inbound webhook signature header\./);
    expect(body).toMatch(/Returns ``True`` iff the header is well-formed, the timestamp is/);
    expect(body).toMatch(/within ``tolerance_sec`` of now, and the HMAC matches in/);
    expect(body).toMatch(/constant time\. Returns ``False`` on any failure mode — never/);
    expect(body).toMatch(/raises\./);
    expect(body).toMatch(/``body`` must be the EXACT raw bytes the server signed\./);
    expect(body).toMatch(/V-359 — ``header_prev`` is an OPTIONAL fallback for a/);
    expect(body).toMatch(/separately-supplied previous-secret signature\. Driftstack does/);
    expect(body).toMatch(/NOT emit a separate header:/);
    expect(body).toMatch(/second ``v1=`` inside the\s*main ``x-driftstack-signature`` header/);
    expect(body).toMatch(/passing ``header`` alone/);
    expect(body).toMatch(/``header`` OR\s*``header_prev`` matching ``secret``\./);
    expect(body).toMatch(
      /body_bytes = body\.encode\("utf-8"\) if isinstance\(body, str\) else bytes\(body\)/,
    );
    expect(body).toMatch(/now = now_seconds if now_seconds is not None else time\.time\(\)/);
    expect(body).toMatch(
      /if _verify_single_header\(header, body_bytes, secret, tolerance_sec, now\):\s*\n\s*return True\s*\n\s*if header_prev is not None and _verify_single_header\(\s*\n\s*header_prev, body_bytes, secret, tolerance_sec, now\s*\n\s*\):\s*\n\s*return True\s*\n\s*return False/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
