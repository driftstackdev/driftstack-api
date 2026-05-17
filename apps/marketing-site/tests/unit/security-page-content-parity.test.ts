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

  it('6 numbered pillar slots present (transport / egress / api-keys / webhooks / rbac / no-data-access)', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Egress \(roadmap\)/);
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team RBAC/);
    expect(body).toMatch(/06 · No-customer-data-access posture/);
  });

  it('egress framed as ROADMAP — no server-side implementation today (honesty claim); priority order SOCKS5 / OpenVPN / WireGuard per founder verdict 2026-05-16', () => {
    expect(body).toMatch(
      /Customer-configurable egress \(SOCKS5 \/ OpenVPN \/\s+WireGuard\) is on the roadmap — no server-side\s+implementation ships today/,
    );
  });

  it('scrypt logN=15 + 30s sha256-keyed auth cache parameters pinned (falsifiable claims)', () => {
    expect(body).toMatch(/scrypt \(logN=15\)/);
    expect(body).toMatch(/30-second sha256-keyed cache/);
    // The "Plaintext is returned exactly once" claim is the same
    // promise customer-dashboard /api-keys makes — load-bearing.
    expect(body).toMatch(/Plaintext is returned exactly once, on creation/);
  });

  it('webhook signature shape t=<timestamp>,v1=<hex> + 5-min replay window pinned (V-359)', () => {
    expect(body).toMatch(
      /Driftstack-Signature header[\s\S]{0,80}t=&lt;timestamp&gt;,v1=&lt;hex&gt;/,
    );
    expect(body).toMatch(/default 5-minute timestamp\s+tolerance protects against replay/);
    expect(body).toMatch(/verifyWebhookSignature/);
  });

  it('"What we don\'t claim" honesty block pinned (no SOC 2 / no ISO 27001 / EU-default)', () => {
    expect(body).toMatch(/<strong class="block text-ink-primary">No SOC 2\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-ink-primary">No ISO 27001\.<\/strong>/);
    expect(body).toMatch(
      /<strong class="block text-ink-primary">Data residency is EU-default\.<\/strong>/,
    );
    // EU-only stack disclosed.
    expect(body).toMatch(/Hetzner FSN\s*\+ Neon EU \+ Upstash EU \+ Cloudflare R2 EU/);
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
    expect(body).toMatch(/<h3 class="text-lg font-medium text-ink-primary">In scope<\/h3>/);
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
    expect(body).toMatch(/\(GDPR Article 20\)/);
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

  it('supply-chain section pinned: Node 22 LTS / Dependabot+Renovate / CycloneDX SBOM', () => {
    expect(body).toMatch(/Node 22 LTS/);
    expect(body).toMatch(/Dependabot \+ Renovate/);
    expect(body).toMatch(/CycloneDX SBOM/);
    // Signed container images pinned (deploy-pipeline-signs claim).
    expect(body).toMatch(/Container images are signed/);
  });
});
