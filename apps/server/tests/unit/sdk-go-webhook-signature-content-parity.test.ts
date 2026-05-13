// W594.B — drift guard for packages/sdk-go/webhook_signature.go.

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

  it('VerifyWebhookSignature: Stripe-style t=,v1= + HMAC-SHA256(<unix-seconds>.<raw body>, <secret>) + DefaultWebhookTolerance 5min + V-359 HeaderPrev 24h-rotation-grace + hmac.Equal constant-time + never-panics pinned', () => {
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ DefaultWebhookTolerance is the maximum age a Driftstack signature/);
    expect(body).toMatch(/\/\/ timestamp may have before VerifyWebhookSignature rejects it\./);
    expect(body).toMatch(/^const DefaultWebhookTolerance = 5 \* time\.Minute$/m);
    expect(body).toMatch(/\/\/ VerifyWebhookOptions tunes signature verification\./);
    expect(body).toMatch(/\/\/ Tolerance is the max clock skew between server-issued timestamp/);
    expect(body).toMatch(/\/\/ and "now"\. Default DefaultWebhookTolerance\./);
    expect(body).toMatch(/\/\/ Now overrides time\.Now for tests\./);
    expect(body).toMatch(/\/\/ HeaderPrev is the optional second signature header Driftstack/);
    expect(body).toMatch(/\/\/ emits during the 24h secret-rotation grace window/);
    expect(body).toMatch(/\/\/ VerifyWebhookSignature accepts EITHER `header` OR `HeaderPrev`/);
    expect(body).toMatch(/\/\/ matching `secret`,/);
    expect(body).toMatch(/\/\/ window\. V-359\./);
    expect(body).toMatch(/\/\/ VerifyWebhookSignature returns true iff the X-Driftstack-Signature/);
    expect(body).toMatch(/\/\/ tolerance, and the HMAC matches in constant time\. Never panics;/);
    expect(body).toMatch(/\/\/ returns false on any failure mode\./);
    expect(body).toMatch(/\/\/ Header format \(Stripe-style\): t=<unix-seconds>,v1=<hex hmac>\./);
    expect(body).toMatch(
      /\/\/ HMAC = HMAC-SHA256\(<unix-seconds>\.<raw body>, <webhook secret>\)\./,
    );
    expect(body).toMatch(
      /func VerifyWebhookSignature\(body \[\]byte, header string, secret string, opts \.\.\.VerifyWebhookOptions\) bool \{/,
    );
    expect(body).toMatch(/tolerance := DefaultWebhookTolerance/);
    expect(body).toMatch(/now := time\.Now\(\)/);
    expect(body).toMatch(/headerPrev := ""/);
    expect(body).toMatch(
      /if headerPrev != "" && verifySingleHeader\(body, headerPrev, secret, tolerance, now\) \{\s*\n\s*return true\s*\n\s*\}/,
    );
  });

  it('verifySingleHeader: empty-header rejected + parsed-not-ok rejected + abs(now-signed) > tolerance rejected + HMAC-SHA256 mac.Write of timestamp + "." + body + hmac.Equal constant-time compare against hex.DecodeString(parsed.signatureHex)', () => {
    expect(body).toMatch(
      /^func verifySingleHeader\(body \[\]byte, header string, secret string, tolerance time\.Duration, now time\.Time\) bool \{\s*\n\s*if header == "" \{\s*\n\s*return false\s*\n\s*\}/m,
    );
    expect(body).toMatch(/parsed, ok := parseSignatureHeader\(header\)/);
    expect(body).toMatch(/if !ok \{\s*\n\s*return false\s*\n\s*\}/);
    expect(body).toMatch(/signed := time\.Unix\(parsed\.timestampSeconds, 0\)/);
    expect(body).toMatch(
      /delta := now\.Sub\(signed\)\s*\n\s*if delta < 0 \{\s*\n\s*delta = -delta\s*\n\s*\}\s*\n\s*if delta > tolerance \{\s*\n\s*return false\s*\n\s*\}/,
    );
    expect(body).toMatch(/mac := hmac\.New\(sha256\.New, \[\]byte\(secret\)\)/);
    expect(body).toMatch(
      /mac\.Write\(\[\]byte\(strconv\.FormatInt\(parsed\.timestampSeconds, 10\)\)\)/,
    );
    expect(body).toMatch(/mac\.Write\(\[\]byte\("\."\)\)/);
    expect(body).toMatch(/mac\.Write\(body\)/);
    expect(body).toMatch(/expectedSum := mac\.Sum\(nil\)/);
    expect(body).toMatch(/gotSum, err := hex\.DecodeString\(parsed\.signatureHex\)/);
    expect(body).toMatch(/return hmac\.Equal\(expectedSum, gotSum\)/);
  });

  it('parseSignatureHeader: t=<int>,v1=<hex> order-independent + bad-eq-skip + TrimSpace + accept only when both t set + v1 non-empty', () => {
    expect(body).toMatch(
      /^type parsedSignature struct \{\s*\n\s*timestampSeconds int64\s*\n\s*signatureHex\s+string\s*\n\}/m,
    );
    expect(body).toMatch(
      /^func parseSignatureHeader\(header string\) \(parsedSignature, bool\) \{/m,
    );
    expect(body).toMatch(/for _, part := range strings\.Split\(header, ","\) \{/);
    expect(body).toMatch(
      /eq := strings\.IndexByte\(part, '='\)\s*\n\s*if eq < 0 \{\s*\n\s*continue\s*\n\s*\}/,
    );
    expect(body).toMatch(/key := strings\.TrimSpace\(part\[:eq\]\)/);
    expect(body).toMatch(/val := strings\.TrimSpace\(part\[eq\+1:\]\)/);
    expect(body).toMatch(
      /switch key \{\s*\n\s*case "t":\s*\n\s*n, err := strconv\.ParseInt\(val, 10, 64\)/,
    );
    expect(body).toMatch(/case "v1":\s*\n\s*sig = val/);
    expect(body).toMatch(
      /if !tsSet \|\| sig == "" \{\s*\n\s*return parsedSignature\{\}, false\s*\n\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
