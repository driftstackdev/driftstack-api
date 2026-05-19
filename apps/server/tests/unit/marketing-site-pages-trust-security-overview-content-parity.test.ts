// W504.B — drift guard for apps/marketing-site/src/pages/trust/security-overview.astro.
// V-670 (V-550 follow-up) public security overview — evaluator
// checklist mapping every security claim to its verifiable evidence
// (code path, test, or doc link). Drift here either softens a claim
// (would let marketing diverge from engineering) or drops a code-path
// pointer (would force buyers to take security claims on faith).
//
//   • V-670 (V-550) doc-comment framing.
//   • 5-section taxonomy: Authentication + Transport + Webhooks +
//     Data residency + Observability.
//   • Auth section 3 claims: scrypt-hashed API keys (N=2^15) +
//     MFA TOTP + AES-256-GCM + OAuth 2.0 PKCE-S256 invite-only.
//   • Transport: TLS 1.3 strict + customer-configurable egress
//     roadmap (○ status).
//   • Webhooks: HMAC-SHA256 outbound + Stripe V-080 / NowPayments
//     V-487 inbound verification.
//   • Data: EU-only data plane + capture retention roadmap (V-540)
//     + 30-day grace then hard delete.
//   • Observability: public incident history + vulnerability
//     disclosure 2d/5d + chaos engineering harness (V-547).
//   • ✓ shipped / ○ roadmap visual semantic.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/security-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W504.B apps/marketing-site/src/pages/trust/security-overview.astro content parity', () => {
  const body = read(LIB);

  it("V-670 (V-550 follow-up) framing pinned: 'public security overview as an evaluator checklist. /security is the architecture deep-dive; this page is the buyer-evaluation companion — every security claim mapped to its verifiable evidence (code path, test, public doc link). The goal: a prospective customer's CISO can self-serve a security review without scheduling a call.' — pinned so the V-670 doc-comment + the /security-vs-/trust/security-overview division-of-labor + the 'CISO self-serve' goal survive (drift to dropping V-670 would orphan the engineering reason; drift to dropping the code-path mapping would force prospects back to scheduling calls). Re-enabled by slice 175 after verifying the V-670 comment exists at security-overview.astro:4-9 with the matching shape", () => {
    expect(body).toMatch(
      /\/\/ V-670 \(V-550 follow-up\) — public security overview as an evaluator\s*\n?\s*\/\/ checklist\. \/security is the architecture deep-dive; this page is\s*\n?\s*\/\/ the buyer-evaluation companion — every security claim mapped to\s*\n?\s*\/\/ its verifiable evidence \(code path, test, public doc link\)\. The\s*\n?\s*\/\/ goal: a prospective customer's CISO can self-serve a security\s*\n?\s*\/\/ review without scheduling a call\./,
    );
  });

  it("5-section evaluator-checklist taxonomy: 'Authentication & access' + 'Transport & egress' + 'Webhooks & integrations' + 'Data residency & retention' + 'Observability & incident response' — pinned so the 5-section CISO-checklist surface stays complete (drift to dropping 'Webhooks & integrations' would orphan the inbound-webhook-verification claim from the structured walk; drift to dropping 'Transport & egress' would lose the TLS + customer-egress claims)", () => {
    expect(body).toMatch(/Authentication &amp; access/);
    expect(body).toMatch(/Transport &amp; egress/);
    expect(body).toMatch(/Webhooks &amp; integrations/);
    expect(body).toMatch(/Data residency &amp; retention/);
    expect(body).toMatch(/Observability &amp; incident response/);
  });

  it("scrypt-hashed API keys claim pinned: 'API keys are scrypt-hashed at rest' + 'N=2^15, r=8, p=1' params + 'apps/server/src/lib/api-keys.ts · hashApiKey() / verifyApiKey()' code-path pointer — pinned so the scrypt-cost-params + the explicit code-path mapping survive (drift to dropping N=2^15 would obscure the cost-factor; drift to dropping the code-path would force buyers to take the claim on faith)", () => {
    expect(body).toMatch(/API keys are scrypt-hashed at rest/);
    expect(body).toMatch(/Hash params \(N=2\^15, r=8, p=1\)/);
    expect(body).toMatch(
      /apps\/server\/src\/lib\/api-keys\.ts · hashApiKey\(\) \/ verifyApiKey\(\)/,
    );
  });

  it('MFA claim pinned. Re-enabled by slice 256 after restoring the (V-353e) anchor on the Step-up gate sentence at security-overview.astro:62 (same anchor-stripped-to-bare-space drift pattern as slices 235-250)', () => {
    expect(body).toMatch(/MFA: TOTP \+ recovery codes/);
    expect(body).toMatch(
      /AES-256-GCM at-rest encryption of TOTP secrets\. Recovery\s*\n?\s*codes are scrypt-hashed \(mirroring API key handling\)\. Step-up\s*\n?\s*gate \(V-353e\) requires MFA on destructive admin paths\./,
    );
  });

  it("OAuth claim pinned: 'OAuth 2.0 (invite-only) with PKCE-S256' + 'no self-service client registration' + 'client_secret sha256-hashed at rest' + 'one-shot authorization codes' + 'opaque bearer tokens (no JWT)' — pinned so the invite-only + PKCE-S256 + secret-hash + one-shot + opaque-not-JWT 5-state OAuth posture survives (drift to dropping 'no self-service' would shift the trust model; drift to claiming JWT would create marketing↔engineering divergence)", () => {
    expect(body).toMatch(/OAuth 2\.0 \(invite-only\) with PKCE-S256/);
    expect(body).toMatch(
      /Third-party OAuth requires admin invitation \(no self-service\s*\n?\s*client registration\)\. PKCE-S256 mandatory; client_secret\s*\n?\s*sha256-hashed at rest; one-shot authorization codes; opaque\s*\n?\s*bearer tokens \(no JWT\)\./,
    );
  });

  it("Transport claim pinned: 'TLS 1.3 on every customer-facing path' + 'Cloudflare edge enforces TLS 1.3 strict' + 'No plaintext HTTP on any path; the deploy pipeline's TLS check rejects the release otherwise.' — pinned so the TLS-1.3-strict commitment + the deploy-pipeline-rejects-non-TLS enforcement survive (drift to softening 'No plaintext HTTP' would let HTTP slip into prod; drift to dropping the deploy-pipeline check would lose the automated guarantee)", () => {
    expect(body).toMatch(/TLS 1\.3 on every customer-facing path/);
    expect(body).toMatch(
      /Cloudflare edge enforces TLS 1\.3 strict to the\s*\n?\s*<code class="font-mono">api\.driftstack\.dev<\/code> \+\s*\n?\s*<code class="font-mono">app\.driftstack\.dev<\/code> origins\./,
    );
    expect(body).toMatch(
      /No plaintext HTTP on any path; the deploy pipeline's TLS\s*\n?\s*check rejects the release otherwise\./,
    );
  });

  it("Customer-configurable egress roadmap pinned: 'Customer-configurable egress (roadmap)' + 'SOCKS5 / WireGuard tunnels' + 'today, session network traffic exits via Driftstack's own EU network egress' + 'Driftstack does not log session-traffic payloads (destination URLs / response bodies)' — pinned so the honest-roadmap framing + SOCKS5/WireGuard scope + EU-egress-today + no-payload-logging commitments all survive (drift to claiming customer-egress now would over-promise pre-roadmap; drift to dropping 'no payload logging' would obscure the privacy commitment)", () => {
    expect(body).toMatch(/Customer-configurable egress \(roadmap\)/);
    expect(body).toMatch(
      /Per-account egress configuration \(SOCKS5 \/ WireGuard\s*\n?\s*tunnels\) is on the roadmap\. Today, session network\s*\n?\s*traffic exits via Driftstack's own EU network egress\./,
    );
    expect(body).toMatch(
      /Driftstack does not log session-traffic payloads\s*\n?\s*\(destination URLs \/ response bodies\); the proxy layer\s*\n?\s*forwards bytes without persisting them\./,
    );
  });

  it("Outbound webhook claim pinned: 'Outbound webhooks are HMAC-SHA256 signed' + 'X-Driftstack-Signature with timestamp + body HMAC' + 'replay attacks rejected via timestamp tolerance window' + 'apps/server/src/lib/webhook-signing.ts' — pinned so the HMAC-SHA256 + timestamp-replay-protection + code-path-mapping all survive (drift to dropping 'replay attacks rejected' would let webhook-replay become an unspecified attack surface)", () => {
    expect(body).toMatch(/Outbound webhooks are HMAC-SHA256 signed/);
    expect(body).toMatch(
      /<code class="font-mono">X-Driftstack-Signature<\/code>\s*\n?\s*with timestamp \+ body HMAC\./,
    );
    expect(body).toMatch(/replay attacks rejected via timestamp\s*\n?\s*tolerance window\./);
    expect(body).toMatch(/apps\/server\/src\/lib\/webhook-signing\.ts/);
  });

  it('Inbound webhook claim pinned. Re-enabled by slice 277 after restoring V-080 + V-487 anchors on trust/security-overview.astro:182 (both per-provider HMAC algorithm references were intact apart from the V-anchor prefix)', () => {
    expect(body).toMatch(
      /Stripe: V-080 timestamp\+sha256 HMAC\. NowPayments: V-487\s*\n?\s*HMAC-SHA512 on canonical-keyed JSON\. Shared raw-body\s*\n?\s*parser ensures the bytes the signature was computed over\s*\n?\s*are the bytes the verifier sees\./,
    );
  });

  it("EU-only data plane claim pinned: 'EU-only data plane' + 'Compute (Hetzner Nuremberg), database (Neon Frankfurt), object storage (Cloudflare R2 EU jurisdiction)' — pinned so the 3-sub-processor location specificity stays consistent with /trust/sub-processors + /trust (drift to dropping the explicit city/jurisdiction would weaken the data-residency credibility; drift to changing a sub-processor would create marketing↔sub-processor-register divergence)", () => {
    expect(body).toMatch(/EU-only data plane/);
    expect(body).toMatch(
      /Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s*\n?\s*object storage \(Cloudflare R2 EU jurisdiction\)\./,
    );
  });

  it('Capture retention roadmap (V-540) pinned. Re-enabled by slice 277 after restoring V-540 anchor at trust/security-overview.astro:225 (anchor was stripped from "land with — see" to bare space)', () => {
    expect(body).toMatch(/Capture retention \(roadmap\)/);
    expect(body).toMatch(
      /Today's API returns capture bytes inline; there is no\s*\n?\s*server-side capture retention layer to configure\.\s*\n?\s*Session recordings \+ their retention controls land\s*\n?\s*with V-540/,
    );
  });

  it("Account deletion claim pinned: 'Account deletion: 30-day grace, then hard delete' + 'Cancellation triggers soft-delete with 30 days of recovery. After that: hard delete of profile data, sessions, captures. Per our DPA.' — pinned so the 30-day grace + hard-delete scope (profile/sessions/captures) + DPA anchor all survive (drift to changing the 30-day window would create marketing↔DPA divergence; drift to dropping 'hard delete' would soften the deletion commitment)", () => {
    expect(body).toMatch(/Account deletion: 30-day grace, then hard delete/);
    expect(body).toMatch(
      /Cancellation triggers soft-delete with 30 days of\s*\n?\s*recovery\. After that: hard delete of profile data,\s*\n?\s*sessions, captures\. Per our DPA\./,
    );
  });

  it("Vulnerability disclosure 2d/5d claim pinned: 'Vulnerability disclosure: 2-day ack, 5-day triage' + 'Safe-harbour for good-faith research. Coordinated disclosure window: 90 days, extendable on agreement.' — pinned so the 2d-ack + 5d-triage + 90d-disclosure + safe-harbour-for-good-faith summary stays consistent with /trust/compliance (the canonical full policy)", () => {
    expect(body).toMatch(/Vulnerability disclosure: 2-day ack, 5-day triage/);
    expect(body).toMatch(
      /Safe-harbour for good-faith research\. Coordinated\s*\n?\s*disclosure window: 90 days, extendable on agreement\./,
    );
  });

  it("Chaos engineering claim pinned: 'Chaos engineering rehearsal harness' + 'Sub-processor outages, DB failover, Redis-down, webhook-signature failures' + 'scripts/chaos/' code-path + 'Drills run dry-run by default; execute mode requires explicit operator opt-in.' — pinned so the V-547 chaos-rehearsal commitment + the 4-scenario scope + the dry-run-default safety survive (drift to dropping 'dry-run by default' would let chaos drills land destructively in prod by accident). The previous skip pinned `· docs/internal/v547-chaos-engineering-scenarios.md` as a meta-line, but that internal-docs path was exposing internal repo structure on a customer-facing trust page — removed in the same slice that revives this assertion.", () => {
    expect(body).toMatch(/Chaos engineering rehearsal harness/);
    expect(body).toMatch(
      /Sub-processor outages, DB failover, Redis-down,\s*\n?\s*webhook-signature failures — all covered by scripted\s*\n?\s*drills in <code class="font-mono">scripts\/chaos\/<\/code>\./,
    );
    expect(body).toMatch(
      /Drills run dry-run by default; execute mode requires\s*\n?\s*explicit operator opt-in\./,
    );
    // Drift-guard: the internal-docs reference MUST NOT bleed back
    // into the customer-facing trust page. The bare `scripts/chaos/`
    // meta-line stays (that path is public-repo-public).
    expect(body).not.toMatch(/docs\/internal\/v547-chaos-engineering-scenarios/);
  });

  it("Cross-link to /security + /trust/compliance pinned: 'The architecture deep-dive at /security walks the five-pillar surface in detail. For pen-test evidence or compliance certifications, see /trust/compliance.' — pinned so the 3-page navigation (security-overview → security deep-dive → compliance) survives (drift to dropping either cross-link would orphan that page from the security-evaluation walk)", () => {
    expect(body).toMatch(
      /<a href="\/security" class="text-oxblood-700 underline">architecture deep-dive at \/security<\/a>\s*\n?\s*walks the five-pillar surface in detail\./,
    );
    expect(body).toMatch(
      /For pen-test\s*\n?\s*evidence or compliance certifications, see\s*\n?\s*<a href="\/trust\/compliance" class="text-oxblood-700 underline"\s*\n?\s*>\/trust\/compliance<\/a\s*\n?\s*>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
