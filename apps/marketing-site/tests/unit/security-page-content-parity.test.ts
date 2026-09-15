// W365.A — drift guard for marketing-site /security page (the
// public-facing security landing). V-503. The docs/security-
// overview parity test pins the deeper /docs surface; this
// guard pins the marketing-tier claims a prospective customer's
// security team reads before signing.
//
// Pinned:
//   • 6 numbered pillar slots present (transport / egress /
//     api-keys / webhooks / team-rbac / live-media-handling).
//   • Egress is framed as the SHIPPED per-profile SOCKS5 exit, with
//     UDP/QUIC routing + remote DNS stated as PROXY-DEPENDENT (the
//     only egress backend wired server-side is SocksProxyBackend)
//     — load-bearing honesty claim.
//   • Scrypt logN=15 + 30s sha256-keyed auth cache claims pinned
//     (specific, falsifiable security parameters).
//   • Webhook signature shape t=<timestamp>,v1=<hex> + 5-minute
//     replay window pinned ↔ V-359 contract.
//   • "What we don't claim" honesty block: no SOC 2 + no ISO
//     27001 + EU-default residency pinned.
//   • Sub-processor disclosure: the page cross-links the live
//     register at /trust/sub-processors, and the register data
//     module itself carries every vendor (Hetzner, Neon, Upstash,
//     Cloudflare, Postmark, Sentry, Stripe, Anthropic, Moneybird,
//     MacStadium, LiveKit, NowPayments).
//   • Threat-model in/out scope structure pinned (5 in-scope +
//     4 out-of-scope buckets).
//   • Cross-link to /v1/account/audit-log/export (GDPR Article
//     20) for audit-trail self-service.
//   • mailto:security@driftstack.dev "no NDAs" commitment pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W365.A marketing-site /security page parity', () => {
  const body = read(PAGE);

  it('6 numbered pillar slots present (transport / egress / api-keys / webhooks / rbac / live-media). 2026-07-17 (e36e5b4e2) — pillar 06 renamed from "No-customer-data-access posture" to "Live-media handling": the old pillar claimed screenshots / DOM snapshots / cookies "never reach our servers", which the Capture endpoint contradicts (they pass through the API inline and are simply not retained). The narrower implemented boundary is pinned here; the overclaimed label is negatively pinned so it cannot return.', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Proxies/); // 2026-09-15: plain label; glossary "egress" linked in the body
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team roles \(RBAC\)/); // S20c 2026-07-06: plain words lead, RBAC kept in parens
    expect(body).toMatch(/06 · Live-media handling/);
    expect(body).toMatch(/Live-session media is not retained by default\./);
    expect(body).not.toMatch(/06 · No-customer-data-access posture/);
    expect(body).not.toMatch(/none of it ever reaches our servers/);
  });

  it('egress framed as the SHIPPED per-profile SOCKS5 exit, with UDP/QUIC + remote DNS stated as proxy-dependent. 2026-07-17 (e36e5b4e2) — OpenVPN / WireGuard pins retired: no server-side egress backend exists (only SocksProxyBackend implements SessionEgressService), the pre-launch proxy gate skips VPN schemes, and the green sibling guard apps/server/tests/unit/security-page-doc-parity.test.ts (W246.A) forbids both words on this page. The unconditional "UDP/WebRTC/QUIC tunnelling" + "DNS leaks blocked" absolutes are negatively pinned — the impl makes both proxy-capability-dependent.', () => {
    // 2026-09-15 plain-language pass: same facts, customer words.
    expect(body).toMatch(/02 · Proxies/);
    expect(body).toMatch(/A profile can attach a SOCKS5 proxy at a public address as its\s+exit/);
    expect(body).toMatch(/Per-profile SOCKS5; UDP support shown once the session is running\./);
    // Fail-closed limitation disclosures — load-bearing.
    expect(body).toMatch(/website address lookups go through the proxy\s+too/);
    expect(body).toMatch(/Proxies on\s+private or local addresses[\s\S]{0,90}are not accepted/);
    expect(body).toMatch(
      /Whether WebRTC and HTTP\/3\s+traffic can use the proxy depends on your proxy's UDP support/,
    );
    expect(body).toMatch(
      /Without a proxy\s+attached, session traffic exits through Driftstack's managed\s+exit/,
    );
    expect(body).toMatch(/We never store the pages your sessions visit/);
    // The two claims the implementation contradicts must stay gone.
    expect(body).not.toMatch(/DNS\s+leaks blocked/);
    expect(body).not.toMatch(/that many proxies drop/);
  });

  it('scrypt + 30s auth cache claims pinned (falsifiable claims; the logN=15 parameter lives on docs/security-overview)', () => {
    // 2026-09-15 plain-language pass: the tuning parameter and the
    // cache-key hash moved off the plain-terms page (see
    // security-scrypt-claim-parity for the logN pin); the algorithm
    // name, the 30-second window and the no-recovery-path claim stay.
    expect(body).toMatch(/API keys are scrambled one-way with scrypt/);
    expect(body).toMatch(
      /a key that was just checked is remembered in\s+protected short-term memory for 30 seconds/,
    );
    // The "Plaintext is returned exactly once" claim is the same
    // promise customer-dashboard /api-keys makes — load-bearing.
    expect(body).toMatch(/The readable key is shown exactly\s+once, when you create it/);
  });

  it('webhook signature shape t=<timestamp>,v1=<hex> + 5-min replay window pinned (V-359)', () => {
    expect(body).toMatch(
      /Driftstack-Signature header[\s\S]{0,80}t=&lt;timestamp&gt;,v1=&lt;hex&gt;/,
    );
    // S20c 2026-07-06: same 5-minute replay window, plain words lead.
    expect(body).toMatch(
      /Messages older than the default 5-minute timestamp\s+tolerance are rejected, so an intercepted copy can't be\s+re-sent later \("replay"\)/,
    );
    expect(body).toMatch(/verifyWebhookSignature/);
  });

  it('"What we don\'t claim" honesty block pinned (no SOC 2 / no ISO 27001 / EU-default)', () => {
    expect(body).toMatch(/<strong class="block text-tk-ink">No SOC 2\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-tk-ink">No ISO 27001\.<\/strong>/);
    expect(body).toMatch(
      /<strong class="block text-tk-ink">Data residency is EU-default\.<\/strong>/,
    );
    // EU-default stack disclosed.
    // S20c 2026-07-06: FSN datacenter code spelled out for non-engineers.
    // S30 2026-07-07 (founder decision: soften): "Cloudflare R2 EU"
    // dropped from the in-the-EU parenthetical — R2 file objects live
    // in the default jurisdiction and can replicate outside the EU.
    // 2026-09-15 plain-language pass: "Compute" -> "Servers", the
    // city dropped (this page said Falkenstein while /trust said
    // Nuremberg; the country is what the customer needs).
    expect(body).toMatch(
      /Servers and database are in the EU \(Hetzner, Germany; Neon EU;\s+Upstash EU\)\./,
    );
    expect(body).toMatch(
      /Uploaded files \(avatars, for example\) are on\s+Cloudflare R2, which can keep copies outside the EU\./,
    );
    // S30 negative pin — the blanket claim must not silently return.
    expect(body).not.toMatch(/Compute, database, object storage all in the EU/);
  });

  it('sub-processor disclosure resolves to the canonical live register (page links it; the register carries every vendor)', () => {
    // 2026-07-17 (e36e5b4e2): the page stopped duplicating a 10-name
    // inline list. That list had gone STALE and UNDER-disclosed — the
    // register also carries LiveKit (live-session media relay) and
    // NowPayments (crypto checkout). The vendor pins therefore move to
    // the register the Article 28(2) notices are cut from; the page
    // keeps the pointer + the completeness claim + a negative pin so a
    // partial inline list cannot come back.
    const register = read(resolve(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts'));
    for (const sp of [
      'Hetzner',
      'Neon',
      'Upstash',
      'Cloudflare',
      'Postmark',
      'Sentry',
      'Stripe',
      'Anthropic',
      'Moneybird',
      'MacStadium',
      'LiveKit',
      'NowPayments',
    ]) {
      expect(register).toContain(sp);
    }
    expect(body).toMatch(
      /live register lists every provider with its purpose, region,\s+and transfer mechanism/,
    );
    expect(body).toMatch(/including conditional services/);
    expect(body).toContain('/trust/sub-processors');
    expect(body).not.toMatch(/Hetzner, Neon, Upstash, Cloudflare, Postmark/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md')),
    ).toBe(true);
  });

  it('threat-model structure: in-scope (5) + explicitly-out (4) buckets pinned', () => {
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">In scope<\/h3>/);
    expect(body).toMatch(/Explicitly out of scope/);
    // In-scope categories.
    expect(body).toMatch(/<strong>API key compromise<\/strong>/);
    expect(body).toMatch(/<strong>Webhook signature forgery<\/strong>/);
    expect(body).toMatch(/<strong>Session hijacking<\/strong>/);
    expect(body).toMatch(/<strong>Brute-force auth attempts<\/strong>/);
    expect(body).toMatch(/<strong>Stolen browser session token<\/strong>/);
    // Explicitly out-of-scope categories.
    expect(body).toMatch(/<strong>Customer's destination response content\.<\/strong>/);
    expect(body).toMatch(/<strong>Detection-vendor cat-and-mouse evolution\.<\/strong>/);
    expect(body).toMatch(/<strong>Customer's keyboard \/ network at the endpoint\.<\/strong>/);
    expect(body).toMatch(/<strong>Nation-state actors with sub-processor access\.<\/strong>/);
  });

  it('audit-log export pinned ↔ /v1/account/audit-log/export (GDPR Article 20)', () => {
    expect(body).toMatch(/<code class="font-mono">\/v1\/account\/audit-log\/export<\/code>/);
    expect(body).toMatch(/your data-portability right under GDPR Article 20\)/); // S20c 2026-07-06
  });

  it('cross-account-lookup-404-never-403 design constraint pinned', () => {
    // Load-bearing security invariant — the page calls this out
    // as the mitigation against cross-account enumeration.
    expect(body).toMatch(/cross-account\s+lookups return 404, never 403/);
  });

  it('mailto:security@driftstack.dev "no NDAs" commitment pinned', () => {
    expect(body).toContain('mailto:security@driftstack.dev');
    expect(body).toMatch(/no NDAs to read a one-paragraph\s+answer/);
  });

  // S26 2026-07-06 (#132) — re-pinned after the accuracy correction.
  // The old pin locked FALSE controls: "Dependabot + Renovate" (no
  // Renovate config exists) and the CycloneDX-SBOM + signed-image +
  // signature-verifying-deploy claim (no cosign/syft anywhere; the
  // deploy is a plain image build + pull). The pin now locks the
  // honest replacements: Dependabot-only (weekly, CI-gated,
  // patch-only auto-merge per .github/dependabot.yml +
  // dependabot-auto-merge.yml) and the real deploy controls
  // (lockfile-pinned installs, staging-first + manual prod approval,
  // post-deploy health-check with automatic rollback, public
  // /version SHA endpoint — deploy.yml / server-deploy.yml
  // V-549.A/B / app.ts V-195).
  // 2026-09-15 plain-language pass: the framework list, the tool name
  // (Dependabot) and the deploy-pipeline vocabulary left the customer
  // page; the same controls are pinned in customer words.
  it('supply-chain section pinned: stable stack / automatic dependency updates (no Renovate) / tested, approved, reversible releases', () => {
    expect(body).toMatch(
      /small, stable set of well-known components\s+\(Node\.js, TypeScript, Postgres, Redis\) that rarely changes/,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-medium text-tk-ink">Automatic dependency updates<\/h3>/,
    );
    expect(body).toMatch(
      /only\s+small bug-fix updates go in automatically, and anything\s+bigger waits for human review/,
    );
    // The false SBOM/signed-image claims must stay gone. (The word
    // "Renovate" may only appear inside the S26 explanatory comment;
    // "cryptographically signed" legitimately remains for webhooks.)
    expect(body).not.toMatch(/Dependabot \+ Renovate/);
    expect(body).not.toMatch(/CycloneDX format/);
    expect(body).not.toMatch(/container image\) is cryptographically signed/);
    expect(body).not.toMatch(/SBOM, in the standard/);
    // The honest deploy controls pinned.
    expect(body).toMatch(/Every software component is fixed to an exact version/);
    expect(body).toMatch(
      /reaches production only after running on a test copy\s+first and being explicitly approved/,
    );
    expect(body).toMatch(/automatically rolled back if\s+that check fails/);
    expect(body).toMatch(
      /anyone can see exactly which version\s+is running at <code class="font-mono">api\.driftstack\.dev\/version<\/code>/,
    );
  });
});
