// W424.B — drift guard for packages/sdk-typescript/src/webhook-signature.ts.
// Stripe-style HMAC-SHA256 webhook signature verifier. Drift here
// is a security regression: drop the timing-safe compare (timing
// oracle), drop the tolerance check (replay window opens), or drop
// the V-359 prev-header fallback (rotation grace window breaks).
//
//   • Framing pinned: header format `t=<seconds>,v1=<hex>`; payload
//     `<seconds>.<rawBody>`; HMAC-SHA256(secret).
//   • Web Crypto (globalThis.crypto.subtle) — browser-isomorphic.
//   • V-359 prev-header rotation grace window (24h).
//   • DEFAULT_TOLERANCE_SEC = 300 (5 min).
//   • Body accepts string | Uint8Array | ArrayBuffer.
//   • constantTimeHexEq for timing-safe compare.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W424.B packages/sdk-typescript/src/webhook-signature.ts content parity', () => {
  const body = read(LIB);

  it('Header format pinned: Stripe-style `t=<unix-seconds>,v1=<hex hmac>`; HMAC = SHA256(`<unix-seconds>.<raw body>`, `<webhook secret>`)', () => {
    expect(body).toMatch(
      /\/\/ Signature header format \(Stripe-style\): `t=<unix-seconds>,v1=<hex hmac>`\.\s*\n?\s*\/\/ HMAC = SHA256\(`<unix-seconds>\.<raw body>`, `<webhook secret>`\)\./,
    );
  });

  it('Browser-isomorphic framing: uses globalThis.crypto.subtle (Web Crypto API) rather than Node crypto; works in Node 20+ / browsers / Tauri / Workers / Deno / Bun', () => {
    expect(body).toMatch(
      /\/\/ Browser-isomorphic: uses `globalThis\.crypto\.subtle` \(Web Crypto API\)\s*\n?\s*\/\/ rather than Node's `crypto` module\. Works in:\s*\n?\s*\/\/\s*- Node\.js 20\+\s+\(subtle exposed on globalThis\.crypto\)\s*\n?\s*\/\/\s*- Modern browsers \(Chrome 92\+, Firefox 90\+, Safari 15\.4\+, Edge 92\+\)\s*\n?\s*\/\/\s*- Tauri \/ Electron WebViews\s*\n?\s*\/\/\s*- Cloudflare Workers \/ Deno \/ Bun/,
    );
  });

  it('0.1.0 → 0.1.1 async-migration note pinned: callers must await; sub-ms cost negligible', () => {
    expect(body).toMatch(
      /\/\/ NOTE: in 0\.1\.0 this function was sync \(used Node's crypto\)\. In\s*\n?\s*\/\/ 0\.1\.1 it became async because Web Crypto's HMAC API is async\.\s*\n?\s*\/\/ Callers must `await` the result\. The signature verification cost is\s*\n?\s*\/\/ negligible \(sub-millisecond on any modern hardware\) so async-on-the-\s*\n?\s*\/\/ wire doesn't affect throughput\./,
    );
  });

  it('VerifySignatureInput: body union (string|Uint8Array|ArrayBuffer) + header + V-359 headerPrev (24h rotation grace) + secret + toleranceSec + nowMs (test override)', () => {
    expect(body).toMatch(
      /export interface VerifySignatureInput \{\s*\n?\s*body: string \| Uint8Array \| ArrayBuffer;\s*\n?\s*header: string \| string\[\] \| undefined;/,
    );
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*V-359 — optional second signature header for the rotation grace\s*\n?\s*\*\s*window\. Read from `x-driftstack-signature-prev` on the inbound\s*\n?\s*\*\s*request \(Driftstack emits it for 24h after a secret rotation\)\.\s*\n?\s*\*\s*The verifier accepts EITHER `header` OR `headerPrev` matching the\s*\n?\s*\*\s*`secret`, so customers who haven't yet rolled the new secret to\s*\n?\s*\*\s*their verifier still pass during the rotation window\.\s*\n?\s*\*\/\s*\n?\s*headerPrev\?: string \| string\[\] \| undefined;\s*\n?\s*secret: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Reject signatures with timestamps older than this many seconds\. Default 300 \(5 min\)\. \*\/\s*\n?\s*toleranceSec\?: number;\s*\n?\s*\/\*\* Override "now" for testing\. \*\/\s*\n?\s*nowMs\?: number;/,
    );
  });

  it('DEFAULT_TOLERANCE_SEC = 300', () => {
    expect(body).toMatch(/const DEFAULT_TOLERANCE_SEC = 300;/);
  });

  it('verifyWebhookSignature: tries header first; on miss + headerPrev defined, tries headerPrev (V-359 grace); else false', () => {
    expect(body).toMatch(
      /export async function verifyWebhookSignature\(input: VerifySignatureInput\): Promise<boolean> \{\s*\n?\s*const ok = await verifySingleHeader\(input\.header, input\);\s*\n?\s*if \(ok\) return true;/,
    );
    expect(body).toMatch(
      /\/\/ V-359 — fall through to the prev header \(rotation grace\)\. When\s*\n?\s*\/\/ unset this is a no-op; when set the customer accepts either the\s*\n?\s*\/\/ new or the old secret's HMAC during the 24h grace window\./,
    );
    expect(body).toMatch(
      /if \(input\.headerPrev !== undefined\) \{\s*\n?\s*return verifySingleHeader\(input\.headerPrev, input\);\s*\n?\s*\}\s*\n?\s*return false;\s*\n?\s*\}/,
    );
  });

  it('verifySingleHeader: array-or-string header normalization; parse t/v1 with parseSignatureHeader; tolerance check on parsed.timestampMs; bail on missing subtle', () => {
    expect(body).toMatch(
      /async function verifySingleHeader\(\s*\n?\s*rawHeader: string \| string\[\] \| undefined,\s*\n?\s*input: VerifySignatureInput,\s*\n?\s*\): Promise<boolean> \{\s*\n?\s*const headerValue = Array\.isArray\(rawHeader\) \? rawHeader\[0\] : rawHeader;\s*\n?\s*if \(!headerValue \|\| typeof headerValue !== 'string'\) return false;/,
    );
    expect(body).toMatch(/const parsed = parseSignatureHeader\(headerValue\);/);
    expect(body).toMatch(
      /const tolerance = input\.toleranceSec \?\? DEFAULT_TOLERANCE_SEC;\s*\n?\s*const now = input\.nowMs \?\? Date\.now\(\);\s*\n?\s*if \(Math\.abs\(now - parsed\.timestampMs\) > tolerance \* 1000\) \{\s*\n?\s*return false;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const subtle = getSubtleCrypto\(\);\s*\n?\s*if \(!subtle\) return false;/,
    );
  });

  it('HMAC import: SHA-256 key from secret, sign over `<timestamp>.<body>`, hex compare timing-safe', () => {
    expect(body).toMatch(
      /const payload = concatBytes\(enc\.encode\(`\$\{parsed\.timestamp\.toString\(\)\}\.`\), bodyBytes\);/,
    );
    expect(body).toMatch(
      /const key = await subtle\.importKey\(\s*\n?\s*'raw',\s*\n?\s*toArrayBuffer\(enc\.encode\(input\.secret\)\),\s*\n?\s*\{ name: 'HMAC', hash: 'SHA-256' \},\s*\n?\s*false,\s*\n?\s*\['sign'\],\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /const sigBuffer = await subtle\.sign\('HMAC', key, toArrayBuffer\(payload\)\);\s*\n?\s*const expectedHex = bytesToHex\(new Uint8Array\(sigBuffer\)\);\s*\n?\s*return constantTimeHexEq\(expectedHex, parsed\.signatureHex\);/,
    );
  });

  it('parseSignatureHeader: walks comma-separated parts, splits on first =, picks t (Number.isFinite) + v1 (raw); returns null if missing either', () => {
    expect(body).toMatch(
      /function parseSignatureHeader\(\s*\n?\s*header: string,\s*\n?\s*\): \{ timestamp: number; timestampMs: number; signatureHex: string \} \| null \{/,
    );
    expect(body).toMatch(
      /for \(const part of header\.split\(','\)\) \{\s*\n?\s*const eq = part\.indexOf\('='\);\s*\n?\s*if \(eq < 0\) continue;\s*\n?\s*const k = part\.slice\(0, eq\)\.trim\(\);\s*\n?\s*const v = part\.slice\(eq \+ 1\)\.trim\(\);\s*\n?\s*if \(k === 't'\) \{\s*\n?\s*const n = Number\(v\);\s*\n?\s*if \(Number\.isFinite\(n\)\) timestamp = n;\s*\n?\s*\} else if \(k === 'v1'\) \{\s*\n?\s*signature = v;\s*\n?\s*\}\s*\n?\s*\}\s*\n?\s*if \(timestamp === null \|\| signature === null\) return null;\s*\n?\s*return \{ timestamp, timestampMs: timestamp \* 1000, signatureHex: signature \};/,
    );
  });

  it('toBodyBytes: string→TextEncoder, Uint8Array passthrough, ArrayBuffer→new Uint8Array', () => {
    expect(body).toMatch(
      /function toBodyBytes\(body: string \| Uint8Array \| ArrayBuffer\): Uint8Array \{\s*\n?\s*if \(typeof body === 'string'\) return new TextEncoder\(\)\.encode\(body\);\s*\n?\s*if \(body instanceof Uint8Array\) return body;\s*\n?\s*return new Uint8Array\(body\);\s*\n?\s*\}/,
    );
  });

  it('concatBytes: a-then-b new Uint8Array (no SharedArrayBuffer concerns)', () => {
    expect(body).toMatch(
      /function concatBytes\(a: Uint8Array, b: Uint8Array\): Uint8Array \{\s*\n?\s*const out = new Uint8Array\(a\.length \+ b\.length\);\s*\n?\s*out\.set\(a, 0\);\s*\n?\s*out\.set\(b, a\.length\);\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it('toArrayBuffer: copy Uint8Array → fresh ArrayBuffer (WebCrypto rejects SAB-backed inputs)', () => {
    expect(body).toMatch(
      /\/\*\* Copy a Uint8Array's contents into a fresh ArrayBuffer\. WebCrypto\s*\n?\s*\*\s*rejects SharedArrayBuffer-backed inputs and the TS lib types\s*\n?\s*\*\s*differentiate them from ArrayBuffer; this normalises both\. \*\//,
    );
    expect(body).toMatch(
      /function toArrayBuffer\(bytes: Uint8Array\): ArrayBuffer \{\s*\n?\s*const out = new ArrayBuffer\(bytes\.byteLength\);\s*\n?\s*new Uint8Array\(out\)\.set\(bytes\);\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it("HEX_LOOKUP '0123456789abcdef' + bytesToHex manual encoder (avoiding Buffer/toHex compat caveats)", () => {
    expect(body).toMatch(/const HEX_LOOKUP = '0123456789abcdef';/);
    expect(body).toMatch(
      /\/\/ Manual hex encoding — both `Buffer\.from\(\.\.\.\)\.toString\('hex'\)`\s*\n?\s*\/\/ \(Node-only\) and `bytes\.toHex\(\)` \(Stage 3 proposal, not in Tauri's\s*\n?\s*\/\/ WebView\) would have wider browser-compat caveats\. This loop is\s*\n?\s*\/\/ ~10 ns per byte and fine for the ~32-byte HMAC output\./,
    );
    expect(body).toMatch(
      /function bytesToHex\(bytes: Uint8Array\): string \{[\s\S]+?out \+= HEX_LOOKUP\[b >> 4\];\s*\n?\s*out \+= HEX_LOOKUP\[b & 0xf\];/,
    );
  });

  it('hexToBytes + parseHexNibble (0-9, a-f, A-F); reject odd-length or non-hex with null', () => {
    expect(body).toMatch(
      /function hexToBytes\(hex: string\): Uint8Array \| null \{\s*\n?\s*if \(hex\.length % 2 !== 0\) return null;/,
    );
    expect(body).toMatch(
      /function parseHexNibble\(code: number\): number \{\s*\n?\s*if \(code >= 48 && code <= 57\) return code - 48; \/\/ 0-9\s*\n?\s*if \(code >= 97 && code <= 102\) return code - 87; \/\/ a-f\s*\n?\s*if \(code >= 65 && code <= 70\) return code - 55; \/\/ A-F\s*\n?\s*return -1;\s*\n?\s*\}/,
    );
  });

  it('constantTimeHexEq: length check + XOR diff accumulator (timing-safe — no early return on first mismatch)', () => {
    expect(body).toMatch(
      /function constantTimeHexEq\(a: string, b: string\): boolean \{\s*\n?\s*if \(a\.length !== b\.length\) return false;\s*\n?\s*const ab = hexToBytes\(a\);\s*\n?\s*const bb = hexToBytes\(b\);\s*\n?\s*if \(ab === null \|\| bb === null\) return false;\s*\n?\s*if \(ab\.length !== bb\.length\) return false;\s*\n?\s*let diff = 0;\s*\n?\s*for \(let i = 0; i < ab\.length; i\+\+\) \{\s*\n?\s*diff \|= \(ab\[i\] as number\) \^ \(bb\[i\] as number\);\s*\n?\s*\}\s*\n?\s*return diff === 0;\s*\n?\s*\}/,
    );
  });

  it('getSubtleCrypto: defensive probe of globalThis.crypto + subtle, returns null when absent', () => {
    expect(body).toMatch(
      /function getSubtleCrypto\(\): SubtleCrypto \| null \{\s*\n?\s*\/\/ `globalThis\.crypto` exists in Node 20\+ \(still gated by Node-version\s*\n?\s*\/\/ policies\) and every browser environment we ship into\. Defensively\s*\n?\s*\/\/ probe rather than assume\.\s*\n?\s*const c = globalThis\.crypto;\s*\n?\s*if \(!c \|\| !c\.subtle\) return null;\s*\n?\s*return c\.subtle;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
