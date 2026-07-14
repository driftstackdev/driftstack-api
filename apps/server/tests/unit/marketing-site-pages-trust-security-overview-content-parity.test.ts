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
//   • Data: EU control plane (session-execution fleet on MacStadium
//     US) + capture retention roadmap (V-540)
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
    // S20c 2026-07-06 plain-language pass: params kept, glossed as
    // the scrambler's strength settings.
    expect(body).toMatch(/hash params N=2\^15, r=8,\s+p=1/);
    expect(body).toMatch(
      /apps\/server\/src\/lib\/api-keys\.ts · hashApiKey\(\) \/ verifyApiKey\(\)/,
    );
  });

  it('MFA claim pinned. Re-enabled by slice 256 after restoring the (V-353e) anchor on the Step-up gate sentence at security-overview.astro:62 (same anchor-stripped-to-bare-space drift pattern as slices 235-250)', () => {
    expect(body).toMatch(/MFA: TOTP \+ recovery codes/);
    // S20c 2026-07-06 plain-language pass (founder jargon audit):
    // TOTP glossed as authenticator-app codes, step-up said plainly.
    // The internal ticket anchor (V-353e) is deliberately REMOVED
    // from customer-facing copy — it read as a typo to buyers. This
    // is a copy decision, not the anchor-stripped-to-bare-space
    // corruption slices 235-256 fixed: the sentence is grammatical
    // and the step-up-on-destructive-admin-paths claim is intact.
    expect(body).toMatch(
      /Two-factor login uses authenticator-app codes \(TOTP\)\.\s+The seed that generates your codes is stored encrypted\s+\(AES-256-GCM at-rest encryption of TOTP secrets\)\.\s+Recovery codes are scrypt-hashed — one-way scrambled,\s+mirroring API key handling\. Dangerous admin actions\s+demand a fresh MFA check even if you're already signed\s+in \(a "step-up" gate on destructive admin paths\)\./,
    );
    expect(body).not.toMatch(/V-353e/);
  });

  it("OAuth claim pinned: 'OAuth 2.0 (invite-only) with PKCE-S256' + 'no self-service client registration' + 'client_secret sha256-hashed at rest' + 'one-shot authorization codes' + 'opaque bearer tokens (no JWT)' — pinned so the invite-only + PKCE-S256 + secret-hash + one-shot + opaque-not-JWT 5-state OAuth posture survives (drift to dropping 'no self-service' would shift the trust model; drift to claiming JWT would create marketing↔engineering divergence)", () => {
    expect(body).toMatch(/OAuth 2\.0 \(invite-only\) with PKCE-S256/);
    // S20c 2026-07-06 plain-language pass: all 5 OAuth posture
    // states survive with inline glosses.
    expect(body).toMatch(
      /Third-party app access \(OAuth\) requires admin invitation\s+\(no self-service\s+client registration\)\. Every connection uses PKCE-S256 —\s+an extra proof that the app finishing a login is the\s+same one that started it\. App secrets \(client_secret\)\s+are sha256-hashed at rest; login codes work exactly once\s+\(one-shot authorization codes\); and access tokens are\s+opaque random strings \(no JWT\), so a stolen token\s+carries no readable data\./,
    );
  });

  it("Transport claim pinned: 'TLS 1.3 on every customer-facing path' + 'Cloudflare edge enforces TLS 1.3 strict' + 'No plaintext HTTP on any path; the deploy pipeline's TLS check rejects the release otherwise.' — pinned so the TLS-1.3-strict commitment + the deploy-pipeline-rejects-non-TLS enforcement survive (drift to softening 'No plaintext HTTP' would let HTTP slip into prod; drift to dropping the deploy-pipeline check would lose the automated guarantee)", () => {
    expect(body).toMatch(/TLS 1\.3 on every customer-facing path/);
    // S20c 2026-07-06 plain-language pass: strict TLS 1.3 + the
    // deploy-gate enforcement survive; plain words lead.
    expect(body).toMatch(
      /Cloudflare, our edge network, enforces strict TLS 1\.3\s+encryption all the way to our own servers behind\s+<code class="font-mono">api\.driftstack\.dev<\/code> \+\s+<code class="font-mono">app\.driftstack\.dev<\/code> \(the\s+origins\)\./,
    );
    expect(body).toMatch(
      /No unencrypted page \(plaintext HTTP\) exists on\s+any path — every release is automatically checked for\s+this before it ships; the deploy pipeline's TLS\s+check rejects the release otherwise\./,
    );
  });

  it("Customer-configurable egress SHIPPED per profile (SOCKS5 with UDP/WebRTC/QUIC + OpenVPN + WireGuard). 2026-05-22 — was '(roadmap)'; flipped to '(per profile)' + emerald checkmark per planning 133 Phase 1 + SocksProxyBackend wired in bootstrap. EU-egress-fallback + no-payload-logging commitments preserved.", () => {
    expect(body).toMatch(/Customer-configurable egress \(per profile\)/);
    expect(body).toMatch(/a SOCKS5 proxy with full\s+UDP\/WebRTC\/QUIC tunnelling/); // S20c 2026-07-06
    expect(body).toMatch(/an OpenVPN\s+file \(\.ovpn\)/); // S20c 2026-07-06
    expect(body).toMatch(/a WireGuard file \(\.conf\)/); // S20c 2026-07-06
    expect(body).toMatch(
      /Without an attached config, session traffic exits via\s*\n?\s*Driftstack's own EU network egress/,
    );
    // S20c 2026-07-06 plain-language pass: same no-payload-logging
    // commitment, payloads spelled out plainly.
    expect(body).toMatch(
      /Driftstack does\s+not log session-traffic payloads \(the destination URLs\s+you visit, the page content that comes back\); the proxy\s+layer passes traffic through without storing it\./,
    );
  });

  it("Outbound webhook claim pinned: 'Outbound webhooks are HMAC-SHA256 signed' + 'X-Driftstack-Signature with timestamp + body HMAC' + 'replay attacks rejected via timestamp tolerance window' + 'apps/server/src/lib/webhook-signing.ts' — pinned so the HMAC-SHA256 + timestamp-replay-protection + code-path-mapping all survive (drift to dropping 'replay attacks rejected' would let webhook-replay become an unspecified attack surface)", () => {
    expect(body).toMatch(/Outbound webhooks are HMAC-SHA256 signed/);
    // S20c 2026-07-06 plain-language pass: webhook defined, HMAC +
    // replay-rejection facts survive.
    expect(body).toMatch(
      /<code class="font-mono">X-Driftstack-Signature<\/code> —\s+a cryptographic signature \(HMAC\) over the timestamp \+\s+message body\./,
    );
    expect(body).toMatch(
      /messages older than the allowed timestamp tolerance\s+window are rejected, so an intercepted copy can't be\s+re-sent later \(replay attacks\)/,
    );
    expect(body).toMatch(/apps\/server\/src\/lib\/webhook-signing\.ts/);
  });

  it('Inbound webhook claim pinned. Re-enabled by slice 277 after restoring V-080 + V-487 anchors on trust/security-overview.astro:182 (both per-provider HMAC algorithm references were intact apart from the V-anchor prefix)', () => {
    // S20c 2026-07-06 plain-language pass (founder jargon audit):
    // the internal ticket anchors (V-080 / V-487) are deliberately
    // REMOVED from customer-facing copy — meaningless to buyers and
    // read as typos. Deliberate copy decision (grammatical text),
    // not the anchor-stripped corruption slice 277 fixed. Both
    // per-provider HMAC algorithms + the raw-body guarantee survive.
    expect(body).toMatch(
      /Stripe: timestamp \+\s+sha256 HMAC\. NowPayments: HMAC-SHA512 over the\s+normalised \(canonical-keyed\) JSON\. A shared raw-body\s+parser ensures the exact bytes the signature was\s+computed over are the bytes the verifier sees/,
    );
    expect(body).not.toMatch(/V-080|V-487/);
  });

  it("EU control plane claim pinned: 'EU control plane' + 'Compute (Hetzner Nuremberg), database (Neon Frankfurt), object storage (Cloudflare R2, EU + US replication)' + session-execution fleet on MacStadium US — S30 2026-07-07 (founder decision: soften) supersedes the prior 'R2 EU jurisdiction' pin: R2 uses the DEFAULT jurisdiction (verified on the prod box, task #24); wording now matches /docs/data-residency's 'EU + US replication'. The 3-sub-processor location specificity survives. The data plane is NOT EU-only: the iPhone Safari driver fleet runs on MacStadium (US).", () => {
    expect(body).toMatch(/EU control plane/);
    expect(body).not.toMatch(/EU-only data plane/);
    expect(body).toMatch(
      /Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s*\n?\s*object storage \(Cloudflare R2, EU \+ US replication\)\./,
    );
    // S30 negative pin — the false jurisdiction claim must not return.
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
    // S20c 2026-07-06 plain-language pass: SCCs glossed inline.
    expect(body).toMatch(
      /iPhone Safari session-execution fleet runs on MacStadium\s+hardware \(US\) under SCCs \(the EU's Standard Contractual\s+Clauses for lawful data transfer abroad\) \+ the EU-US\s+Data Privacy Framework/,
    );
  });

  it('Capture retention roadmap (V-540) pinned. Re-enabled by slice 277 after restoring V-540 anchor at trust/security-overview.astro:225 (anchor was stripped from "land with — see" to bare space)', () => {
    expect(body).toMatch(/Capture retention \(roadmap\)/);
    // S20c 2026-07-06 plain-language pass (founder jargon audit):
    // the V-540 internal ticket anchor is deliberately REMOVED from
    // customer-facing copy ("on the roadmap" carries the state);
    // grammatical, deliberate — not the stripped-anchor corruption
    // slice 277 fixed. The nothing-retained-today honesty survives.
    expect(body).toMatch(
      /Today, screenshots and captures are returned directly\s+inside the API response \(inline bytes\) and are not kept\s+on our servers afterwards — so there is no retention\s+setting to configure yet\. Stored session recordings,\s+with controls over how long they're kept, are on the\s+roadmap/,
    );
    expect(body).not.toMatch(/V-540/);
  });

  it("Account deletion claim pinned: 'Account deletion: 30-day grace, then hard delete' + 'Cancellation triggers soft-delete with 30 days of recovery. After that: hard delete of profile data, sessions, captures. Per our DPA.' — pinned so the 30-day grace + hard-delete scope (profile/sessions/captures) + DPA anchor all survive (drift to changing the 30-day window would create marketing↔DPA divergence; drift to dropping 'hard delete' would soften the deletion commitment)", () => {
    expect(body).toMatch(/Account deletion: 30-day grace, then hard delete/);
    // S20c 2026-07-06 plain-language pass: soft/hard delete said
    // plainly, terms kept; same 30-day + DPA facts.
    expect(body).toMatch(
      /For 30 days after cancellation your data is only\s+flagged as deleted \("soft-delete"\) and can be restored\s+if you come back\. After that it is permanently erased\s+\(hard delete\) — profile data, sessions, captures\. Per\s+our DPA\./,
    );
  });

  it("Vulnerability disclosure 2d/5d claim pinned: 'Vulnerability disclosure: 2-day ack, 5-day triage' + 'Safe-harbour for good-faith research. Coordinated disclosure window: 90 days, extendable on agreement.' — pinned so the 2d-ack + 5d-triage + 90d-disclosure + safe-harbour-for-good-faith summary stays consistent with /trust/compliance (the canonical full policy)", () => {
    // S20c 2026-07-06 plain-language pass: ack/triage/safe-harbour/
    // 90-day window all survive, said plainly with terms kept.
    expect(body).toMatch(/Vulnerability reports: acknowledged in 2 days, assessed in 5 \(triage\)/);
    expect(body).toMatch(
      /We won't take legal action against good-faith research\s+\("safe-harbour"\)\. Reporters agree to keep a finding\s+private for 90 days while we fix it \(the coordinated\s+disclosure window\), extendable on agreement\./,
    );
  });

  it("Chaos engineering claim pinned: 'Chaos engineering rehearsal harness' + 'Sub-processor outages, DB failover, Redis-down, webhook-signature failures' + 'scripts/chaos/' code-path + 'Drills run dry-run by default; execute mode requires explicit operator opt-in.' — pinned so the V-547 chaos-rehearsal commitment + the 4-scenario scope + the dry-run-default safety survive (drift to dropping 'dry-run by default' would let chaos drills land destructively in prod by accident). The previous skip pinned `· docs/internal/v547-chaos-engineering-scenarios.md` as a meta-line, but that internal-docs path was exposing internal repo structure on a customer-facing trust page — removed in the same slice that revives this assertion.", () => {
    // S20c 2026-07-06 plain-language pass: heading leads plain with
    // the term in parens; 4-scenario scope + dry-run default kept.
    expect(body).toMatch(/We rehearse failures on purpose \(chaos engineering\)/);
    expect(body).toMatch(
      /Vendor \(sub-processor\) outages, the database switching\s+to its backup \(DB failover\), the Redis cache going down,\s+webhook-signature failures — all covered by scripted\s+drills in <code class="font-mono">scripts\/chaos\/<\/code>\./,
    );
    expect(body).toMatch(
      /Drills run as simulations by default \(dry-run\); actually\s+breaking things \(execute mode\) requires\s+explicit operator opt-in\./,
    );
    // Drift-guard: the internal-docs reference MUST NOT bleed back
    // into the customer-facing trust page. The bare `scripts/chaos/`
    // meta-line stays (that path is public-repo-public).
    expect(body).not.toMatch(/docs\/internal\/v547-chaos-engineering-scenarios/);
  });

  // S26 2026-07-06 (#132) — re-pinned "five-pillar" → "six-pillar":
  // /security renders SIX pillars (01 Transport / 02 Egress / 03 API
  // keys / 04 Webhooks / 05 Team roles / 06 No-customer-data-access);
  // the old pin locked a stale count.
  it("Cross-link to /security + /trust/compliance pinned: 'The architecture deep-dive at /security walks the six-pillar surface in detail. For pen-test evidence or compliance certifications, see /trust/compliance.' — pinned so the 3-page navigation (security-overview → security deep-dive → compliance) survives (drift to dropping either cross-link would orphan that page from the security-evaluation walk). Fleet v2 (S10): link tone moved to the AA-safe text-tk-accent-text", () => {
    expect(body).toMatch(
      /<a href="\/security\/" class="text-tk-accent-text underline">architecture deep-dive at \/security<\/a>\s*\n?\s*walks the six-pillar surface in detail\./,
    );
    expect(body).not.toMatch(/five-pillar/);
    expect(body).toMatch(
      /For pen-test\s*\n?\s*evidence or compliance certifications, see\s*\n?\s*<a href="\/trust\/compliance\/" class="text-tk-accent-text underline"\s*\n?\s*>\/trust\/compliance<\/a\s*\n?\s*>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
