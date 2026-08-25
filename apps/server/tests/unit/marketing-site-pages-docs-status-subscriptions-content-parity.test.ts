// W507.B — drift guard for apps/marketing-site/src/pages/docs/status-subscriptions.astro.
// V-723 status-page email-subscription doc — V-295c3 server + V-459
// OpenAPI public API. Drift here either drops the leak-prevention
// '202 generic response' commitment (would let the endpoint reveal
// subscribed addresses) or changes the 24h token TTL (would create
// marketing↔server divergence).
//
//   • V-723 doc-comment framing + V-295c3 / V-459 anchors.
//   • status.driftstack.dev as the canonical status page.
//   • POST /v1/status/subscribe + GET confirm + GET unsubscribe API.
//   • 202 generic-response leak-prevention commitment.
//   • Confirmation token 24h TTL + single-use.
//   • Unsubscribe token never expires.
//   • IP rate limit 3 req/min + no-auth-required.
//   • 4-state email notification scope: incident-opened + status-update +
//     resolved + post-mortem.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/status-subscriptions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W507.B apps/marketing-site/src/pages/docs/status-subscriptions.astro content parity', () => {
  const body = read(LIB);

  it("V-723 + V-295c3 + V-459 framing pinned: 'public reference for the status-page email subscription flow (V-295c3 server-side, V-459 OpenAPI). Pitched at customers who want to know about incidents before they notice them.' — pinned so the V-723 doc-comment + the V-295c3 server-side + V-459 OpenAPI anchors survive (drift to dropping V-295c3 / V-459 would orphan the customer-facing doc from the engineering implementation)", () => {
    expect(body).toMatch(
      /\/\/ V-723 — public reference for the status-page email subscription\s*\/\/ flow \(V-295c3 server-side, V-459 OpenAPI\)\. Pitched at customers\s*\/\/ who want to know about incidents before they notice them\./,
    );
  });

  it("status.driftstack.dev canonical-page + 'real time' announcement framing pinned — pinned so the status-page URL + the real-time positioning survive (drift to a different domain would create marketing↔ops divergence; drift to dropping 'real time' would weaken the immediacy promise)", () => {
    expect(body).toMatch(
      /Driftstack's public status page at\s*<a href="https:\/\/status\.driftstack\.dev">status\.driftstack\.dev<\/a>\s*announces incidents in real time\./,
    );
  });

  it('3-endpoint API surface: POST /v1/status/subscribe + GET /v1/status/subscribe/confirm?token=… + GET /v1/status/subscribe/unsubscribe?token=… — pinned so the 3-endpoint subscribe/confirm/unsubscribe API stays consistent (drift to a different path would create marketing↔OpenAPI-spec divergence; drift to merging confirm/unsubscribe into one endpoint would shift the token-semantics)', () => {
    expect(body).toMatch(/POST \/v1\/status\/subscribe/);
    expect(body).toMatch(/GET \/v1\/status\/subscribe\/confirm\?token=…/);
    expect(body).toMatch(/GET \/v1\/status\/subscribe\/unsubscribe\?token=…/);
  });

  it('Leak-prevention 202 generic-response pinned: \'Returns 202 Accepted with a generic "confirmation email sent" message. We deliberately return the same shape whether or not the email was already subscribed — this avoids leaking whether a given address is on the list.\' — pinned so the 202 + same-shape + explicit-leak-prevention rationale all survive (drift to returning 200/422 differently would re-introduce the enumeration leak the V-295c3 design eliminates)', () => {
    expect(body).toMatch(
      /Returns <code>202 Accepted<\/code> with a generic\s*"confirmation email sent" message\. We deliberately return the\s*same shape whether or not the email was already subscribed —\s*this avoids leaking whether a given address is on the list\./,
    );
  });

  it("Confirmation token 24h-TTL + single-use + re-mint-on-expiry pinned: 'Confirmation tokens are single-use and expire 24 hours after the subscribe POST. Subscribers who miss the window can re-submit POST /v1/status/subscribe to mint a fresh confirmation email.' — pinned so the 24h-window + single-use + re-mint-fallback 3-state token lifecycle survives (drift to a longer window would create marketing↔server divergence; drift to dropping 'single-use' would let token-replay enable bulk-subscription-from-leaked-link)", () => {
    expect(body).toMatch(
      /Returns <code>200<\/code> on success\. Confirmation tokens are\s*single-use and expire <strong>24 hours<\/strong> after the\s*subscribe POST\. Subscribers who miss the window can re-submit\s*<code>POST \/v1\/status\/subscribe<\/code> to mint a fresh\s*confirmation email\./,
    );
  });

  it("Unsubscribe token never-expires commitment pinned: 'Unsubscribe tokens never expire; subscribers can revoke at any time.' — pinned so the asymmetric-token-lifetime (24h-confirm vs forever-unsubscribe) survives (drift to expiring unsubscribe tokens would trap subscribers who only saw the email weeks later; drift to softening 'never expire' would let customers question if their old unsubscribe link still works)", () => {
    expect(body).toMatch(/Unsubscribe tokens never expire; subscribers can revoke at\s*any time\./);
  });

  it("Rate limit 3-req/min IP-rate-limit + no-auth-required pinned: 'The public subscribe endpoint is IP-rate-limited to 3 requests/minute to discourage email-flood abuse. Confirmation and unsubscribe inherit the same bucket. None of these endpoints require authentication.' — pinned so the 3-req/min limit + shared-bucket + no-auth-needed commitments all survive (drift to dropping 'no auth' would mislead customers about the public-endpoint posture; drift to changing the rate would create marketing↔server divergence)", () => {
    expect(body).toMatch(
      /The public subscribe endpoint is IP-rate-limited to 3\s*requests\/minute to discourage email-flood abuse\. Confirmation\s*and unsubscribe inherit the same bucket\. None of these\s*endpoints require authentication\./,
    );
  });

  it("4-state notification scope: Incident opened + Status update + Incident resolved + Post-mortem published — pinned so the 4-email-type notification catalog stays complete (drift to dropping 'Status update' would leave subscribers without progress signals; drift to dropping 'Post-mortem published' would orphan the post-mortem-link-via-email channel)", () => {
    expect(body).toMatch(
      /<strong>Incident opened<\/strong> — when ops creates a new\s*incident on the status page\./,
    );
    expect(body).toMatch(
      /<strong>Status update<\/strong> — when ops posts a new\s*update on a live incident/,
    );
    expect(body).toMatch(
      /<strong>Incident resolved<\/strong> — when ops moves the\s*incident to resolved\./,
    );
    expect(body).toMatch(
      /<strong>Post-mortem published<\/strong> — for incidents\s*meeting our\s*<a href="\/docs\/incident-policy\/">incident policy<\/a>/,
    );
  });

  it("No-marketing-email commitment pinned: 'We do not send marketing email to status subscribers. Period.' — pinned so the explicit no-marketing-misuse promise survives (drift to softening 'Period.' would let the channel slowly drift to marketing use; drift to dropping the commitment would make customers question the email scope)", () => {
    expect(body).toMatch(/We do not send marketing email to status subscribers\.\s*Period\./);
  });

  it('Related-docs cross-link 3-set pins canonical incident-policy, SLA-policy and API-reference routes so all discovery paths stay complete', () => {
    expect(body).toMatch(/<li><a href="\/docs\/incident-policy\/">Incident policy<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/docs\/sla-policy\/">SLA policy<\/a><\/li>/);
    expect(body).toMatch(/<li><a href="\/api-reference\/">API reference<\/a><\/li>/);
    expect(body).not.toMatch(/href="\/(?:docs\/incident-policy|docs\/sla-policy|api-reference)"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
