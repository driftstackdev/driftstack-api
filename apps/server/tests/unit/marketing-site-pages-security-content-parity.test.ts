// W501.B — drift guard for apps/marketing-site/src/pages/security.astro.
// /security posture page. Drift here either drops the 6-pillar
// architecture framing (would orphan compliance reviewers from the
// canonical posture overview) or breaks the V-503 defense-in-depth
// + threat model framing (which security teams compare against the
// /trust pages and the DPA).
//
//   • 6-pillar architecture: Transport + Egress (shipped per profile,
//     2026-05-22) + API keys + Webhooks + Team RBAC +
//     Live-media handling.
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

  it('Hero truthfully distinguishes one-way API-key hashes, platform-held encrypted envelopes, and the no-retention-by-default session boundary', () => {
    expect(body).toMatch(/Keys protected at rest\. Live media not retained by default\./);
    expect(body).toMatch(
      /stores customer API keys as one-way hashes and wraps\s+recoverable credentials with context-bound encryption under\s+platform-held keys/,
    );
    expect(body).toMatch(
      /owning account is part of the protected\s+context; record and value-slot identity are also bound where the\s+store has a stable record identity/,
    );
    expect(body).toMatch(
      /Live-session media is processed only to\s+run and stream the session and is not retained by default/,
    );
    expect(body).toMatch(
      /Session\s+metadata and agent transcripts follow their documented retention\s+periods/,
    );
    expect(body).not.toMatch(/We don't see your traffic\. We can't read your keys\./);
    expect(body).not.toMatch(/never have a copy of anything/);
  });

  it('6-pillar architecture pins Transport, SOCKS5 egress, API keys, Webhooks, Team RBAC and honest live-media handling', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Egress/);
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team roles \(RBAC\)/); // S20c 2026-07-06: plain words lead, RBAC kept
    expect(body).toMatch(/06 · Live-media handling/);
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

  it('Live-media handling states the implemented processing, access, and retention boundaries without claiming broad content non-retention', () => {
    expect(body).toMatch(/Live-session media is not retained by default\./);
    expect(body).toMatch(
      /Live-session media is encrypted in transport,\s+processed through LiveKit to deliver the stream, and dropped\s+when the session ends\./,
    );
    expect(body).toMatch(
      /product exposes no administrative\s+path for Driftstack staff to join a customer's live session\./,
    );
    expect(body).toMatch(
      /screenshots, DOM snapshots, and PDFs pass through\s+the API inline and are not retained by the Capture endpoint;\s+desktop recordings stay on the customer's device and are not\s+uploaded\./,
    );
    expect(body).toMatch(
      /For self-hosted deployments, even session metadata\s+stays inside your network; only license-validity heartbeats/,
    );
    expect(body).not.toMatch(/Nobody at Driftstack can watch your sessions/);
    expect(body).not.toMatch(/Driftstack staff cannot read your sessions/);
    expect(body).not.toMatch(/none of it ever reaches our servers/);
    expect(body).not.toMatch(/support can join/i);
  });

  it("Honest-scope 4-card pinned: 'No SOC 2' + 'No ISO 27001' + published sub-processors + EU-default residency", () => {
    expect(body).toMatch(/<strong class="block text-tk-ink">No SOC 2\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-tk-ink">No ISO 27001\.<\/strong>/);
    expect(body).toMatch(
      /<strong class="block text-tk-ink">Sub-processors are published\.<\/strong>/,
    );
    expect(body).toMatch(
      /<strong class="block text-tk-ink">Data residency is EU-default\.<\/strong>/,
    );
  });

  it('links the canonical live sub-processor register instead of duplicating a stale partial vendor list', () => {
    expect(body).toMatch(
      /live register lists every provider with its purpose, region,\s+and transfer mechanism/,
    );
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).not.toMatch(/Hetzner, Neon, Upstash, Cloudflare, Postmark/);
  });

  it('V-503 defense-in-depth keeps six honest layers, including recorded audit events without universal-delivery claims', () => {
    expect(body).toMatch(/Cloudflare TLS 1\.3 \+ WAF/);
    expect(body).toMatch(/A locked-down server \(nginx \+ UFW \+ fail2ban\)/); // S20c 2026-07-06
    expect(body).toMatch(/Auth gate \+ scope check \+ rate limit/);
    expect(body).toMatch(/Encryption at rest \+ isolation/);
    expect(body).toMatch(/Recorded customer audit trail/);
    expect(body).toMatch(
      /Successfully recorded account-security and management events\s+are append-only at the record level/,
    );
    expect(body).toMatch(/Routine credential use is not emitted as\s+a read event/);
    expect(body).not.toMatch(/Every customer-visible event lands/);
    expect(body).not.toMatch(/never edited, never deleted/);
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
      /Node 22 LTS, TypeScript strict, Fastify, Drizzle, Postgres 17,\s*Redis 7\./,
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
      /Email security@driftstack\.dev with the question\. We answer\s*everything in writing — no NDAs to read a one-paragraph\s*answer about scrypt parameters or TLS cipher suites\./,
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
