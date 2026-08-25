// W507.C — drift guard for apps/marketing-site/src/pages/docs/idempotency-keys.astro.
// V-719 Idempotency-Key reference (V-666.AO server impl). Drift here
// either changes the dedupe-window (would create marketing↔server
// divergence on when retries are safe) or breaks the body-mismatch
// don't-reject commitment (would surprise clients sending different
// body on retry).
//
//   • V-719 + V-666.AO + V-666.AR (body_mismatches metric) anchors.
//   • Idempotency-Key header semantics + Idempotent-Replayed response
//     header.
//   • Currently applies: POST /v1/billing/crypto-checkout.
//   • Key constraints: opaque, 255 ASCII max, no whitespace, UUIDv4
//     canonical.
//   • Per-account scope + 24h dedupe window + pre-signup anonymous
//     bucket.
//   • Body-mismatch don't-reject + body_mismatches admin counter via
//     GET /v1/admin/crypto-orders/idempotency-metrics.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/idempotency-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W507.C apps/marketing-site/src/pages/docs/idempotency-keys.astro content parity', () => {
  const body = read(LIB);

  it("V-719 + V-666.AO framing pinned: 'idempotency-keys reference. Documents the Idempotency-Key header introduced by V-666.AO on POST /v1/billing/crypto-checkout. The page is also reachable from the API changelog + the billing-crypto integration guide.' — pinned so the V-719 + V-666.AO anchors survive (drift to dropping V-666.AO would orphan the customer-facing doc from the engineering implementation). The V-719 + V-666.AO anchors live in the page-header doc-comment (internal-facing), which is the only place internal V-anchors are allowed.", () => {
    expect(body).toMatch(
      /\/\/ V-719 — idempotency-keys reference\. Documents the\s*\/\/ Idempotency-Key header introduced by V-666\.AO on\s*\/\/ POST \/v1\/billing\/crypto-checkout\./,
    );
  });

  it("Idempotency-Key request header semantic pinned: 'Send a unique opaque token on the Idempotency-Key request header. The first request with a new token is processed normally. Any subsequent request to the same endpoint with the same token, scoped to the same caller, returns the original response verbatim — same body, same Location, same minted IDs.' — pinned so the 3-state replay-semantics (first processed + subsequent returns verbatim + per-caller scoping) survives (drift to softening 'verbatim' would let retries return slightly different responses, defeating the replay contract)", () => {
    expect(body).toMatch(
      /Send a unique opaque token on the\s*<code>Idempotency-Key<\/code> request header\./,
    );
    expect(body).toMatch(
      /Any subsequent request\s*to the same endpoint with the same token, scoped to the same\s*caller, returns the original response verbatim — same body,\s*same <code>Location<\/code>, same minted IDs\./,
    );
  });

  it("Sample POST + Idempotent-Replayed response header pinned: 'Idempotent-Replayed: 1' on replay — pinned so the replay-marker header survives (drift to dropping the header would force clients to compare bodies to detect replay; drift to a different header name would create marketing↔server divergence)", () => {
    expect(body).toMatch(/POST \/v1\/billing\/crypto-checkout/);
    expect(body).toMatch(/Idempotency-Key: 7b3f2e0c-1b6a-4cf3-aa6d-9c2c1f8a1b22/);
    expect(body).toMatch(/Idempotent-Replayed: 1/);
  });

  it("Where-it-applies framing: 'POST /v1/billing/crypto-checkout — mints a crypto order. Without the header, two racing clicks mint two orders; with the header, the second click returns the first order.' + 'Read-only endpoints do not consult the header.' — pinned so the 'currently applies to crypto-checkout only' + 'reads ignore the header' framing survive (drift to claiming wider applicability would over-promise the feature scope)", () => {
    expect(body).toMatch(
      /<code>POST \/v1\/billing\/crypto-checkout<\/code> — mints a\s*crypto order\. Without the header, two racing clicks mint two\s*orders; with the header, the second click returns the first\s*order\./,
    );
    expect(body).toMatch(/<strong>Read-only<\/strong> endpoints\s*do not consult the header\./);
  });

  it("Key-format 3-constraint + UUIDv4 canonical-choice pinned: 'Use any opaque string up to 255 ASCII characters (no whitespace). UUIDv4 is the canonical choice and what Driftstack's own GUI client mints.' + 'Generate one per intent, not per request.' + 'Don't include user data in the key — keys appear in server logs.' — pinned so the 3-state choosing-a-key guidance survives (drift to dropping 'no whitespace' would let clients send invalid keys; drift to dropping 'one per intent' would let the dedupe window get reset per-retry; drift to dropping 'keys appear in server logs' would let customers leak PII through the key value)", () => {
    expect(body).toMatch(
      /Use any opaque string up to 255 ASCII characters\s*\(no whitespace\)\. UUIDv4 is the canonical choice and what\s*Driftstack's own GUI client mints\./,
    );
    expect(body).toMatch(
      /Generate one per <em>intent<\/em>, not per request\. If a\s*single submit button could be clicked twice, all retries of\s*that submit use the same key\./,
    );
    expect(body).toMatch(/Don't include user data in the key — keys appear in\s*server logs\./);
  });

  it("Scope + lifetime 3-state pinned: per-account + permanent dedup (no expiry) + pre-signup anonymous bucket — pinned so the 3-state scope-and-lifetime framing matches the DB-layer reality (crypto_orders.idempotency_key carries a permanent partial UNIQUE index with no sweep/expiry job; a prior '24h forget window' claim was corrected 2026-06-30 because the DB layer never honored it — the in-memory 24h TTL is a same-process fast-path prune only, not a customer-visible expiry). Drift to re-claiming a forget-window would re-introduce the doc/code mismatch; drift to dropping the per-account scope would orphan customers from cross-account safety; drift to dropping the pre-signup-anonymous-bucket warning would let customers rely on uniqueness in a shared bucket.", () => {
    expect(body).toMatch(/Keys are scoped <strong>per account<\/strong>/);
    expect(body).toMatch(
      /Dedup is <strong>permanent<\/strong>, not a rolling\s*window: once a key has minted an order, replaying that exact\s*key returns that same order indefinitely — there's no expiry\s*after which reusing it mints a fresh one\. Use a new key for\s*a new order\./,
    );
    expect(body).toMatch(
      /Pre-signup checkouts \(no account_id\) share a single\s*anonymous bucket\. Don't rely on uniqueness there if your\s*client is one of many anonymous callers\./,
    );
  });

  it("Errors 3-rule pinned: 255-char-max → 400 + whitespace → 400 + missing-header is not-an-error — pinned so the 3-error-condition surface survives (drift to dropping 'missing header is not an error' would let clients think the header is required; drift to changing the 400 status on errors would create marketing↔server divergence)", () => {
    expect(body).toMatch(
      /A key longer than 255 characters returns\s*<code>400 Bad Request<\/code>\./,
    );
    expect(body).toMatch(/A key containing whitespace returns\s*<code>400 Bad Request<\/code>\./);
    expect(body).toMatch(
      /A missing header is not an error — the endpoint behaves\s*as if idempotency were not requested\./,
    );
  });

  it("Body-mismatch don't-reject framing pinned: 'We do not reject replays where the request body differs from the original' + 'if you send k1 with price_cents=4900 first, then k1 with price_cents=9900, you still get the original 4900-cent order back.' + 'The server records the mismatch and surfaces it as body_mismatches on the admin GET /v1/admin/crypto-orders/idempotency-metrics counter' — pinned so the don't-reject + body_mismatches admin-counter 3-state mechanism survives (drift to rejecting body mismatches would change the contract on retry safety; drift to dropping the admin endpoint would orphan support from spotting client bugs). The previous skip pinned inline `(V-666.AR)` anchor that was removed from the customer-facing copy as a UX cleanup (internal V-anchors should not bleed into marketing pages); the framing itself survives without it.", () => {
    expect(body).toMatch(
      /We do <strong>not reject<\/strong> replays where the request\s*body differs from the original/,
    );
    expect(body).toMatch(
      /if you send <code>k1<\/code>\s*with price_cents=4900 first, then <code>k1<\/code> with\s*price_cents=9900, you still get the original 4900-cent order\s*back\./,
    );
    expect(body).toMatch(
      /The server records the mismatch and surfaces\s*it as <code>body_mismatches<\/code> on the admin\s*<code>GET \/v1\/admin\/crypto-orders\/idempotency-metrics<\/code>\s*counter/,
    );
    // Internal V-anchor must NOT bleed into customer-facing copy.
    expect(body).not.toMatch(/records the mismatch \(V-666\.AR\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
