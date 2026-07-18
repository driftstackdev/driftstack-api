// W511.A — drift guard for apps/marketing-site/src/pages/docs/api-security-headers.astro.
// V-712.C public reference for security-relevant response headers.
// Drift here either changes a security-header value (would create
// marketing↔server divergence) or breaks the cache-control posture
// commitment that downstream V-666.BS/.BT/.BW reference.
//
//   • V-712.C doc-comment framing.
//   • Always-on transport 5-header table: HSTS (2-year + preload) +
//     X-Content-Type-Options nosniff + X-Frame-Options SAMEORIGIN +
//     Referrer-Policy no-referrer + X-DNS-Prefetch-Control off.
//   • Cache-Control private-default + two authenticated SSE + status mutation
//     and explicit public-status exceptions.
//   • CORS allow-list + 10-minute pre-flight + Article-13 cookie auth.
//   • Cross-Origin-Resource-Policy: cross-origin (not same-origin).
//   • What we DON'T set 3-list: CSP (no HTML) + COEP (no embeds) +
//     cookie security flags (REST is bearer-only).
//   • Security.txt PGP key publication + /legal/vulnerability-disclosure.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-security-headers.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W511.A apps/marketing-site/src/pages/docs/api-security-headers.astro content parity', () => {
  const body = read(LIB);

  it("V-712.C framing pinned: 'public reference for the security-relevant response headers Driftstack's API sets. Security reviewers + integrators ask for this regularly; gathering it on one page is faster than answering individually.' — pinned so the V-712.C anchor + security-reviewer-self-serve rationale survive (drift to dropping would orphan the page from the engineering reason it exists)", () => {
    expect(body).toMatch(
      /\/\/ V-712\.C — public reference for the security-relevant response\s*\n?\s*\/\/ headers Driftstack's API sets\. Security reviewers \+ integrators\s*\n?\s*\/\/ ask for this regularly; gathering it on one page is faster than\s*\n?\s*\/\/ answering individually\./,
    );
  });

  it("Strict-Transport-Security 'max-age=63072000; includeSubDomains; preload' (2-year HSTS) + browser-preload-list eligibility framing pinned — pinned so the 63072000-second (2-year) + includeSubDomains + preload directives all survive (drift to a shorter max-age would weaken first-visit-downgrade protection; drift to dropping 'preload' would block browser preload-list eligibility)", () => {
    expect(body).toMatch(/<td><code>max-age=63072000; includeSubDomains; preload<\/code><\/td>/);
    expect(body).toMatch(
      /2-year HSTS, eligible for the browser preload list\.\s*\n?\s*Closes first-visit downgrade attacks before TLS upgrade\s*\n?\s*kicks in\./,
    );
  });

  it('Always-on 5-transport-header table: X-Content-Type-Options nosniff + X-Frame-Options SAMEORIGIN + Referrer-Policy no-referrer + X-DNS-Prefetch-Control off — pinned so the 4-additional-header values stay consistent (drift to dropping X-Frame-Options would let Driftstack be framed; drift to dropping Referrer-Policy would leak referrer to third parties)', () => {
    expect(body).toMatch(
      /<td><code>X-Content-Type-Options<\/code><\/td>\s*\n?\s*<td><code>nosniff<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>X-Frame-Options<\/code><\/td>\s*\n?\s*<td><code>SAMEORIGIN<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>Referrer-Policy<\/code><\/td>\s*\n?\s*<td><code>no-referrer<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>X-DNS-Prefetch-Control<\/code><\/td>\s*\n?\s*<td><code>off<\/code><\/td>/,
    );
  });

  it('Cache-Control posture: all caller-private /v1 responses default private no-store; authenticated transcript/notification SSE retain private no-store plus no-cache/no-transform; status mailbox mutations are private; public status reads/stream retain explicit policies', () => {
    expect(body).toMatch(
      /<td><code>\/v1\/\*<\/code> \(caller-private default\)<\/td>\s*\n?\s*<td><code>no-store, private<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>\/v1\/agent-sessions\/&#123;id&#125;\/transcript<\/code> \(authenticated SSE\)<\/td>\s*\n?\s*<td><code>no-cache, no-store, private, no-transform<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>\/v1\/account\/me\/notifications<\/code> \(authenticated SSE\)<\/td>\s*\n?\s*<td><code>no-cache, no-store, private, no-transform<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>\/v1\/status\/subscribe\*<\/code> \(mailbox mutation\)<\/td>\s*\n?\s*<td><code>no-store, private<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>\/v1\/status<\/code> \(public\)<\/td>\s*\n?\s*<td><code>public, max-age=30<\/code><\/td>/,
    );
    expect(body).toMatch(
      /<td><code>\/v1\/status\/stream<\/code> \(SSE\)<\/td>\s*\n?\s*<td><code>no-cache, no-transform<\/code><\/td>/,
    );
    // Internal V-anchors must NOT bleed into customer-facing copy.
    expect(body).not.toMatch(/\(V-666\.BS\)/);
    expect(body).not.toMatch(/\(V-666\.BT\)/);
    expect(body).not.toMatch(/\(V-666\.BW\)/);
  });

  it('Defense-in-depth rationale pins authenticated SSE Origin variance and prevents public-status cache policy from reaching mailbox workflow responses', () => {
    expect(body).toMatch(/Caller-private <code>\/v1\/\*<\/code> responses default to/);
    expect(body).toMatch(
      /reflect only an allowed\s*\n?\s*<code>Origin<\/code> and send <code>Vary: Origin<\/code>/,
    );
    expect(body).toMatch(
      /defense-in-depth so shared \/ proxy caches can't hold onto private\s*\n?\s*payloads and browser back-forward cache can't serve stale state\s*\n?\s*after logout\./,
    );
    expect(body).toMatch(
      /subscription, confirmation, and unsubscribe responses\s*\n?\s*never inherit them/,
    );
  });

  it("CORS framing: 'explicit allow-list of origins; SDK consumers can call from any origin because the SDK ships Authorization: Bearer … and never relies on browser-cookie auth. Pre-flight responses cache for 10 minutes. credentials: true is required only by the Driftstack customer dashboard's cookie-based session (Article-13 auth).' — pinned so the allow-list + SDK-from-any-origin + 10-min preflight + credentials-for-dashboard-only commitment survive (drift to dropping 'credentials: true required only by dashboard' would mislead third-party developers about cookie sharing)", () => {
    expect(body).toMatch(
      /The API uses an explicit allow-list of origins; SDK consumers\s*\n?\s*can call from any origin because the SDK ships\s*\n?\s*<code>Authorization: Bearer …<\/code> and never relies on\s*\n?\s*browser-cookie auth\./,
    );
    expect(body).toMatch(
      /<code>credentials: true<\/code> is required only by the\s*\n?\s*Driftstack customer dashboard's cookie-based session\s*\n?\s*\(Article-13 auth\)\./,
    );
  });

  it('CORS sample 6-header pinned: Allow-Origin reflected + Allow-Methods GET/POST/PUT/PATCH/DELETE/OPTIONS + Allow-Headers (authorization + content-type + x-request-id + stripe-signature + x-nowpayments-sig) + Expose-Headers (x-request-id + x-ratelimit-* + retry-after) + Max-Age 600 + Allow-Credentials true — pinned so the 6-CORS-header sample stays consistent with the live policy (drift to dropping stripe-signature or x-nowpayments-sig from Allow-Headers would block inbound webhook proxies; drift to changing Expose-Headers would orphan rate-limit observability)', () => {
    expect(body).toMatch(/Access-Control-Allow-Origin: <reflected allow-list match>/);
    expect(body).toMatch(/Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS/);
    expect(body).toMatch(
      /Access-Control-Allow-Headers: authorization, content-type, x-request-id, stripe-signature, x-nowpayments-sig/,
    );
    expect(body).toMatch(
      // W561 — IETF ratelimit-* names exposed alongside the x- set.
      /Access-Control-Expose-Headers: x-request-id, idempotent-replayed, x-ratelimit-bucket, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after/,
    );
    expect(body).toMatch(/Access-Control-Max-Age: 600/);
    expect(body).toMatch(/Access-Control-Allow-Credentials: true/);
  });

  it("Cross-Origin-Resource-Policy framing: 'Cross-Origin-Resource-Policy: cross-origin is set explicitly. The default helmet value (same-origin) would block legitimate SDK calls from third-party origins because the CORS layer is our boundary, not CORP.' — pinned so the CORP-cross-origin choice + the rationale (CORS-is-boundary-not-CORP) survives (drift to changing to same-origin would block SDK calls from customer origins)", () => {
    expect(body).toMatch(
      /<code>Cross-Origin-Resource-Policy: cross-origin<\/code> is set\s*\n?\s*explicitly\. The default helmet value\s*\n?\s*\(<code>same-origin<\/code>\) would block legitimate SDK calls\s*\n?\s*from third-party origins because the CORS layer is our\s*\n?\s*boundary, not CORP\./,
    );
  });

  it("'What we don't set' 3-explicit-no list: Content-Security-Policy (no HTML, CSP would be no-op) + Cross-Origin-Embedder-Policy (no embeds) + Cookie security flags (REST is bearer-only) — pinned so the 3-no-by-design explanations survive (drift to claiming CSP would mislead reviewers; drift to dropping the cookie-flags clarification would let reviewers question dashboard cookie posture)", () => {
    expect(body).toMatch(
      /<strong>Content-Security-Policy\.<\/strong> Driftstack serves\s*\n?\s*no HTML — every endpoint returns JSON, plain text, CSV, or\s*\n?\s*PDF\. CSP would be a no-op\./,
    );
    expect(body).toMatch(
      /<strong>Cross-Origin-Embedder-Policy\.<\/strong> Same logic —\s*\n?\s*no embeddable surfaces\./,
    );
    expect(body).toMatch(
      /<strong>Cookie security flags\.<\/strong> The public REST API\s*\n?\s*is bearer-auth only\. The dashboard's Article-13 cookie sets\s*\n?\s*<code>Secure; HttpOnly; SameSite=Lax<\/code>/,
    );
  });

  it('Reporting framing: security@driftstack.dev + PGP key on /.well-known/security.txt + /legal/vulnerability-disclosure cross-link — pinned so the 3-disclosure-channel (email + PGP-discovery + policy-doc) survives (drift to dropping security.txt would orphan the standard PGP-discovery path; drift to dropping /legal/vulnerability-disclosure would orphan the safe-harbour policy reference)', () => {
    expect(body).toMatch(
      /Send disclosures to\s*\n?\s*<a href="mailto:security@driftstack\.dev">security@driftstack\.dev<\/a>\./,
    );
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/\.well-known\/security\.txt">security\.txt<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/legal\/vulnerability-disclosure\/">vulnerability-disclosure policy<\/a>/,
    );
    expect(body).not.toMatch(/href="\/legal\/vulnerability-disclosure"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
