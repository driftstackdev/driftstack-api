// W501.B — drift guard for apps/marketing-site/src/pages/security.astro.
// /security posture page. Drift here either drops the 6-pillar
// architecture framing (would orphan compliance reviewers from the
// canonical posture overview) or breaks the V-503 defense-in-depth
// + threat model framing (which security teams compare against the
// /trust pages and the DPA).
//
//   • 6-pillar architecture: Transport + Egress (shipped per profile,
//     2026-05-22) + API keys + Webhooks + Team RBAC +
//     No-customer-data-access.
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
//     Dependabot (weekly, CI-gated, patch-only auto-merge) + locked
//     installs + gated deploys with auto-rollback + public /version
//     SHA. (S26 2026-07-06 (#132): retracted the false Renovate +
//     CycloneDX-SBOM + signed-image claims this header used to list.)
//   • Sub-processor list 10-vendor: Hetzner + Neon + Upstash +
//     Cloudflare + Postmark + Sentry + Stripe + Anthropic + Moneybird
//     + MacStadium.
//   • 'No SOC 2 / No ISO 27001' honest-scope framing.
//   • security@driftstack.dev contact.
//
// 2026-07-03 Fleet v2 re-skin: the page is now the plain-terms
// overview (each pillar leads with a plain sentence; the precise
// pinned claim rides as mono small print) on the shared PageHero/
// Section/IconTile/CtaBand recipes, deferring to /trust/security-
// overview for parameter-level depth. Every pinned claim below is
// byte-identical; only the contact-CTA pin (CtaBand props) changed
// shape.

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
    expect(body).toMatch(/05 · Team roles \(RBAC\)/); // S20c 2026-07-06: plain words lead, RBAC kept
    expect(body).toMatch(/06 · No-customer-data-access posture/);
  });

  it("TLS 1.2 + 1.3 + HSTS framing pinned: 'All inbound traffic is HTTPS — Cloudflare terminates TLS at the edge with full (strict) origin validation against our Hetzner host. The API server speaks TLS 1.2 / 1.3 only and sets a 2-year HSTS header with includeSubDomains + preload.' — pinned so the TLS-1.2+1.3-only + Cloudflare-strict-origin-validation + 2-year HSTS with both directives stay explicit (drift to dropping the 2-year HSTS would weaken the preload-eligibility)", () => {
    // S20c 2026-07-06 plain-language pass: same TLS 1.2/1.3-only +
    // strict-origin-validation + 2-year HSTS facts; plain words lead,
    // the precise terms ride in parens.
    expect(body).toMatch(
      /All traffic to us is HTTPS — encrypted the whole way\.\s+Cloudflare, our edge network, handles the encryption first\s+\(terminating TLS at the edge\) and strictly verifies it is\s+really talking to our own server at Hetzner \(full "strict"\s+origin validation\) before passing anything on\. The API\s+server speaks TLS 1\.2 \/ 1\.3 only and sets a 2-year HSTS\s+header with <code>includeSubDomains<\/code> \+ <code>preload<\/code>/,
    );
  });

  it("scrypt-at-rest framing pinned: 'API keys are hashed with scrypt (logN=15) before they touch the database. Plaintext is returned exactly once, on creation; after that there is no path — admin, support, ops — to recover it. A database breach surfaces hashes, not keys. Auth runtime uses a 30-second sha256-keyed cache so verification stays fast without weakening at-rest strength.' — pinned so the scrypt logN=15 + 30s sha256 cache + no-recovery-path framing all survive (drift to different scrypt parameters would create marketing↔implementation divergence)", () => {
    // S20c 2026-07-06 plain-language pass: scrypt logN=15, the
    // no-recovery-path, and the 30s sha256-keyed cache all survive;
    // plain words lead ("scrambled one-way", "remembered for 30
    // seconds").
    expect(body).toMatch(
      /API keys are scrambled one-way with scrypt \(logN=15\) — a\s+deliberately slow scrambling algorithm that makes guessing\s+impractical — before they ever touch the database\./,
    );
    expect(body).toMatch(
      /no path — admin, support, ops — to\s+recover it\. A database breach surfaces scrambled values\s+\(hashes\), not keys\./,
    );
    expect(body).toMatch(
      /To keep requests fast, a just-verified\s+key is remembered for 30 seconds in a protected in-memory\s+cache \(sha256-keyed\) — speed without weakening how keys are\s+stored\./,
    );
  });

  it("HMAC-SHA256 webhook signature format pinned: 't=<timestamp>,v1=<hex>' + verifyWebhookSignature SDK helper + constant-time compare + 5-minute timestamp tolerance — pinned so the canonical signature format + the constant-time verification (anti-timing-attack) + the 5-min replay window all survive (drift to a different signature format would break customer verifiers; drift to dropping constant-time would re-introduce timing-attack risk)", () => {
    expect(body).toMatch(/<code class="font-mono">t=&lt;timestamp&gt;,v1=&lt;hex&gt;<\/code>/);
    // S20c 2026-07-06 plain-language pass: constant-time compare and
    // the 5-minute replay window kept, glossed inline.
    expect(body).toMatch(
      /<code class="font-mono">verifyWebhookSignature<\/code>\s+\(a constant-time compare, built to resist timing tricks\)\.\s+Messages older than the default 5-minute timestamp\s+tolerance are rejected, so an intercepted copy can't be\s+re-sent later \("replay"\)/,
    );
  });

  it("No-customer-data-access posture: 'Driftstack's control plane stores license metadata, session metadata (id, lifecycle status, timestamps), and aggregate usage counters. It does not store the session content itself. URLs visited, form data submitted, screenshots captured, DOM snapshots, browser cookies — these never reach our infra.' + self-hosted-metadata-stays-inside-network — pinned so the explicit 5-state never-stored scope (URLs / form / screenshots / DOM / cookies) + the self-hosted-license-heartbeat-only flow survive (drift to dropping any item would weaken the no-collection commitment)", () => {
    // S20c 2026-07-06 plain-language pass: all 5 never-stored items
    // survive (DOM snapshots glossed as "copies of page content");
    // license-validity heartbeats glossed as periodic check-ins.
    expect(body).toMatch(
      /URLs visited, form data submitted, screenshots captured,\s+copies of page content \(DOM snapshots\), browser cookies —\s+none of it ever reaches our servers\./,
    );
    expect(body).toMatch(
      /For\s+self-hosted deployments, even the metadata stays inside your\s+network; only license-validity heartbeats — periodic "is\s+this license still valid\?" check-ins — reach our servers\./,
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
    expect(body).toMatch(/A locked-down server \(nginx \+ UFW \+ fail2ban\)/); // S20c 2026-07-06
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
    // S20c 2026-07-06 plain-language pass: the 404-not-403
    // anti-enumeration promise survives, stated plainly.
    expect(body).toMatch(
      /every route restricts\s+lookups to your own account at the database layer; a\s+probe at another account's data gets a plain "not\s+found" \(cross-account lookups return 404, never 403 —\s+the response never even confirms the thing exists\)\./,
    );
  });

  // S26 2026-07-06 (#132) — re-pinned after the accuracy correction.
  // The previous revision of this pin locked FALSE supply-chain
  // controls: a Renovate config that does not exist (only
  // .github/dependabot.yml does) and a CycloneDX-SBOM + signed-image
  // + signature-verifying-deploy story with no implementation behind
  // it (no cosign/syft anywhere in the repo; server-deploy.yml is a
  // plain image build + `docker compose pull`). Locking the string
  // gave the false claim a "verified" feel — the pin now locks the
  // controls that actually exist: lockfile-pinned installs
  // (package-lock.json + `npm ci` in ci.yml), staging-first + manual
  // prod approval (deploy.yml), V-549.A pre-deploy smoke + V-549.B
  // post-deploy health-check with automatic rollback
  // (server-deploy.yml), and the public /version git-SHA endpoint
  // (apps/server/src/lib/app.ts V-195).
  it("V-503 supply-chain framing pinned: 'Node 22 LTS, TypeScript strict, Fastify, Drizzle, Postgres 17, Redis 7.' + Dependabot-only card (weekly, CI-gated, patch-only auto-merge) + honest deploy controls (lockfile installs, staging-first gated pipeline, auto-rollback health-check, public /version SHA) — pinned so the corrected S26 wording survives and the retracted SBOM/signed-image claims cannot silently return", () => {
    expect(body).toMatch(
      /Node 22 LTS, TypeScript strict, Fastify, Drizzle, Postgres 17,\s*\n?\s*Redis 7\./,
    );
    expect(body).toMatch(/<h3 class="text-base font-medium text-tk-ink">Dependabot<\/h3>/);
    expect(body).toMatch(
      /Nothing merges unless the full automated test suite\s+passes \(CI\); only the smallest class of update \(bug-fix-only\s+patch releases\) may merge automatically/,
    );
    expect(body).toMatch(
      /Every dependency version is pinned in a lockfile checked\s+into the repository, and CI installs exactly those pinned\s+versions\./,
    );
    expect(body).toMatch(
      /staging first, then an explicit manual approval or\s+a deliberately cut release tag\./,
    );
    expect(body).toMatch(/automatically rolls\s+back to the previous version if that check fails/);
    expect(body).toMatch(
      /verify exactly which\s+source-code revision\s+production is running via our public\s+\/version endpoint/,
    );
    // Retracted false claims must stay gone (allowing only the S26
    // explanatory comment, which avoids these exact phrasings).
    expect(body).not.toMatch(/Dependabot \+ Renovate/);
    expect(body).not.toMatch(/CycloneDX format/);
    expect(body).not.toMatch(/SBOM, in the standard/);
    expect(body).not.toMatch(/container image\) is cryptographically signed/);
  });

  it("security@driftstack.dev contact framing pinned: 'Email security@driftstack.dev with the question. We answer everything in writing — no NDAs to read a one-paragraph answer about scrypt parameters or TLS cipher suites.' — pinned so the no-NDA-for-security-questions commitment survives (drift to dropping would create friction for security-team buyers; drift to a different email would orphan canonical contact)", () => {
    expect(body).toMatch(
      /Email security@driftstack\.dev with the question\. We answer\s*\n?\s*everything in writing — no NDAs to read a one-paragraph\s*\n?\s*answer about scrypt parameters or TLS cipher suites\./,
    );
    // 2026-07-03 Fleet v2 — the contact CTA is the shared CtaBand
    // component; mailto destination + button label pinned via props.
    expect(body).toMatch(
      /primaryHref="mailto:security@driftstack\.dev\?subject=Security%20question"/,
    );
    expect(body).toMatch(/primaryLabel="Email security"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
