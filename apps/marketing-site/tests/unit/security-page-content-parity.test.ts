// W365.A — drift guard for marketing-site /security page (the
// public-facing security landing). V-503. The docs/security-
// overview parity test pins the deeper /docs surface; this
// guard pins the marketing-tier claims a prospective customer's
// security team reads before signing.
//
// Pinned:
//   • 6 numbered pillar slots present (transport / egress /
//     api-keys / webhooks / team-rbac / no-customer-data-access).
//   • Egress is framed as ROADMAP (no server-side
//     implementation today) — load-bearing honesty claim.
//   • Scrypt logN=15 + 30s sha256-keyed auth cache claims pinned
//     (specific, falsifiable security parameters).
//   • Webhook signature shape t=<timestamp>,v1=<hex> + 5-minute
//     replay window pinned ↔ V-359 contract.
//   • "What we don't claim" honesty block: no SOC 2 + no ISO
//     27001 + EU-default residency pinned.
//   • Sub-processor list cited (Hetzner, Neon, Upstash,
//     Cloudflare, Postmark, Sentry, Stripe, Anthropic, Moneybird,
//     MacStadium) + cross-link to /trust/sub-processors.
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

  it('6 numbered pillar slots present (transport / egress / api-keys / webhooks / rbac / no-data-access). 2026-05-22 — egress label flipped from "(roadmap)" to plain "Egress" after the per-profile capability shipped.', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Egress/);
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team roles \(RBAC\)/); // S20c 2026-07-06: plain words lead, RBAC kept in parens
    expect(body).toMatch(/06 · No-customer-data-access posture/);
  });

  it('egress framed as SHIPPED per-profile (SOCKS5 / OpenVPN / WireGuard). 2026-05-22 — flipped from honest-roadmap framing to concrete capability claim per planning 133 Phase 1 + SocksProxyBackend wired in bootstrap.', () => {
    expect(body).toMatch(/Each profile can attach its own egress configuration/);
    expect(body).toMatch(/SOCKS5/);
    expect(body).toMatch(/OpenVPN/);
    expect(body).toMatch(/WireGuard/);
  });

  it('scrypt logN=15 + 30s sha256-keyed auth cache parameters pinned (falsifiable claims)', () => {
    expect(body).toMatch(/scrypt \(logN=15\)/);
    // S20c 2026-07-06 plain-language pass: same 30s sha256-keyed cache
    // fact, said plainly.
    expect(body).toMatch(
      /remembered for 30 seconds in a protected in-memory\s+cache \(sha256-keyed\)/,
    );
    // The "Plaintext is returned exactly once" claim is the same
    // promise customer-dashboard /api-keys makes — load-bearing.
    expect(body).toMatch(/The\s+readable key is shown exactly once, when you create it/);
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
    expect(body).toMatch(
      /Compute and database in the EU \(Hetzner in\s+Falkenstein, Germany \+ Neon EU \+ Upstash EU\)\./,
    );
    expect(body).toMatch(
      /Uploaded files\s+\(avatars, for example\) sit on Cloudflare R2, which can\s+replicate outside the EU\./,
    );
    // S30 negative pin — the blanket claim must not silently return.
    expect(body).not.toMatch(/Compute, database, object storage all in the EU/);
  });

  it('sub-processor list cited + cross-link to /trust/sub-processors resolves', () => {
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
    ]) {
      expect(body).toContain(sp);
    }
    expect(body).toContain('/trust/sub-processors');
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
  it('supply-chain section pinned: Node 22 LTS / Dependabot (no Renovate) / locked installs + gated deploys', () => {
    expect(body).toMatch(/Node 22 LTS/);
    expect(body).toMatch(/<h3 class="text-base font-medium text-tk-ink">Dependabot<\/h3>/);
    expect(body).toMatch(
      /only\s+the smallest class of update \(bug-fix-only\s+patch releases\) may merge automatically/,
    );
    // The false SBOM/signed-image claims must stay gone. (The word
    // "Renovate" may only appear inside the S26 explanatory comment;
    // "cryptographically signed" legitimately remains for webhooks.)
    expect(body).not.toMatch(/Dependabot \+ Renovate/);
    expect(body).not.toMatch(/CycloneDX format/);
    expect(body).not.toMatch(/container image\) is cryptographically signed/);
    expect(body).not.toMatch(/SBOM, in the standard/);
    // The honest deploy controls pinned.
    expect(body).toMatch(/pinned in a lockfile checked\s+into the repository/);
    expect(body).toMatch(
      /staging first, then an explicit manual approval or\s+a deliberately cut release tag/,
    );
    expect(body).toMatch(/automatically rolls\s+back to the previous version if that check fails/);
    expect(body).toMatch(
      /which source-code revision\s+production is running via our public\s+\/version endpoint/,
    );
  });
});
