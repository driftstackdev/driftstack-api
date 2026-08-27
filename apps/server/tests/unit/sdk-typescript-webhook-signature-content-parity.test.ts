// W424.B (W674-deepened) — drift guard for packages/sdk-typescript/
// src/webhook-signature.ts. Stripe-style HMAC-SHA256 webhook
// signature verifier — security-critical.
//
// W674 splits the original 17 it() blocks into 23 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • Stripe-style header format `t=<unix-seconds>,v1=<hex hmac>` +
//     HMAC payload `<unix-seconds>.<raw body>` keyed by webhook
//     secret. Drift to a different separator or hash would silently
//     reject ALL legitimate signatures.
//   • CRITICAL V-359 prev-header rotation grace — 24h window where
//     EITHER header OR headerPrev matching secret passes. Drift to
//     dropping the OR fallback would force customers to roll the
//     new secret to their verifier BEFORE Driftstack stopped dual-
//     signing (breaking the rotation contract).
//   • Browser-isomorphic Web Crypto — 5 supported runtimes pinned
//     (Node 20+ / browsers / Tauri/Electron / Workers / Deno/Bun).
//     Drift to Node-only `crypto` would break browser usage.
//   • 0.1.0 → 0.1.1 sync→async migration note — drift to dropping
//     would lose the breaking-change rationale.
//   • DEFAULT_TOLERANCE_SEC = 300 (5 min) + BIDIRECTIONAL clock-skew
//     via Math.abs(now - parsed.timestampMs) > tolerance*1000.
//     CRITICAL: `Math.abs` is what catches BOTH past-stale AND
//     future-clock-skew (drift to one-sided `now - timestampMs >`
//     would let future-dated signatures slip through).
//   • Web Crypto importKey + sign — raw secret bytes + SHA-256 +
//     ["sign"] usage list + non-extractable (`extractable: false`).
//   • constantTimeHexEq — XOR diff accumulator (NO early return on
//     first mismatch). Drift to early-return would leak timing.
//   • parseSignatureHeader — t/v1 walk with unknown-keys-silently-
//     skipped (forward-compat with future v2/v3 versions).
//   • Body union (string | Uint8Array | ArrayBuffer) — 3-case
//     normalization in toBodyBytes.
//   • toArrayBuffer SharedArrayBuffer-safety — WebCrypto rejects
//     SAB-backed Uint8Array. Drift to passing bytes.buffer
//     directly would crash on Node 20+ in worker_threads.
//   • bytesToHex manual encoder — avoids Buffer.toString("hex")
//     (Node-only) + bytes.toHex() (Stage 3 proposal not in Tauri).

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

  it('file exists at canonical path + CRITICAL Stripe-style header format pinned per-line: "t=<unix-seconds>,v1=<hex hmac>" + HMAC payload "SHA256(<unix-seconds>.<raw body>, <webhook secret>)". Drift to a different separator (`.` vs `,`) or hash (SHA512 vs SHA256) would silently reject ALL legitimate signatures.', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ Signature header format \(Stripe-style\): `t=<unix-seconds>,v1=<hex hmac>`\.\s*\/\/ HMAC = SHA256\(`<unix-seconds>\.<raw body>`, `<webhook secret>`\)\./,
    );
  });

  it('Browser-isomorphic framing — 5 supported runtimes pinned per-line: Node.js 20+ + Modern browsers (Chrome 92+/Firefox 90+/Safari 15.4+/Edge 92+) + Tauri/Electron WebViews + Cloudflare Workers/Deno/Bun. Drift to dropping any runtime would silently exclude that environment from the support matrix.', () => {
    expect(body).toMatch(
      /\/\/ Browser-isomorphic: uses `globalThis\.crypto\.subtle` \(Web Crypto API\)\s*\/\/ rather than Node's `crypto` module\. Works in:\s*\/\/\s*- Node\.js 20\+\s+\(subtle exposed on globalThis\.crypto\)\s*\/\/\s*- Modern browsers \(Chrome 92\+, Firefox 90\+, Safari 15\.4\+, Edge 92\+\)\s*\/\/\s*- Tauri \/ Electron WebViews\s*\/\/\s*- Cloudflare Workers \/ Deno \/ Bun/,
    );
  });

  it('JSDoc usage example pinned — Express-style handler with `req.rawBody` + `x-driftstack-signature` header + 401 on verify-fail. The `req.rawBody` (NOT `req.body`) wording is load-bearing because customers who pass the JSON-parsed body would compute a different HMAC.', () => {
    expect(body).toMatch(/import \{ verifyWebhookSignature \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/app\.post\('\/driftstack-webhook', async \(req, res\) => \{/);
    expect(body).toMatch(/body: req\.rawBody,/);
    expect(body).toMatch(/header: sig,/);
    expect(body).toMatch(/if \(!ok\) return res\.status\(401\)\.end\(\);/);
  });

  it('CRITICAL 0.1.0 → 0.1.1 sync→async migration note pinned per-line. The Web Crypto HMAC API IS async (vs Node\'s sync crypto), so the function HAD to become async. "Callers must `await` the result" + sub-millisecond cost rationale pinned. Drift to dropping would lose the breaking-change explanation for customers upgrading from 0.1.0.', () => {
    expect(body).toMatch(
      /\/\/ NOTE: in 0\.1\.0 this function was sync \(used Node's crypto\)\. In\s*\/\/ 0\.1\.1 it became async because Web Crypto's HMAC API is async\.\s*\/\/ Callers must `await` the result\. The signature verification cost is\s*\/\/ negligible \(sub-millisecond on any modern hardware\) so async-on-the-\s*\/\/ wire doesn't affect throughput\./,
    );
  });

  it("VerifySignatureInput body field — 3-type union (string | Uint8Array | ArrayBuffer). Drift to widening to `unknown` would lose static-type checking; drift to narrowing to just `string` would force customers to manually decode binary bodies (which is exactly what they'd get wrong, computing a different HMAC).", () => {
    expect(body).toMatch(
      /export interface VerifySignatureInput \{\s*body: string \| Uint8Array \| ArrayBuffer;\s*header: string \| string\[\] \| undefined;/,
    );
  });

  it('CRITICAL V-359 headerPrev JSDoc — accuracy invariant: it is an OPTIONAL fallback for a separately-supplied previous-secret signature, Driftstack does NOT emit a separate header (prev HMAC is a second v1= inside the main x-driftstack-signature header), and the verifier accepts EITHER header OR headerPrev matching the secret. Drift back to claiming a separate `x-driftstack-signature-prev` header is emitted would contradict the corrected customer docs.', () => {
    expect(body).toMatch(/\* V-359 — OPTIONAL fallback for a separately-supplied previous-secret/);
    expect(body).toMatch(/\* signature\. Driftstack does NOT emit a separate header:/);
    expect(body).toMatch(/\* second `v1=` inside the main `x-driftstack-signature` header/);
    expect(body).toMatch(/\* passing `header` alone verifies rotation deliveries correctly and/);
    expect(body).toMatch(/\* `header` OR `headerPrev` matching the `secret`\./);
    expect(body).toMatch(/headerPrev\?: string \| string\[\] \| undefined;\s*secret: string;/);
  });

  it('toleranceSec + nowMs fields — JSDoc "Reject signatures with timestamps older than this many seconds. Default 300 (5 min)." + "Override `now` for testing." pinned. Drift to dropping the default-300 mention would lose customer-facing value; drift to a higher default would widen the replay window.', () => {
    expect(body).toMatch(
      /\/\*\* Reject signatures with timestamps older than this many seconds\. Default 300 \(5 min\)\. \*\/\s*toleranceSec\?: number;\s*\/\*\* Override "now" for testing\. \*\/\s*nowMs\?: number;/,
    );
  });

  it('CRITICAL DEFAULT_TOLERANCE_SEC = 300 (5 min). Drift to a longer window would widen the replay attack surface; drift to a shorter window would make legitimate webhooks fail on slow networks.', () => {
    expect(body).toMatch(/const DEFAULT_TOLERANCE_SEC = 300;/);
  });

  it('CRITICAL verifyWebhookSignature flow — an empty-secret refusal FIRST (V-2010), then a 3-step short-circuit: (1) try `header` via verifySingleHeader → return true on match; (2) if NOT matched AND `headerPrev !== undefined` → try `headerPrev`; (3) else return false. The `!== undefined` check (NOT `headerPrev ?? falsy`) is load-bearing — customers passing `headerPrev: ""` should still hit the fallback.', () => {
    expect(body).toMatch(
      /export async function verifyWebhookSignature\(input: VerifySignatureInput\): Promise<boolean> \{/,
    );
    // V-2010 — pinned on its own line rather than folded into the flow regex: an
    // empty secret made Python and Go verify an attacker-computed HMAC, and made
    // this one throw out of subtle.importKey. Kept as a separate assertion so the
    // short-circuit chain below stays legible.
    expect(body).toContain('if (input.secret.length === 0) return false;');
    expect(body).toMatch(
      /const ok = await verifySingleHeader\(input\.header, input\);\s*if \(ok\) return true;/,
    );
    expect(body).toMatch(
      /\/\/ V-359 — fall through to the prev header \(rotation grace\)\. When\s*\/\/ unset this is a no-op; when set the customer accepts either the\s*\/\/ new or the old secret's HMAC during the 24h grace window\./,
    );
    expect(body).toMatch(
      /if \(input\.headerPrev !== undefined\) \{\s*return verifySingleHeader\(input\.headerPrev, input\);\s*\}\s*return false;\s*\}/,
    );
  });

  it('verifySingleHeader header normalization — `Array.isArray(rawHeader) ? rawHeader[0] : rawHeader`. CRITICAL: Node\'s req.headers can be either string OR string[] (when multiple headers with the same name are sent). Drift to `.join(",")` would silently concatenate them into one invalid header.', () => {
    expect(body).toMatch(
      /async function verifySingleHeader\(\s*rawHeader: string \| string\[\] \| undefined,\s*input: VerifySignatureInput,\s*\): Promise<boolean> \{\s*const headerValue = Array\.isArray\(rawHeader\) \? rawHeader\[0\] : rawHeader;\s*if \(!headerValue \|\| typeof headerValue !== 'string'\) return false;/,
    );
    expect(body).toMatch(/const parsed = parseSignatureHeader\(headerValue\);/);
  });

  it('CRITICAL bidirectional clock-skew check — `if (Math.abs(now - parsed.timestampMs) > tolerance * 1000) return false`. The `Math.abs` is load-bearing — it catches BOTH past-stale (replay) AND future-clock-skew (attacker forging a timestamp far in the future). Drift to one-sided `now - timestampMs >` would let future-dated signatures slip through; drift to `now < parsed.timestampMs` would invert the check.', () => {
    expect(body).toMatch(
      /const tolerance = input\.toleranceSec \?\? DEFAULT_TOLERANCE_SEC;\s*const now = input\.nowMs \?\? Date\.now\(\);\s*if \(Math\.abs\(now - parsed\.timestampMs\) > tolerance \* 1000\) \{\s*return false;\s*\}/,
    );
  });

  it('CRITICAL getSubtleCrypto defensive probe — `if (!subtle) return false` early-bail. Drift to throwing would break customers running on legacy Node 18 (still without subtle); drift to crashing would mask the failure mode behind an unhandled rejection.', () => {
    expect(body).toMatch(/const subtle = getSubtleCrypto\(\);\s*if \(!subtle\) return false;/);
  });

  it('CRITICAL HMAC payload construction — `concatBytes(enc.encode(`${parsed.timestamp.toString()}.`), bodyBytes)`. The `.toString()` is load-bearing — Number gets coerced to string via template-literal but the explicit toString() makes the intent clear AND defends against future TS strict-mode complaints. The `${ts}.${body}` separator is the Stripe-style format; drift would break server-side verification.', () => {
    expect(body).toMatch(
      /const payload = concatBytes\(enc\.encode\(`\$\{parsed\.timestamp\.toString\(\)\}\.`\), bodyBytes\);/,
    );
  });

  it('CRITICAL importKey call — 5 args: raw + secret bytes + HMAC/SHA-256 algorithm + `false` (NON-EXTRACTABLE) + ["sign"] usage list. The `false` is what prevents the key from being exfiltrated via subtle.exportKey; drift to `true` would let a future bug exfiltrate the customer\'s webhook secret. The ["sign"] usage list is exact — drift to ["sign", "verify"] would broaden the key\'s capabilities unnecessarily.', () => {
    expect(body).toMatch(
      /const key = await subtle\.importKey\(\s*'raw',\s*toArrayBuffer\(enc\.encode\(input\.secret\)\),\s*\{ name: 'HMAC', hash: 'SHA-256' \},\s*false,\s*\['sign'\],\s*\);/,
    );
  });

  it('sign + hex + compare — subtle.sign("HMAC", key, payload) → bytesToHex(new Uint8Array(sigBuffer)) → accept if the computed HMAC matches ANY of parsed.signatureHexes (constant-time per candidate). The `new Uint8Array(sigBuffer)` wrap is necessary because subtle.sign returns ArrayBuffer. Drift to direct comparison (===) would leak timing; the multi-`v1` `.some()` is load-bearing for rotation dual-sign (server emits t=,v1=<new>,v1=<old>).', () => {
    expect(body).toMatch(
      /const sigBuffer = await subtle\.sign\('HMAC', key, toArrayBuffer\(payload\)\);/,
    );
    expect(body).toMatch(/const expectedHex = bytesToHex\(new Uint8Array\(sigBuffer\)\);/);
    expect(body).toMatch(
      /return parsed\.signatureHexes\.some\(\(sig\) => constantTimeHexEq\(expectedHex, sig\)\);/,
    );
  });

  it('CRITICAL parseSignatureHeader — walks comma-separated parts, splits on FIRST `=` (`indexOf("=")` + `slice`). Unknown keys silently skipped (forward-compat with future v2/v3). Number.isFinite guard on `t` rejects "abc"/"NaN". Collects ALL `v1=` (non-empty) into signatureHexes[] for Stripe-style multi-signature / rotation dual-sign. Returns null when timestamp missing OR zero signatures.', () => {
    expect(body).toMatch(
      /\): \{ timestamp: number; timestampMs: number; signatureHexes: string\[\] \} \| null \{/,
    );
    expect(body).toMatch(/const signatures: string\[\] = \[\];/);
    expect(body).toMatch(/\} else if \(k === 'v1' && v\.length > 0\) \{\s*signatures\.push\(v\);/);
    expect(body).toMatch(/if \(timestamp === null \|\| signatures\.length === 0\) return null;/);
    expect(body).toMatch(
      /return \{ timestamp, timestampMs: timestamp \* 1000, signatureHexes: signatures \};/,
    );
  });

  it('toBodyBytes 3-case normalization — string → TextEncoder.encode; Uint8Array → passthrough; ArrayBuffer → `new Uint8Array(body)` view. CRITICAL ordering: string check FIRST (typeof === "string") because TextEncoder is the most common case, then Uint8Array via instanceof, then ArrayBuffer as the fallback. Drift to checking ArrayBuffer first would force every string to flow through Uint8Array.from on encoded bytes.', () => {
    expect(body).toMatch(
      /function toBodyBytes\(body: string \| Uint8Array \| ArrayBuffer\): Uint8Array \{\s*if \(typeof body === 'string'\) return new TextEncoder\(\)\.encode\(body\);\s*if \(body instanceof Uint8Array\) return body;\s*return new Uint8Array\(body\);\s*\}/,
    );
  });

  it('concatBytes — fresh Uint8Array allocation + 2 set() calls (a at offset 0, b at offset a.length). Drift to Buffer.concat would break browser-isomorphic invariant; drift to TypedArray.set with overlapping ranges would corrupt the payload.', () => {
    expect(body).toMatch(
      /function concatBytes\(a: Uint8Array, b: Uint8Array\): Uint8Array \{\s*const out = new Uint8Array\(a\.length \+ b\.length\);\s*out\.set\(a, 0\);\s*out\.set\(b, a\.length\);\s*return out;\s*\}/,
    );
  });

  it('CRITICAL toArrayBuffer SharedArrayBuffer-safety helper — "WebCrypto rejects SharedArrayBuffer-backed inputs and the TS lib types differentiate them from ArrayBuffer; this normalises both." Copies bytes into a FRESH ArrayBuffer. Drift to passing `bytes.buffer` directly would crash on Node 20+ when called from worker_threads (where Uint8Array.buffer can be SAB-backed).', () => {
    expect(body).toMatch(
      /\/\*\* Copy a Uint8Array's contents into a fresh ArrayBuffer\. WebCrypto\s*\*\s*rejects SharedArrayBuffer-backed inputs and the TS lib types\s*\*\s*differentiate them from ArrayBuffer; this normalises both\. \*\//,
    );
    expect(body).toMatch(
      /function toArrayBuffer\(bytes: Uint8Array\): ArrayBuffer \{\s*const out = new ArrayBuffer\(bytes\.byteLength\);\s*new Uint8Array\(out\)\.set\(bytes\);\s*return out;\s*\}/,
    );
  });

  it('CRITICAL bytesToHex manual encoder + rationale pinned. "Manual hex encoding — both Buffer.from(...).toString(\'hex\') (Node-only) and bytes.toHex() (Stage 3 proposal, not in Tauri\'s WebView) would have wider browser-compat caveats. This loop is ~10 ns per byte and fine for the ~32-byte HMAC output." HEX_LOOKUP = "0123456789abcdef" (LOWERCASE only — drift to uppercase would break Stripe-style hex compatibility).', () => {
    expect(body).toMatch(/const HEX_LOOKUP = '0123456789abcdef';/);
    expect(body).toMatch(
      /\/\/ Manual hex encoding — both `Buffer\.from\(\.\.\.\)\.toString\('hex'\)`\s*\/\/ \(Node-only\) and `bytes\.toHex\(\)` \(Stage 3 proposal, not in Tauri's\s*\/\/ WebView\) would have wider browser-compat caveats\. This loop is\s*\/\/ ~10 ns per byte and fine for the ~32-byte HMAC output\./,
    );
    expect(body).toMatch(
      /function bytesToHex\(bytes: Uint8Array\): string \{[\s\S]+?out \+= HEX_LOOKUP\[b >> 4\];\s*out \+= HEX_LOOKUP\[b & 0xf\];/,
    );
  });

  it('hexToBytes + parseHexNibble — case-insensitive (accepts 0-9 AND a-f AND A-F). Rejects odd-length strings (`hex.length % 2 !== 0`) + non-hex chars (parseHexNibble returns -1). The 3-range character-code check (48-57 + 97-102 + 65-70) is the fastest constant-time way to validate hex without a regex.', () => {
    expect(body).toMatch(
      /function hexToBytes\(hex: string\): Uint8Array \| null \{\s*if \(hex\.length % 2 !== 0\) return null;/,
    );
    expect(body).toMatch(
      /function parseHexNibble\(code: number\): number \{\s*if \(code >= 48 && code <= 57\) return code - 48; \/\/ 0-9\s*if \(code >= 97 && code <= 102\) return code - 87; \/\/ a-f\s*if \(code >= 65 && code <= 70\) return code - 55; \/\/ A-F\s*return -1;\s*\}/,
    );
  });

  it('CRITICAL constantTimeHexEq — XOR diff accumulator with NO EARLY RETURN. Drift to early-return on first byte-mismatch would leak timing oracle: attacker could brute-force the HMAC byte-by-byte by measuring response time. The `diff |= ab[i] ^ bb[i]` pattern OR-accumulates ALL differences, returning diff===0 at the end regardless of where the mismatch was.', () => {
    expect(body).toMatch(
      /function constantTimeHexEq\(a: string, b: string\): boolean \{\s*if \(a\.length !== b\.length\) return false;\s*const ab = hexToBytes\(a\);\s*const bb = hexToBytes\(b\);\s*if \(ab === null \|\| bb === null\) return false;\s*if \(ab\.length !== bb\.length\) return false;\s*let diff = 0;\s*for \(let i = 0; i < ab\.length; i\+\+\) \{\s*diff \|= \(ab\[i\] as number\) \^ \(bb\[i\] as number\);\s*\}\s*return diff === 0;\s*\}/,
    );
  });

  it('getSubtleCrypto helper — defensive probe rationale pinned: "`globalThis.crypto` exists in Node 20+ (still gated by Node-version policies) and every browser environment we ship into. Defensively probe rather than assume." Returns null on absence so verifyWebhookSignature can short-circuit to false without crashing.', () => {
    expect(body).toMatch(
      /function getSubtleCrypto\(\): SubtleCrypto \| null \{\s*\/\/ `globalThis\.crypto` exists in Node 20\+ \(still gated by Node-version\s*\/\/ policies\) and every browser environment we ship into\. Defensively\s*\/\/ probe rather than assume\.\s*const c = globalThis\.crypto;\s*if \(!c \|\| !c\.subtle\) return null;\s*return c\.subtle;\s*\}/,
    );
  });

  it('Export inventory — exactly 2 public exports (VerifySignatureInput interface + verifyWebhookSignature function). 8 internal helpers stay non-exported (verifySingleHeader / parseSignatureHeader / toBodyBytes / concatBytes / toArrayBuffer / bytesToHex / hexToBytes / parseHexNibble / constantTimeHexEq / getSubtleCrypto). Drift to exporting internals would broaden the public surface.', () => {
    const exportMatches = body.match(/^export /gm) ?? [];
    expect(exportMatches.length, 'expected exactly 2 exports').toBe(2);
    expect(body).toMatch(/export interface VerifySignatureInput/);
    expect(body).toMatch(/export async function verifyWebhookSignature/);
    // Internal helpers MUST NOT be exported.
    expect(body).not.toMatch(/^export (?:async )?function verifySingleHeader/m);
    expect(body).not.toMatch(/^export (?:async )?function parseSignatureHeader/m);
    expect(body).not.toMatch(/^export (?:async )?function constantTimeHexEq/m);
  });
});
