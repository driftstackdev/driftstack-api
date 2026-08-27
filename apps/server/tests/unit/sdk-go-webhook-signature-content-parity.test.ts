// W594.B (W639-deepened) — drift guard for packages/sdk-go/webhook_signature.go.
// V-359 webhook signature verifier with 24h secret-rotation grace window.
//
// W639 splits the original 4 it() blocks into 11 focused per-concept
// blocks + pins previously-implicit cryptographic invariants:
//
//   • DefaultWebhookTolerance 5-minute clock-skew window — drift to
//     a wider window silently weakens the replay-protection contract.
//   • VerifyWebhookOptions field-by-field semantics: Tolerance override
//     only when > 0 (zero-value falls through to default); Now override
//     only when !IsZero() (falls through to time.Now); HeaderPrev
//     opt-in (empty string skips the rotation-grace second-header
//     check).
//   • V-359 HeaderPrev "accept EITHER header" semantics for the 24h
//     rotation grace — the load-bearing invariant that lets customers
//     who haven't rolled the new secret across their verifier still
//     pass during rotation.
//   • HMAC payload construction: timestamp + "." + body (the dot
//     separator is part of the signed payload, NOT a structural-JSON
//     separator). Drift to a different separator would invalidate
//     every existing customer verifier.
//   • Bidirectional clock-skew delta: |now - signed| > tolerance
//     rejects (delta < 0 ? -delta : delta — both future-clock and
//     past-clock signatures rejected symmetrically).
//   • hmac.Equal constant-time invariant — never reveals where the
//     mismatch is via timing.
//   • parseSignatureHeader robustness: unknown keys silently skipped
//     (no default case in switch); malformed int "t" silently
//     dropped (tsSet stays false); malformed hex "v1" caught at
//     hex.DecodeString stage (returns false from outer fn).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W594.B packages/sdk-go/webhook_signature.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + package + crypto/hmac + crypto/sha256 + encoding/hex imports pinned (cryptographic primitives surface — drift to e.g. crypto/md5 would be catastrophic)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/"crypto\/hmac"/);
    expect(body).toMatch(/"crypto\/sha256"/);
    expect(body).toMatch(/"encoding\/hex"/);
  });

  it('DefaultWebhookTolerance 5-minute clock-skew window pinned. Drift to a wider window (e.g. 15min) silently weakens replay protection — an attacker who captures a signed request gets 3× longer to replay it.', () => {
    expect(body).toMatch(/\/\/ DefaultWebhookTolerance is the maximum age a Driftstack signature/);
    expect(body).toMatch(/\/\/ timestamp may have before VerifyWebhookSignature rejects it\./);
    expect(body).toMatch(/^const DefaultWebhookTolerance = 5 \* time\.Minute$/m);
  });

  it('VerifyWebhookOptions — 3-field tuning struct (Tolerance + Now test-injection + HeaderPrev V-359 rotation-grace). Per-field doc-comments pinned because each field has subtle activation semantics: Tolerance only overrides when > 0, Now only when !IsZero(), HeaderPrev only when non-empty.', () => {
    expect(body).toMatch(/\/\/ VerifyWebhookOptions tunes signature verification\./);
    expect(body).toMatch(/\/\/ Tolerance is the max clock skew between server-issued timestamp/);
    expect(body).toMatch(/\/\/ and "now"\. Default DefaultWebhookTolerance\./);
    expect(body).toMatch(/Tolerance time\.Duration/);
    expect(body).toMatch(/\/\/ Now overrides time\.Now for tests\./);
    expect(body).toMatch(/Now time\.Time/);
    expect(body).toMatch(/\/\/ HeaderPrev is an OPTIONAL fallback for a separately-supplied/);
    expect(body).toMatch(/\/\/ previous-secret signature\. Driftstack does NOT emit a separate/);
    expect(body).toMatch(/\/\/ is included as a second v1= inside the main X-Driftstack-Signature/);
    expect(body).toMatch(/HeaderPrev string/);
  });

  it('V-359 HeaderPrev rotation-grace contract: "passing `header` alone verifies rotation deliveries correctly and this input is rarely needed. When set, VerifyWebhookSignature accepts EITHER `header` OR `HeaderPrev` matching `secret`." The accept-EITHER fallback stays, but the doc now correctly states no separate prev header is emitted.', () => {
    expect(body).toMatch(/\/\/ So passing `header` alone verifies rotation deliveries correctly/);
    expect(body).toMatch(/\/\/ and this input is rarely needed\. When set, VerifyWebhookSignature/);
    expect(body).toMatch(
      /\/\/ accepts EITHER `header` OR `HeaderPrev` matching `secret`\. V-359\./,
    );
  });

  it('VerifyWebhookSignature contract: Stripe-style "t=<unix-seconds>,v1=<hex hmac>" header format + HMAC payload "HMAC-SHA256(<unix-seconds>.<raw body>, <webhook secret>)" + never-panics-returns-false + raw-body-not-re-encoded-JSON warning pinned. Drift to a different payload concatenation would invalidate every existing customer verifier mid-flight.', () => {
    expect(body).toMatch(/\/\/ VerifyWebhookSignature returns true iff the X-Driftstack-Signature/);
    expect(body).toMatch(
      /\/\/ header on an inbound request is well-formed, the timestamp is within/,
    );
    expect(body).toMatch(/\/\/ tolerance, and the HMAC matches in constant time\. Never panics;/);
    expect(body).toMatch(/\/\/ returns false on any failure mode\./);
    expect(body).toMatch(/\/\/ Header format \(Stripe-style\): t=<unix-seconds>,v1=<hex hmac>\./);
    expect(body).toMatch(
      /\/\/ HMAC = HMAC-SHA256\(<unix-seconds>\.<raw body>, <webhook secret>\)\./,
    );
    expect(body).toMatch(/\/\/ body must be the EXACT raw bytes the server signed\. If your HTTP/);
    expect(body).toMatch(/\/\/ router middleware re-encodes JSON before your handler runs, you'll/);
    expect(body).toMatch(/\/\/ need to use a raw-body access path/);
  });

  it('VerifyWebhookSignature opts-decoding semantics: variadic ...VerifyWebhookOptions; if len(opts) > 0 then per-field conditional override: Tolerance > 0 / Now !IsZero / HeaderPrev unconditional read. Drift to always-override would break the "pass empty VerifyWebhookOptions{} and inherit defaults" ergonomic.', () => {
    expect(body).toMatch(
      /func VerifyWebhookSignature\(body \[\]byte, header string, secret string, opts \.\.\.VerifyWebhookOptions\) bool/,
    );
    expect(body).toMatch(/tolerance := DefaultWebhookTolerance/);
    expect(body).toMatch(/now := time\.Now\(\)/);
    expect(body).toMatch(/headerPrev := ""/);
    expect(body).toMatch(
      /if len\(opts\) > 0 \{\s*\n\s*if opts\[0\]\.Tolerance > 0 \{\s*\n\s*tolerance = opts\[0\]\.Tolerance\s*\n\s*\}\s*\n\s*if !opts\[0\]\.Now\.IsZero\(\) \{\s*\n\s*now = opts\[0\]\.Now\s*\n\s*\}\s*\n\s*headerPrev = opts\[0\]\.HeaderPrev\s*\n\s*\}/,
    );
    // EITHER header OR headerPrev: first checks primary, then prev (only when non-empty).
    expect(body).toMatch(
      /if verifySingleHeader\(body, header, secret, tolerance, now\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*if headerPrev != "" && verifySingleHeader\(body, headerPrev, secret, tolerance, now\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*return false/,
    );
  });

  it("verifySingleHeader empty-header guard + parsed-not-ok guard. The empty-header check makes the V-359 HeaderPrev opt-in fully ergonomic: customers can always pass HeaderPrev unconditionally; when there's no Prev header to verify, the empty-string short-circuits to false without invoking the cryptographic primitives.", () => {
    expect(body).toMatch(
      /^func verifySingleHeader\(body \[\]byte, header string, secret string, tolerance time\.Duration, now time\.Time\) bool \{\s*\n\s*if header == "" \{\s*\n\s*return false\s*\n\s*\}\s*\n\s*parsed, ok := parseSignatureHeader\(header\)\s*\n\s*if !ok \{\s*\n\s*return false\s*\n\s*\}/m,
    );
  });

  it('Bidirectional clock-skew delta + tolerance check: delta := now.Sub(signed); if delta < 0 then delta = -delta. Both FUTURE-clock signatures (signed timestamp is ahead of now) AND PAST-clock signatures (signed is behind now) are rejected symmetrically when |delta| > tolerance. Drift to a one-sided check would let an attacker with a future-clocked sender bypass the window.', () => {
    expect(body).toMatch(/signed := time\.Unix\(parsed\.timestampSeconds, 0\)/);
    expect(body).toMatch(
      /delta := now\.Sub\(signed\)\s*\n\s*if delta < 0 \{\s*\n\s*delta = -delta\s*\n\s*\}\s*\n\s*if delta > tolerance \{\s*\n\s*return false\s*\n\s*\}/,
    );
  });

  it('HMAC payload construction: hmac.New(sha256.New, []byte(secret)) + mac.Write(timestamp-bytes) + mac.Write([]byte(".")) + mac.Write(body). CRITICAL: the dot separator IS part of the signed payload — drift to omitting the dot or using a different separator would invalidate every existing customer verifier mid-flight. Three separate Write() calls (not concat-then-write) so the HMAC streams without an intermediate allocation.', () => {
    expect(body).toMatch(/mac := hmac\.New\(sha256\.New, \[\]byte\(secret\)\)/);
    expect(body).toMatch(
      /mac\.Write\(\[\]byte\(strconv\.FormatInt\(parsed\.timestampSeconds, 10\)\)\)/,
    );
    expect(body).toMatch(/mac\.Write\(\[\]byte\("\."\)\)/);
    expect(body).toMatch(/mac\.Write\(body\)/);
    expect(body).toMatch(/expectedSum := mac\.Sum\(nil\)/);
  });

  it('Constant-time signature compare via hmac.Equal. hex.DecodeString on the parsed signature hex; if decode fails (malformed hex) returns false WITHOUT invoking hmac.Equal. Drift to bytes.Equal or == comparison would reveal where the mismatch is via timing, defeating the constant-time HMAC guarantee.', () => {
    expect(body).toMatch(
      /for _, sigHex := range parsed\.signatureHexes \{\s*\n\s*gotSum, err := hex\.DecodeString\(sigHex\)\s*\n\s*if err != nil \{\s*\n\s*continue\s*\n\s*\}\s*\n\s*if hmac\.Equal\(expectedSum, gotSum\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*\}\s*\n\s*return false/,
    );
  });

  it('parseSignatureHeader robustness: parsedSignature 2-field private struct (timestampSeconds + signatureHex); comma-split + per-part IndexByte(\'=\') with bad-eq-skip; TrimSpace on both key + val; switch on key with ONLY "t" and "v1" cases (no default — UNKNOWN KEYS SILENTLY SKIPPED so server can add future fields without breaking old verifiers); malformed "t" int silently dropped via err==nil guard; tsSet bool flag separates "0 set" from "never set" since 0 is a valid Unix timestamp; accept only when tsSet AND sig != "".', () => {
    expect(body).toMatch(
      /^type parsedSignature struct \{\s*\n\s*timestampSeconds int64\s*\n\s*signatureHexes\s+\[\]string\s*\n\}/m,
    );
    expect(body).toMatch(/^func parseSignatureHeader\(header string\) \(parsedSignature, bool\)/m);
    expect(body).toMatch(/for _, part := range strings\.Split\(header, ","\) \{/);
    expect(body).toMatch(
      /eq := strings\.IndexByte\(part, '='\)\s*\n\s*if eq < 0 \{\s*\n\s*continue\s*\n\s*\}/,
    );
    expect(body).toMatch(/key := strings\.TrimSpace\(part\[:eq\]\)/);
    expect(body).toMatch(/val := strings\.TrimSpace\(part\[eq\+1:\]\)/);
    // Switch with only "t" and "v1" — unknown keys SILENTLY SKIPPED (no default).
    expect(body).toMatch(
      /switch key \{\s*\n\s*case "t":\s*\n\s*n, err := strconv\.ParseInt\(val, 10, 64\)\s*\n\s*if err == nil \{\s*\n\s*ts = n\s*\n\s*tsSet = true\s*\n\s*\}\s*\n\s*case "v1":\s*\n\s*if val != "" \{\s*\n\s*sigs = append\(sigs, val\)\s*\n\s*\}\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if !tsSet \|\| len\(sigs\) == 0 \{\s*\n\s*return parsedSignature\{\}, false\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /return parsedSignature\{timestampSeconds: ts, signatureHexes: sigs\}, true/,
    );
  });
  // V-2010 — the empty-secret refusal. Pinned because the behavioural regression
  // lives in the SDK's own go test suite, and this file is the drift guard for the
  // source: deleting the guard here would leave that suite as the only witness.
  it('CRITICAL VerifyWebhookSignature refuses an empty secret before hashing — `if secret == "" { return false }`. hmac.New accepts a zero-length key and returns a good digest, so without this an attacker who knows the body and timestamp verifies against an empty secret.', () => {
    expect(body).toMatch(/if secret == "" \{\s*\n\s*return false\s*\n\s*\}/);
  });
});
