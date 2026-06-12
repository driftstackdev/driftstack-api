// W501.B — drift guard for apps/marketing-site/src/pages/security.astro.
// /security posture page. Drift here either drops the 6-pillar
// architecture framing (would orphan compliance reviewers from the
// canonical posture overview) or breaks the V-503 defense-in-depth
// + threat model framing (which security teams compare against the
// /trust pages and the DPA).
//
//   • 6-pillar architecture: Transport + Egress (roadmap) + API keys +
//     Webhooks + Team RBAC + No-customer-data-access.
//   • TLS 1.2 + 1.3 + 2-year HSTS preload-eligible (includeSubDomains
//     + preload).
//   • API keys: scrypt logN=15 + 30-second sha256-keyed cache + no
//     plaintext-recovery path.
//   • HMAC-SHA256 webhook signatures: t=<timestamp>,v1=<hex> +
//     verifyWebhookSignature SDK helper + constant-time compare +
//     5-minute timestamp tolerance.
//   • V-503 defense-in-depth 6-layer: Edge (Cloudflare WAF) + Origin
//     (nginx/UFW/fail2ban) + Application (auth + scope + rate-limit) +
//     Data (encryption at rest) + Audit (append-only) + Observability
//     (Sentry EU + Pino structured).
//   • V-503 threat model: 5 in-scope + 4 out-of-scope.
//   • V-503 supply chain: Node 22 LTS + Postgres 17 + Redis 7 +
//     Dependabot + Renovate + CycloneDX SBOM + signed images.
//   • Sub-processor list 10-vendor: Hetzner + Neon + Upstash +
//     Cloudflare + Postmark + Sentry + Stripe + Anthropic + Moneybird
//     + MacStadium.
//   • 'No SOC 2 / No ISO 27001' honest-scope framing.
//   • security@driftstack.dev contact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W501.B apps/marketing-site/src/pages/security.astro content parity', () => {
  const body = read(LIB);

  it("Hero framing: 'We don't see your traffic. We can't read your keys.' + 'Driftstack should never have a copy of anything that would let us impersonate you, intercept your traffic, or replay your sessions. The architecture below enforces that — not as policy, as code.' — pinned so the no-access-by-design hero + the 'not as policy, as code' framing both survive (drift to softer language would weaken the security-by-architecture commitment)", () => {
    expect(body).toMatch(/We don't see your traffic\. We can't read your keys\./);
    expect(body).toMatch(
      /Driftstack should never have a copy of anything that would let us\s*\n?\s*impersonate you, intercept your traffic, or replay your sessions\./,
    );
    expect(body).toMatch(/The architecture below enforces that — not as policy, as code\./);
  });

  it('6-pillar architecture: 01 Transport + 02 Egress (shipped per profile) + 03 API keys + 04 Webhooks + 05 Team RBAC + 06 No-customer-data-access posture — pinned so the 6-pillar security overview taxonomy stays consistent. 2026-05-22 — Pillar 02 label flipped from "(roadmap)" to plain "Egress" + body rewritten to reflect shipped SOCKS5/OpenVPN/WireGuard per-profile capability.', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Egress/);
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team RBAC/);
    expect(body).toMatch(/06 · No-customer-data-access posture/);
  });

  it("TLS 1.2 + 1.3 + HSTS framing pinned: 'All inbound traffic is HTTPS — Cloudflare terminates TLS at the edge with full (strict) origin validation against our Hetzner host. The API server speaks TLS 1.2 / 1.3 only and sets a 2-year HSTS header with includeSubDomains + preload.' — pinned so the TLS-1.2+1.3-only + Cloudflare-strict-origin-validation + 2-year HSTS with both directives stay explicit (drift to dropping the 2-year HSTS would weaken the preload-eligibility)", () => {
    expect(body).toMatch(
      /All inbound traffic is HTTPS — Cloudflare terminates TLS\s*\n?\s*at the edge with full \(strict\) origin validation against\s*\n?\s*our Hetzner host\. The API server speaks TLS 1\.2 \/ 1\.3\s*\n?\s*only and sets a 2-year HSTS header with\s*\n?\s*<code>includeSubDomains<\/code> \+ <code>preload<\/code>\./,
    );
  });

  it("scrypt-at-rest framing pinned: 'API keys are hashed with scrypt (logN=15) before they touch the database. Plaintext is returned exactly once, on creation; after that there is no path — admin, support, ops — to recover it. A database breach surfaces hashes, not keys. Auth runtime uses a 30-second sha256-keyed cache so verification stays fast without weakening at-rest strength.' — pinned so the scrypt logN=15 + 30s sha256 cache + no-recovery-path framing all survive (drift to different scrypt parameters would create marketing↔implementation divergence)", () => {
    expect(body).toMatch(
      /API keys are hashed with scrypt \(logN=15\) before they touch\s*\n?\s*the database\./,
    );
    expect(body).toMatch(
      /no path — admin, support, ops — to recover\s*\n?\s*it\. A database breach surfaces hashes, not keys\./,
    );
    expect(body).toMatch(
      /Auth runtime\s*\n?\s*uses a 30-second sha256-keyed cache so verification stays\s*\n?\s*fast without weakening at-rest strength\./,
    );
  });

  it("HMAC-SHA256 webhook signature format pinned: 't=<timestamp>,v1=<hex>' + verifyWebhookSignature SDK helper + constant-time compare + 5-minute timestamp tolerance — pinned so the canonical signature format + the constant-time verification (anti-timing-attack) + the 5-min replay window all survive (drift to a different signature format would break customer verifiers; drift to dropping constant-time would re-introduce timing-attack risk)", () => {
    expect(body).toMatch(/<code class="font-mono">t=&lt;timestamp&gt;,v1=&lt;hex&gt;<\/code>/);
    expect(body).toMatch(
      /<code class="font-mono">verifyWebhookSignature<\/code> helper\s*\n?\s*\(constant-time compare\)\. The default 5-minute timestamp\s*\n?\s*tolerance protects against replay/,
    );
  });

  it("No-customer-data-access posture: 'Driftstack's control plane stores license metadata, session metadata (id, lifecycle status, timestamps), and aggregate usage counters. It does not store the session content itself. URLs visited, form data submitted, screenshots captured, DOM snapshots, browser cookies — these never reach our infra.' + self-hosted-metadata-stays-inside-network — pinned so the explicit 5-state never-stored scope (URLs / form / screenshots / DOM / cookies) + the self-hosted-license-heartbeat-only flow survive (drift to dropping any item would weaken the no-collection commitment)", () => {
    expect(body).toMatch(
      /URLs visited, form data submitted, screenshots captured, DOM\s*\n?\s*snapshots, browser cookies — these never reach our infra\./,
    );
    expect(body).toMatch(
      /For\s*\n?\s*self-hosted deployments, even the metadata stays inside your\s*\n?\s*network; only license-validity heartbeats reach our servers\./,
    );
  });

  it("Honest-scope 4-card pinned: 'No SOC 2' + 'No ISO 27001' + 'Sub-processors are listed' + 'Data residency is EU-default' — pinned so the no-SOC2 + no-ISO27001 honest framing + sub-processor + EU-default 4-card combo survives (drift to claiming SOC 2 would break the integrity narrative; drift to vague 'enterprise-grade' language would weaken the comparison-against-competitor positioning)", () => {
    expect(body).toMatch(/<strong class="block text-tk-ink">No SOC 2\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-tk-ink">No ISO 27001\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-tk-ink">Sub-processors are listed\.<\/strong>/);
    expect(body).toMatch(
      /<strong class="block text-tk-ink">Data residency is EU-default\.<\/strong>/,
    );
  });

  it("Sub-processor 10-vendor list pinned: Hetzner + Neon + Upstash + Cloudflare + Postmark + Sentry + Stripe + Anthropic + Moneybird + MacStadium — pinned so the canonical 10-vendor sub-processor list stays consistent with /trust/sub-processors (drift to dropping any would create cross-page divergence the DPA Annex 3 won't match)", () => {
    expect(body).toMatch(
      /Hetzner, Neon, Upstash, Cloudflare, Postmark, Sentry, Stripe,\s*\n?\s*Anthropic, Moneybird, MacStadium\./,
    );
  });

  it('V-503 defense-in-depth 6-layer pinned: Edge (Cloudflare TLS 1.3 + WAF) + Origin (nginx hardening + UFW + fail2ban) + Application (Auth gate + scope check + rate limit) + Data (Encryption at rest + isolation) + Audit (Append-only customer audit log) + Observability (Sentry + structured logs) — pinned so the 6-layer defense-in-depth narrative stays consistent (drift to dropping any layer would create a single-line-of-defense gap; drift to renaming would break the at-a-glance security-review story)', () => {
    expect(body).toMatch(/Cloudflare TLS 1\.3 \+ WAF/);
    expect(body).toMatch(/nginx hardening \+ UFW \+ fail2ban/);
    expect(body).toMatch(/Auth gate \+ scope check \+ rate limit/);
    expect(body).toMatch(/Encryption at rest \+ isolation/);
    expect(body).toMatch(/Append-only customer audit log/);
    expect(body).toMatch(/Sentry \+ structured logs/);
  });

  it("V-503 threat-model in-scope 5-state + out-of-scope 4-state pinned — pinned so the explicit threat-model boundary stays consistent (drift to claiming nation-state defense would create false-promise risk; drift to dropping the 'session hijacking' in-scope would weaken the cross-account isolation story that returns 404 not 403)", () => {
    expect(body).toMatch(/<strong>API key compromise<\/strong>/);
    expect(body).toMatch(/<strong>Webhook signature forgery<\/strong>/);
    expect(body).toMatch(/<strong>Session hijacking<\/strong>/);
    expect(body).toMatch(/<strong>Brute-force auth attempts<\/strong>/);
    expect(body).toMatch(/<strong>Stolen browser session token<\/strong>/);
    expect(body).toMatch(/<strong>Customer's destination response content\.<\/strong>/);
    expect(body).toMatch(/<strong>Detection-vendor cat-and-mouse evolution\.<\/strong>/);
    expect(body).toMatch(/<strong>Nation-state actors with sub-processor access\.<\/strong>/);
  });

  it("Cross-account 404-not-403 framing pinned: 'every route account-scopes resources at the database layer; cross-account lookups return 404, never 403.' — pinned so the explicit anti-enumeration framing (cross-account returns 404 to hide existence, not 403 to confirm) survives (drift to 403 would re-introduce the enumeration-via-status-code information disclosure)", () => {
    expect(body).toMatch(
      /every route account-\s*\n?\s*scopes resources at the database layer; cross-account\s*\n?\s*lookups return 404, never 403\./,
    );
  });

  it("V-503 supply-chain framing pinned: 'Node 22 LTS, TypeScript strict, Fastify, Drizzle, Postgres 17, Redis 7.' + 'Dependabot + Renovate' + 'Each release builds a CycloneDX SBOM alongside the artifact. Container images are signed; the deploy pipeline verifies the signature before pulling into production.' — pinned so the locked-stack versions + the SBOM + signed-image + signature-verify pipeline stay explicit (drift to dropping any would weaken the supply-chain narrative compliance reviewers compare against the SLSA + sigstore patterns)", () => {
    expect(body).toMatch(
      /Node 22 LTS, TypeScript strict, Fastify, Drizzle, Postgres 17,\s*\n?\s*Redis 7\./,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-medium text-tk-ink">Dependabot \+ Renovate<\/h3>/,
    );
    expect(body).toMatch(
      /Each release builds a CycloneDX SBOM alongside the artifact\.\s*\n?\s*Container images are signed; the deploy pipeline verifies the\s*\n?\s*signature before pulling into production\./,
    );
  });

  it("security@driftstack.dev contact framing pinned: 'Email security@driftstack.dev with the question. We answer everything in writing — no NDAs to read a one-paragraph answer about scrypt parameters or TLS cipher suites.' — pinned so the no-NDA-for-security-questions commitment survives (drift to dropping would create friction for security-team buyers; drift to a different email would orphan canonical contact)", () => {
    expect(body).toMatch(
      /Email security@driftstack\.dev with the question\. We answer\s*\n?\s*everything in writing — no NDAs to read a one-paragraph\s*\n?\s*answer about scrypt parameters or TLS cipher suites\./,
    );
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev\?subject=Security%20question" class="btn-primary"\s*\n?\s*>Email security<\/a/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
