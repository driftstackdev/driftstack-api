// W816 — cross-SDK webhook-signature parity. One-hundred-forty-second
// in the drift-guard series. Pins the 3 SDK webhook-signature
// verifier implementations in lockstep. Drift in the header format,
// HMAC algorithm, or tolerance window would silently break inbound
// webhook receivers across the entire customer fleet — exactly the
// failure mode the W799 webhook-receiver examples defend against.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/webhook_signature.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go');

describe('W816 cross-SDK webhook-signature parity', () => {
  it('all 3 webhook-signature implementations exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── Header format: Stripe-style t=<unix>,v1=<hex> ────────────

  it("CRITICAL all 3 implementations document the Stripe-style header format — 't=<unix-seconds>,v1=<hex hmac>'. Drift to a different format would break every webhook receiver simultaneously.", () => {
    expect(read(TS)).toMatch(
      /Signature header format \(Stripe-style\): `t=<unix-seconds>,v1=<hex hmac>`\./,
    );
    expect(read(PY)).toMatch(
      /Header format \(Stripe-style\): ``t=<unix-seconds>,v1=<hex hmac>``\./,
    );
    expect(read(GO)).toMatch(/Header format \(Stripe-style\): t=<unix-seconds>,v1=<hex hmac>\./);
  });

  // ─── HMAC-SHA256(<unix>.<body>, secret) ───────────────────────

  it('CRITICAL all 3 implementations document the canonical HMAC formula — HMAC-SHA256(<unix-seconds>.<raw body>, <secret>). Drift to a different hash (SHA1, SHA512) or different concatenation would silently break signature verification.', () => {
    expect(read(TS)).toMatch(/HMAC = SHA256\(`<unix-seconds>\.<raw body>`, `<webhook secret>`\)\./);
    expect(read(PY)).toMatch(
      /HMAC = HMAC-SHA256\(``<unix-seconds>\.<raw body>``, ``<secret>``\)\./,
    );
    expect(read(GO)).toMatch(
      /HMAC = HMAC-SHA256\(<unix-seconds>\.<raw body>, <webhook secret>\)\./,
    );
  });

  // ─── V-359 dual-signature rotation grace ──────────────────────

  it('CRITICAL all 3 implementations support the V-359 headerPrev / HeaderPrev / header_prev fallback input AND accurately state Driftstack does NOT emit a separate header (prev HMAC is a second v1= inside the main x-driftstack-signature header). The fallback stays for backward-compat; drift back to claiming a separate prev header is emitted would contradict the corrected customer docs.', () => {
    expect(read(TS)).toMatch(/V-359 — OPTIONAL fallback for a separately-supplied previous-secret/);
    expect(read(TS)).toMatch(/headerPrev\?: string \| string\[\] \| undefined;/);
    expect(read(TS)).toMatch(/Driftstack does NOT emit a separate header:/);
    expect(read(PY)).toMatch(/Mirrors :func:`verifyWebhookSignature` from the TypeScript SDK/);
    expect(read(PY)).toMatch(/Driftstack does\s*\n\s*NOT emit a separate header:/);
    expect(read(GO)).toMatch(
      /HeaderPrev is an OPTIONAL fallback for a separately-supplied\s*\n\s+\/\/ previous-secret signature\. Driftstack does NOT emit a separate/,
    );
  });

  it("CRITICAL all 3 implementations document the 'accept EITHER header OR headerPrev' fallback logic. The dual-accept stays for backward-compat, but passing `header` alone already verifies rotation deliveries.", () => {
    expect(read(TS)).toMatch(
      /accepts EITHER\s*\n\s+\* `header` OR `headerPrev` matching the `secret`\./,
    );
    expect(read(GO)).toMatch(/accepts EITHER `header` OR `HeaderPrev` matching `secret`\. V-359\./);
  });

  // ─── 300s tolerance default ───────────────────────────────────

  it("CRITICAL all 3 implementations default tolerance = 300 seconds (5 minutes). TS: 'Default 300 (5 min)'; Python: 'DEFAULT_TOLERANCE_SEC = 300'; Go: 'DefaultWebhookTolerance = 5 * time.Minute'. Drift to a different tolerance would let stale timestamps through (security) or reject valid ones (false 401s).", () => {
    expect(read(TS)).toMatch(
      /Reject signatures with timestamps older than this many seconds\. Default 300 \(5 min\)/,
    );
    expect(read(PY)).toMatch(/^DEFAULT_TOLERANCE_SEC = 300$/m);
    expect(read(GO)).toMatch(/const DefaultWebhookTolerance = 5 \* time\.Minute/);
  });

  // ─── Constant-time HMAC compare ───────────────────────────────

  it("CRITICAL Go implementation pins 'HMAC matches in constant time' framing. The constant-time-compare is a load-bearing security property that prevents timing attacks against the signature.", () => {
    expect(read(GO)).toMatch(/the HMAC matches in constant time\./);
  });

  it("CRITICAL Go implementation 'Never panics; returns false on any failure mode' framing pinned. Defensive shape — every error path must return false, never throw or panic. Drift to throwing would crash receiver processes.", () => {
    expect(read(GO)).toMatch(/Never panics;\s*\n\/\/ returns false on any failure mode\./);
  });

  // ─── TS browser-isomorphic Web Crypto framing ─────────────────

  it("CRITICAL TS implementation pins browser-isomorphic Web Crypto API design. The 'uses globalThis.crypto.subtle (Web Crypto API) rather than Node's crypto module' framing is the load-bearing 'works in 6 runtimes' guarantee — Node 20+ + Modern browsers + Tauri + Cloudflare Workers + Deno + Bun.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /Browser-isomorphic: uses `globalThis\.crypto\.subtle` \(Web Crypto API\)\s*\n\/\/ rather than Node's `crypto` module\./,
    );
    expect(p).toMatch(/Node\.js 20\+/);
    expect(p).toMatch(/Modern browsers \(Chrome 92\+, Firefox 90\+, Safari 15\.4\+, Edge 92\+\)/);
    expect(p).toMatch(/Tauri \/ Electron WebViews/);
    expect(p).toMatch(/Cloudflare Workers \/ Deno \/ Bun/);
  });

  it("CRITICAL TS implementation pins the 0.1.0 → 0.1.1 async migration note. 'in 0.1.0 this function was sync (used Node's crypto). In 0.1.1 it became async because Web Crypto's HMAC API is async. Callers must await the result.' This is the load-bearing breaking-change-notice that prevents customers from missing the await on upgrade.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /NOTE: in 0\.1\.0 this function was sync \(used Node's crypto\)\. In\s*\n\/\/ 0\.1\.1 it became async because Web Crypto's HMAC API is async\./,
    );
    expect(p).toMatch(/Callers must `await` the result\./);
    expect(p).toMatch(
      /The signature verification cost is\s*\n\/\/ negligible \(sub-millisecond on any modern hardware\)/,
    );
  });

  // ─── VerifySignatureInput / VerifyWebhookOptions shape ────────

  it('CRITICAL TS VerifySignatureInput shape pinned — body (string | Uint8Array | ArrayBuffer) + header (string | string[] | undefined) + headerPrev (optional) + secret (string) + toleranceSec (optional) + nowMs (optional override for testing). The 3-body-type union is what makes TS isomorphic across Node + browser receivers.', () => {
    const p = read(TS);
    expect(p).toMatch(/export interface VerifySignatureInput \{/);
    expect(p).toMatch(/body: string \| Uint8Array \| ArrayBuffer;/);
    expect(p).toMatch(/header: string \| string\[\] \| undefined;/);
    expect(p).toMatch(/secret: string;/);
    expect(p).toMatch(/toleranceSec\?: number;/);
    expect(p).toMatch(/nowMs\?: number;/);
  });

  it('CRITICAL Go VerifyWebhookOptions shape pinned — Tolerance (time.Duration) + Now (time.Time override) + HeaderPrev (V-359). Drift to a different shape would break customer Verify*() calls.', () => {
    const p = read(GO);
    expect(p).toMatch(/type VerifyWebhookOptions struct \{/);
    expect(p).toMatch(/Tolerance time\.Duration/);
    expect(p).toMatch(/Now time\.Time/);
    expect(p).toMatch(/HeaderPrev string/);
  });

  // ─── Python _ParsedSignature internal dataclass ───────────────

  it("CRITICAL Python _ParsedSignature internal dataclass pinned — timestamp_seconds: int + signature_hexes: list[str] (Stripe-style multi-signature; collects every v1= for rotation dual-sign). The leading-underscore + dataclass pattern is the canonical 'this is parser-internal, not public API' convention.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /@dataclass\s*\nclass _ParsedSignature:\s*\n\s+timestamp_seconds: int\s*\n\s+signature_hexes: list\[str\]/,
    );
  });

  // ─── Cross-SDK example usage in docstrings ────────────────────

  it("CRITICAL each implementation includes a copy-pasteable example in its docstring. TS: app.post('/driftstack-webhook', ...). Python: @app.post('/driftstack-webhook'). All 3 use 'x-driftstack-signature' header + 'DRIFTSTACK_WEBHOOK_SECRET' env-var + 401 on bad sig — matching the W799 cross-SDK webhook-receiver example.", () => {
    expect(read(TS)).toMatch(/app\.post\('\/driftstack-webhook', async \(req, res\)/);
    expect(read(TS)).toMatch(/process\.env\.DRIFTSTACK_WEBHOOK_SECRET/);
    expect(read(PY)).toMatch(/@app\.post\("\/driftstack-webhook"\)/);
    expect(read(PY)).toMatch(/os\.environ\["DRIFTSTACK_WEBHOOK_SECRET"\]/);
    // All 3 reference x-driftstack-signature header.
    for (const f of [TS, PY]) {
      expect(read(f)).toMatch(/x-driftstack-signature/i);
    }
  });

  // ─── Go-specific hmac + sha256 + hex stdlib imports ───────────

  it("CRITICAL Go implementation uses stdlib crypto/hmac + crypto/sha256 + encoding/hex (no external dependencies). Matches the 'zero non-stdlib runtime dependencies' Go SDK promise (W813 + W814).", () => {
    const p = read(GO);
    expect(p).toMatch(/^\s*"crypto\/hmac"$/m);
    expect(p).toMatch(/^\s*"crypto\/sha256"$/m);
    expect(p).toMatch(/^\s*"encoding\/hex"$/m);
    // No imports from non-stdlib paths.
    expect(p).not.toMatch(/"github\.com\/[^"]+\/(?!driftstackdev)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-webhook-signature-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
