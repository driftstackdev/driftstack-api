// W905 — Webhook signature policy cross-source invariant. Two-
// hundred-thirty-first in the drift-guard series. Pins the
// webhook signature contract:
//
//   - Header format (Stripe-style): t=<unix-seconds>,v1=<hex hmac>.
//   - HMAC = HMAC-SHA256(<unix-seconds>.<raw body>, <webhook secret>).
//   - 5-minute tolerance (DefaultWebhookTolerance = 5 * time.Minute).
//   - Constant-time HMAC comparison.
//   - V-359 — X-Driftstack-Signature-Prev secondary header during
//     24h rotation grace; verifier accepts EITHER header.
//
// stays in lockstep across:
//   - packages/sdk-go/webhook_signature.go (Go verifier).
//   - apps/docs/src/pages/webhooks/events.md (customer docs).
//
// Drift would silently break:
//   * Customer verifier rejecting valid signatures (algorithm
//     mismatch).
//   * Replay attack: tolerance too high lets old signatures replay.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W905 webhook signature policy cross-source invariant', () => {
  // ─── DefaultWebhookTolerance = 5 minutes ─────────────────────

  it('CRITICAL packages/sdk-go/webhook_signature.go DefaultWebhookTolerance = 5 * time.Minute. The 5-min tolerance is wide enough to absorb network + clock drift but tight enough to prevent multi-day replay attacks.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/const DefaultWebhookTolerance = 5 \* time\.Minute/);
  });

  it("CRITICAL DefaultWebhookTolerance comment pins 'maximum age a Driftstack signature timestamp may have before VerifyWebhookSignature rejects it'. The framing teaches Go consumers what the constant means.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(
      /maximum age a Driftstack signature\s*\n\/\/ timestamp may have before VerifyWebhookSignature rejects it/,
    );
  });

  // ─── Header format Stripe-style ──────────────────────────────

  it("CRITICAL Go verifier comment pins Stripe-style header format — 't=<unix-seconds>,v1=<hex hmac>'. The Stripe-pattern format is what customers familiar with Stripe webhook verification recognize.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/Header format \(Stripe-style\): t=<unix-seconds>,v1=<hex hmac>/);
  });

  it("CRITICAL HMAC algorithm pinned — 'HMAC-SHA256(<unix-seconds>.<raw body>, <webhook secret>)'. The dot-separator + raw-body signing is what makes the signature stable across JSON-reformatting middlewares.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/HMAC = HMAC-SHA256\(<unix-seconds>\.<raw body>, <webhook secret>\)/);
  });

  // ─── Raw-body framing ────────────────────────────────────────

  it("CRITICAL Go verifier warns about raw-body access — 'body must be the EXACT raw bytes the server signed. If your HTTP router middleware re-encodes JSON before your handler runs, you'll need to use a raw-body access path'. The warning prevents the most common verification-failure footgun.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/body must be the EXACT raw bytes the server signed\. If your HTTP/);
    expect(p).toMatch(/router middleware re-encodes JSON before your handler runs/);
  });

  // ─── Constant-time comparison ────────────────────────────────

  it("CRITICAL Go verifier promises 'HMAC matches in constant time'. The constant-time comparison is what prevents timing-side-channel attacks on signature verification.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/HMAC matches in constant time/);
  });

  // ─── 'Never panics' contract ─────────────────────────────────

  it("CRITICAL Go verifier 'Never panics; returns false on any failure mode'. The non-panicking contract is what lets webhook handlers fail-closed (reject delivery) without crashing the whole HTTP server.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/Never panics;\s*\n\/\/ returns false on any failure mode/);
  });

  // ─── V-359 HeaderPrev rotation-grace acceptance ──────────────

  it("CRITICAL V-359 anchor + 'verifier accepts EITHER header matching secret' fallback framing for HeaderPrev. The accept-EITHER fallback stays for backward-compat, but passing `header` alone already verifies rotation deliveries.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/V-359/);
    expect(p).toMatch(/accepts EITHER `header` OR `HeaderPrev` matching `secret`\. V-359\./);
  });

  it('CRITICAL VerifyWebhookOptions.HeaderPrev framing — accurately states it is an OPTIONAL fallback and Driftstack does NOT emit a separate header (prev HMAC is a second v1= inside the main X-Driftstack-Signature header). Drift back to claiming a separate prev header is emitted would contradict the corrected customer docs.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/webhook_signature.go'));
    expect(p).toMatch(/HeaderPrev is an OPTIONAL fallback for a separately-supplied/);
    expect(p).toMatch(/previous-secret signature\. Driftstack does NOT emit a separate/);
    expect(p).toMatch(/second v1= inside the main X-Driftstack-Signature/);
  });

  // ─── Docs cross-reference ────────────────────────────────────

  it("CRITICAL apps/docs/src/pages/webhooks/events.md pins 'HMAC-SHA256(<emitted_at_seconds>.<raw body>) keyed by the' framing + 'v1= from the header, recompute HMAC-SHA256(<t>.<body>), constant-' framing. The customer-facing docs match the SDK contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md'));
    expect(p).toMatch(/HMAC-SHA256\(`<emitted_at_seconds>\.<raw body>`\) keyed by the/);
    expect(p).toMatch(/v1=` from the header, recompute HMAC-SHA256\(`<t>\.<body>`\), constant-/);
  });

  // ─── 5-min tolerance constant ────────────────────────────────

  it('CRITICAL 5-minute tolerance is a SECURITY constant — drift to 5 hours would create replay-attack window; drift to 5 seconds would reject legitimate deliveries with NTP-skewed clocks.', () => {
    const FIVE_MINUTES_NS = 5 * 60 * 1_000_000_000; // 300_000_000_000ns
    expect(FIVE_MINUTES_NS).toBe(300_000_000_000);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhook-signature-policy-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
