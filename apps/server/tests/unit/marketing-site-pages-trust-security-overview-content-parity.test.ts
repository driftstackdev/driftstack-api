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
      /\/\/ V-670 \(V-550 follow-up\) — public security overview as an evaluator\s*\/\/ checklist\. \/security is the architecture deep-dive; this page is\s*\/\/ the buyer-evaluation companion — every security claim mapped to\s*\/\/ its verifiable evidence \(code path, test, public doc link\)\. The\s*\/\/ goal: a prospective customer's CISO can self-serve a security\s*\/\/ review without scheduling a call\./,
    );
  });

  it("5-section evaluator-checklist taxonomy: 'Authentication & access' + 'Transport & egress' + 'Webhooks & integrations' + 'Data residency & retention' + 'Observability & incident response' — pinned so the 5-section CISO-checklist surface stays complete (drift to dropping 'Webhooks & integrations' would orphan the inbound-webhook-verification claim from the structured walk; drift to dropping 'Transport & egress' would lose the TLS + customer-egress claims)", () => {
    expect(body).toMatch(/Authentication &amp; access/);
    expect(body).toMatch(/Transport &amp; proxies/); // 2026-09-15: "egress" → plain "proxies"
    expect(body).toMatch(/Webhooks &amp; integrations/);
    expect(body).toMatch(/Data residency &amp; retention/);
    expect(body).toMatch(/Monitoring &amp; incident response/); // 2026-09-15: "Observability" → plain "Monitoring"
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
      /Two-factor login uses authenticator-app codes \(TOTP\)\.\s+The seed that generates your codes is stored encrypted\s+\(AES-256-GCM at-rest encryption of TOTP secrets\)\.\s+Recovery codes are scrypt-hashed — one-way scrambled,\s+mirroring API key handling\. Dangerous admin actions\s+demand a fresh MFA check even if you're already signed\s+in \(a "step-up" check before risky admin actions\)\./,
    );
    expect(body).not.toMatch(/V-353e/);
    // 2026-09-15: the step-up freshness window (routes/account-mfa.ts:
    // "hasn't satisfied MFA in the last 15 min"; /docs/security-overview
    // pins the same 15 minutes).
    expect(body).toMatch(/check stays fresh for 15 minutes\./);
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
    // 2026-09-15: "strict TLS 1.3" was wrong against the origin config
    // (infra/nginx/*.conf: ssl_protocols TLSv1.2 TLSv1.3) and /security
    // ("TLS 1.2 + 1.3"); the page now states the real floor in plain words.
    expect(body).toMatch(/Every connection is encrypted \(TLS 1\.2 or newer\)/);
    expect(body).toMatch(
      /\(<code class="font-mono">api\.driftstack\.dev<\/code> and\s+<code class="font-mono">app\.driftstack\.io<\/code>\) is\s+encrypted with TLS 1\.2 or newer, through Cloudflare, our\s+edge network\./,
    );
    expect(body).toMatch(
      /No unencrypted \(plain HTTP\) page exists on\s+any path, and every release is checked for this\s+automatically before it ships\./,
    );
    expect(body).not.toMatch(/strict TLS 1\.3/);
  });

  it("Customer-configurable egress SHIPPED per profile (SOCKS5 with UDP/WebRTC/QUIC + OpenVPN + WireGuard). 2026-05-22 — was '(roadmap)'; flipped to '(per profile)' + emerald checkmark per planning 133 Phase 1 + SocksProxyBackend wired in bootstrap. EU-egress-fallback + no-payload-logging commitments preserved.", () => {
    // 2026-09-15 plain-language pass: same shipped claim in customer words;
    // "full UDP/WebRTC/QUIC tunnelling" overpromised against /security
    // ("depends on the proxy's reported UDP capability") and is retired.
    expect(body).toMatch(/Your own proxy or VPN, per profile/);
    // 2026-09-15 refuter: the Test cannot MEASURE HTTP/3 — the native probe
    // has no QUIC signal and apps/gui-client/src/components/
    // ProxyCapabilities.tsx renders it as an inference ("~", never green)
    // until a session or relay check measured it; a VPN row's Test is a DNS
    // resolve + tunnel test (ProfilePhoneCard.tsx). The readout is listed as
    // what it is: reachability, latency, exit geo, WebRTC, an HTTP/3 estimate,
    // and the OS fingerprint where measurable.
    expect(body).toMatch(
      /Whether UDP, WebRTC and QUIC\s+traffic travels through a SOCKS5 proxy depends on what\s+your proxy supports: the proxy's Test reports whether it\s+answers, its latency, the country and city it exits from,\s+whether it can carry WebRTC, what to expect for HTTP\/3 \(an\s+estimate until it has been measured\)/,
    );
    expect(body).not.toMatch(/Test reports HTTP\/3/);
    expect(body).not.toMatch(/full\s+UDP\/WebRTC\/QUIC tunnelling/);
    expect(body).toMatch(/an OpenVPN\s+file \(\.ovpn\)/); // S20c 2026-07-06
    expect(body).toMatch(/a WireGuard\s+file \(\.conf\)/); // S20c 2026-07-06
    // 2026-09-15 truth pass: the desktop app never launches without an
    // attached proxy (apps/gui-client/src/views/ProfilesView.tsx), the
    // pre-launch check is described per scheme (live connection for SOCKS5 to
    // our own echo endpoint, apps/server/src/services/
    // proxy-connectivity-probe.ts → /v1/egress/echo; directive sweep for an
    // OpenVPN file, packages/api-types/src/openvpn-directives.ts; a WireGuard
    // .conf is parsed GUI-side into structured fields with its PostUp/PreUp
    // hooks read but never consulted, apps/gui-client/src/lib/
    // parse-wireguard.ts), and the proxy-secret encryption
    // (apps/server/src/lib/account-proxy-secret-encryption.ts, aes-256-gcm)
    // + the Test readouts (apps/gui-client/src/components/
    // ProxyCapabilities.tsx / OsReadout.tsx) are pinned.
    // 2026-09-15 refuter: the "managed exit" fallback was an INVENTED feature —
    // no Driftstack-run exit is configured for production (infra/env-templates/
    // production.env.template leaves DEFAULT_EGRESS_HOST/PORT empty on purpose:
    // "UNSET IS VALID AND DELIBERATE"; production.env carries no DEFAULT_EGRESS_*
    // line; apps/server/src/routes/agent-sessions.ts dispatches NO proxy when
    // proxy_id is omitted and a REQUIRE_PROXY=1 node refuses by name). The page
    // now says an API session names a saved proxy and that no shared Driftstack
    // exit exists; the old clause is negatively pinned so it cannot return.
    // 2026-09-15 refuter: VPN exits are tier-gated (TIER_FEATURES.free.vpnEgress
    // = false; routes/account-me.ts requireTierFeature('vpnEgress')), and the
    // line-naming refusal is OpenVPN-only (packages/api-types/src/
    // openvpn-directives.ts); a WireGuard .conf is parsed GUI-side into
    // structured fields and its PostUp/PreUp hooks are read but never consulted
    // (apps/gui-client/src/lib/parse-wireguard.ts). Both are now stated.
    expect(body).toMatch(
      /desktop app launches a\s+profile only through a proxy or VPN you attach; a session\s+created through the API names one of your saved proxies by\s+its proxy_id\. Driftstack does not route your traffic through\s+a shared exit of its own\./,
    );
    expect(body).not.toMatch(/managed exit/);
    expect(body).toMatch(/file \(\.conf\) — VPN exits are on paid plans\./);
    expect(body).toMatch(
      /to our own address-echo endpoint, so your exit address is\s+never sent to a third-party checker/,
    );
    expect(body).toMatch(
      /directives that would run a program, which are refused\s+with the offending line named/,
    );
    expect(body).toMatch(
      /a WireGuard file by reading\s+only its keys, addresses, endpoint, allowed IPs, DNS and\s+MTU, so its PostUp\/PreUp hooks are never used/,
    );
    expect(body).not.toMatch(/a VPN file for\s+directives/);
    expect(body).toMatch(/Proxy passwords and VPN keys are\s+stored encrypted \(AES-256-GCM\)/);
    expect(body).toMatch(
      /where it can be\s+measured — which operating system the exit appears to run/,
    );
    expect(body).toMatch(
      /apps\/server\/src\/services\/proxy-connectivity-probe\.ts · apps\/server\/src\/lib\/account-proxy-secret-encryption\.ts · packages\/api-types\/src\/openvpn-directives\.ts/,
    );
    // No-page-content-storage commitment (aligned with /security: "We never
    // store destination response bodies"). Destination URLs ARE processed and
    // recorded per the /trust FAQ, so the old "does not log ... destination
    // URLs" line contradicted the trust index and is retired.
    expect(body).toMatch(
      /Driftstack does not store the content of\s+the pages your sessions load\./,
    );
    expect(body).not.toMatch(/does\s+not log session-traffic payloads/);
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
    // 2026-09-15 plain-language pass: both algorithms + the exact-bytes
    // guarantee survive; "canonical-keyed" / "shared raw-body parser" were
    // implementation words.
    expect(body).toMatch(
      /Stripe: timestamp \+\s+HMAC-SHA256\. NowPayments: HMAC-SHA512 over the normalised\s+JSON\. The signature check runs over the exact bytes we\s+received, so a message altered in transit is rejected\./,
    );
    expect(body).not.toMatch(/V-080|V-487/);
  });

  it("EU control plane claim pinned: 'EU control plane' + 'Compute (Hetzner Nuremberg), database (Neon Frankfurt), object storage (Cloudflare R2, EU + US replication)' + session-execution fleet on MacStadium US — S30 2026-07-07 (founder decision: soften) supersedes the prior 'R2 EU jurisdiction' pin: R2 uses the DEFAULT jurisdiction (verified on the prod box, task #24); wording now matches /docs/data-residency's 'EU + US replication'. The 3-sub-processor location specificity survives. The data plane is NOT EU-only: the iPhone Safari driver fleet runs on MacStadium (US).", () => {
    // 2026-09-15 owner directive: "control plane" / "fleet" are banned on
    // customer surfaces; the heading now says what is hosted in the EU, and
    // "Nuremberg" is corrected to Falkenstein per the sub-processor register.
    expect(body).toMatch(/Core services hosted in the EU/);
    expect(body).not.toMatch(/control plane|fleet/i);
    expect(body).not.toMatch(/EU-only data plane/);
    expect(body).toMatch(
      /Servers in Falkenstein, Germany \(Hetzner\); database in\s*Frankfurt \(Neon\); file storage on Cloudflare R2, which\s*keeps copies in both the EU and the US\./,
    );
    expect(body).not.toMatch(/Nuremberg/);
    // S30 negative pin — the false jurisdiction claim must not return.
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
    // US execution + legal transfer basis survive in plain words.
    expect(body).toMatch(
      /iPhone Safari\s+sessions run on US infrastructure \(MacStadium\) under the\s+EU's Standard Contractual Clauses \(SCCs\) and the EU-US\s+Data Privacy Framework/,
    );
  });

  it('pins direct API captures and operator-local desktop recordings', () => {
    expect(body).toMatch(/Direct captures and local recordings/);
    // 2026-09-15 plain-language pass: same boundary (capture service keeps no
    // copy; recordings never leave the customer's computer via the recording
    // feature), customer words.
    // 2026-09-15 refuter: "not stored" is true for POST /v1/sessions/:id/capture
    // only. In an AI-agent session every screenshot step IS retained — the
    // executor puts the bytes in a bounded in-memory SessionCaptureStore
    // (apps/server/src/services/session-capture-store.ts: CAPTURES_PER_SESSION =
    // 20, CAPTURE_SESSION_TTL_MS = 30 min, Map only — never disk) so the desktop
    // app can fetch GET /v1/agent-sessions/:id/captures/:captureId. The page
    // scopes the no-retention claim to the sessions API and discloses the agent
    // path.
    expect(body).toMatch(
      /Screenshots and other captures you request through the\s+sessions API are returned to you directly in the response,\s+and the capture service keeps no copy — you decide where to\s+store them\. In an AI-agent session the screenshot from each\s+step is held in server memory for up to 30 minutes \(at most\s+20 per session\) so the desktop app can show it, then dropped;\s+it is never written to disk\.\s+Desktop recordings are saved only on your own computer; the\s+recording feature never uploads them\./,
    );
    expect(body).toMatch(/apps\/server\/src\/services\/session-capture-store\.ts/);
    expect(body).not.toMatch(/roadmap|V-540/i);
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

  it("Chaos engineering claim pinned: 'Chaos engineering rehearsal harness' + 'Sub-processor outages, DB failover, Redis-down, webhook-signature failures' + 'scripts/chaos/' code-path + 'Drills run dry-run by default; execute mode requires explicit operator opt-in.' — pinned so the V-547 chaos-rehearsal commitment + the 4-scenario scope + the dry-run-default safety survive (drift to dropping 'dry-run by default' would let chaos drills land destructively in prod by accident). The previous skip pinned an internal chaos-scenarios design-note path as a meta-line, but that internal-docs path was exposing internal repo structure on a customer-facing trust page — removed in the same slice that revives this assertion.", () => {
    // S20c 2026-07-06 plain-language pass: heading leads plain with
    // the term in parens; 4-scenario scope + dry-run default kept.
    expect(body).toMatch(/We rehearse failures on purpose \(chaos engineering\)/);
    // 2026-09-15 plain-language pass: same four failure classes + simulation
    // default; the repo path stays on the evidence line below the paragraph.
    expect(body).toMatch(
      /Vendor outages, the database switching to its backup,\s+the cache going down, webhook-signature failures — each\s+is covered by a scripted drill\./,
    );
    expect(body).toMatch(
      /Drills run as simulations\s+by default; actually breaking things requires a\s+deliberate, explicit decision by our team\./,
    );
    expect(body).toMatch(/scripts\/chaos\//);
    // Drift-guard: the internal-docs reference MUST NOT bleed back
    // into the customer-facing trust page. The bare `scripts/chaos/`
    // meta-line stays (that path is public-repo-public).
    expect(body).not.toMatch(/docs\/internal\/v547-chaos-engineering-scenarios/);
  });

  // S26 2026-07-06 (#132) — re-pinned "five-pillar" → "six-pillar":
  // /security renders SIX pillars (01 Transport / 02 Egress / 03 API
  // keys / 04 Webhooks / 05 Team roles / 06 No-customer-data-access);
  // the old pin locked a stale count.
  it('cross-links the architecture deep-dive and current compliance/disclosure page', () => {
    expect(body).toMatch(
      /<a href="\/security\/" class="text-tk-accent-text underline">architecture deep-dive at \/security<\/a>\s*explains all six security promises in detail\./,
    );
    expect(body).not.toMatch(/five-pillar|six-pillar surface/);
    expect(body).toMatch(
      /For current compliance\s*status and vulnerability reporting, see\s*<a href="\/trust\/compliance\/" class="text-tk-accent-text underline"\s*>\/trust\/compliance<\/a\s*>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
