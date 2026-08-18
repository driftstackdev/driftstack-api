// W548.C — drift guard for /docs/network-architecture.md.
// Network-architecture contract — founder-review-required before
// fleet integration begins. Drift here either weakens the v1
// 'signed JWT over mTLS' control-plane↔fleet posture (would risk
// shipping the fleet integration without the foundational auth
// model), drops the Cloudflare-Tunnel-no-inbound-port stance
// (would re-permit public ports on the Hetzner VM), or changes
// the 3-surface inventory (would mislead about the network shape).
//
//   • Founder review required before fleet integration begins.
//   • v0.1.0-draft Workstream A foundational, effective 2026-05-03.
//   • 3 network surfaces: customer↔control-plane + customer↔
//     marketing + control-plane↔Mac-Mini-fleet (load-bearing).
//   • §1 control plane: TLS at Cloudflare edge + Tunnel + Hetzner
//     VM serves :7780 loopback-only.
//   • Cloudflare WAF: per-IP rate-limit on unauth + bad-ASN block
//     on auth surface only.
//   • §2 marketing: driftstack.dev + docs.driftstack.dev edge-
//     cacheable; app.driftstack.dev tunneled for dynamic.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/network-architecture.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W548.C /docs/network-architecture.md content parity', () => {
  const body = read(LIB);

  it("Header + founder-review-required + v0.1.0-draft framing pinned: '# Driftstack — network architecture' + '**Founder review required before fleet integration begins.** The control-plane → Mac-Mini-fleet auth path described in §4 is the primary load-bearing decision; v1 is \"public internet + signed JWT over mTLS\" with WireGuard mesh as a v2 improvement.' + 'Nothing has been wired in code yet — this doc is the contract that fleet code (Agent 1's territory) and c(V-809 retired the nothing-is-wired banner: nginx edge config, fleet auth, status site and dashboard deploy all exist)' + '**Effective:** 2026-05-03 · **Version:** 0.1.0-draft (Workstream A foundational)' — pinned so the founder-review-required-before-fleet-integration + §4-primary-load-bearing-decision + v1-signed-JWT-over-mTLS + v2-WireGuard-mesh + Agent-1-fleet-territory + v0.1.0-draft-Workstream-A-foundational commitment survives", () => {
    expect(body).toMatch(/^# Driftstack — network architecture$/m);
    expect(body).toMatch(/> \*\*Founder review required before fleet integration begins\.\*\*/);
    expect(body).toMatch(/> control-plane → Mac-Mini-fleet auth path described in §4 is the/);
    expect(body).toMatch(/> primary load-bearing decision; v1 is "public internet \+ signed JWT/);
    expect(body).toMatch(/> over mTLS" with WireGuard mesh as a v2 improvement\./);
    // V-809 — the forward-contract banner is retired. infra/nginx/ carries the
    // Hetzner edge config, fleet-node-auth.ts implements fleet authentication,
    // apps/status-site/ exists, and the dashboard has a deploy workflow. The doc
    // describes live surfaces now.
    expect(body).toMatch(/\*\*V-809 — this is no longer a forward contract\.\*\*/);
    expect(body).toMatch(/`infra\/nginx\/` carries the Hetzner edge config/);
    expect(body).toMatch(/treat any remaining unbuilt item as scoped rather than the/);
    expect(body, 'the nothing-is-wired banner must not return').not.toMatch(
      /been wired in code yet/,
    );
    expect(body).toMatch(
      /\*\*Effective:\*\* 2026-05-03 · \*\*Version:\*\* 0\.1\.0-draft \(Workstream A foundational\)/,
    );
  });

  it("Overview 3-surface inventory framing pinned: '## Overview' + 'Driftstack at launch is a single-region deployment with three network surfaces:' + '1. **Customer ↔ control plane** — public HTTPS API on `api.driftstack.dev`. TLS terminated at Cloudflare, plain HTTP to the Hetzner VM over a Cloudflare Tunnel.' + '2. **Customer ↔ marketing site** — public HTTPS on `driftstack.dev`, `docs.driftstack.dev`, and (future) `app.driftstack.dev`. Static on Cloudflare Pages; signup flow lives and app.driftstack.dev is its own Cloudflare Pages project, not a reverse proxy (V-809).' + '3. **Control plane ↔ Mac Mini fleet** — the load-bearing internal surface. v1 plan: signed JWT over mTLS, fleet pulls work from the control plane; v2: WireGuard mesh.' + 'This doc focuses on (3) because (1) and (2) are standard public-internet patterns. (3) involves cross-provider trust between the Hetzner VM and the MacStadium-hosted fleet.' — pinned so the 3-surface-inventory + single-region-launch + (3)-load-bearing-cross-provider-trust + v1-signed-JWT-mTLS-fleet-pulls + v2-WireGuard-mesh commitment survives", () => {
    expect(body).toMatch(/## Overview/);
    expect(body).toMatch(/Driftstack at launch is a single-region deployment with three/);
    expect(body).toMatch(/network surfaces:/);
    expect(body).toMatch(/1\. \*\*Customer ↔ control plane\*\* — public HTTPS API on/);
    expect(body).toMatch(/`api\.driftstack\.dev`\. TLS terminated at Cloudflare, plain HTTP to/);
    expect(body).toMatch(/the Hetzner VM over a Cloudflare Tunnel\./);
    expect(body).toMatch(
      /2\. \*\*Customer ↔ marketing site\*\* — public HTTPS on `driftstack\.dev`,/,
    );
    expect(body).toMatch(
      /`docs\.driftstack\.dev`, and `app\.driftstack\.dev`, all static on\s*\n?\s*Cloudflare Pages\./,
    );
    expect(body, 'the (future) qualifier is retired — the dashboard is deployed').not.toMatch(
      /\(future\) `app\.driftstack\.dev`/,
    );
    // V-809 — the dashboard is a static Pages SPA calling the API cross-origin;
    // the signup flow is not served by a control-plane reverse proxy.
    expect(body).toMatch(
      /The dashboard is a\s*\n?\s*static SPA that calls the control-plane API cross-origin/,
    );
    expect(body).not.toMatch(/signup flow lives on the control plane/);
    // V-809 — app.driftstack.dev is its own Cloudflare Pages project, deployed by
    // deploy-customer-dashboard.yml. It is neither "(future)" nor reverse-proxied.
    expect(body).toMatch(/`app\.driftstack\.dev` is its own Cloudflare\s*\n?\s*Pages project/);
    expect(body).toMatch(
      /it is neither a future\s*\n?\s*surface nor served through the Hetzner VM at all\./,
    );
    expect(body, 'the reverse-proxy claim must not return').not.toMatch(
      /reverse-proxied to the Hetzner VM\./,
    );
    expect(body).toMatch(/3\. \*\*Control plane ↔ Mac Mini fleet\*\* — the load-bearing internal/);
    expect(body).toMatch(/surface\. v1 plan: signed JWT over mTLS, fleet pulls work from the/);
    expect(body).toMatch(/control plane; v2: WireGuard mesh\./);
    expect(body).toMatch(/This doc focuses on \(3\) because \(1\) and \(2\) are standard/);
    expect(body).toMatch(/public-internet patterns\. \(3\) involves cross-provider trust between/);
    expect(body).toMatch(/the Hetzner VM and the MacStadium-hosted fleet\./);
  });

  it("§1 customer↔control-plane Cloudflare-Tunnel-:7780-loopback framing pinned: '## §1. Customer ↔ control plane' + 'Customer SDKs hit `https://api.driftstack.dev` (DNS in Cloudflare, Cloudflare proxy on).' + 'Cloudflare Tunnel from the Hetzner VM connects outbound to Cloudflare; no inbound port is open on the VM beyond SSH for ops.' + 'TLS terminated at Cloudflare's edge. Hetzner VM serves plain HTTP on `127.0.0.1:7780` (compose file binds localhost-only).' + 'Cloudflare WAF rules: rate-limit per-IP for unauthenticated requests, block known-bad ASNs from the auth surface only.' + 'Customer base is EU + UK + US + Switzerland; Cloudflare's EU region is selected for the account, so processing happens in EU PoPs.' — pinned so the api.driftstack.dev + Cloudflare-Tunnel-outbound-only + no-inbound-port-beyond-SSH + 127.0.0.1:7780-loopback + WAF-per-IP-rate-limit-unauth-only + bad-ASN-auth-surface-only + EU+UK+US+CH-customer-base + EU-PoPs commitment survives", () => {
    expect(body).toMatch(/## §1\. Customer ↔ control plane/);
    expect(body).toMatch(
      /- Customer SDKs hit `https:\/\/api\.driftstack\.dev` \(DNS in Cloudflare,/,
    );
    expect(body).toMatch(/Cloudflare proxy on\)\./);
    expect(body).toMatch(/- Cloudflare Tunnel from the Hetzner VM connects outbound to/);
    expect(body).toMatch(/Cloudflare; no inbound port is open on the VM beyond SSH for/);
    expect(body).toMatch(/ops\./);
    expect(body).toMatch(/- TLS terminated at Cloudflare's edge\. Hetzner VM serves plain HTTP/);
    expect(body).toMatch(/on `127\.0\.0\.1:7780` \(compose file binds localhost-only\)\./);
    expect(body).toMatch(/- Cloudflare WAF rules: rate-limit per-IP for unauthenticated/);
    expect(body).toMatch(/requests, block known-bad ASNs from the auth surface only\./);
    expect(body).toMatch(/- Customer base is EU \+ UK \+ US \+ Switzerland; Cloudflare's EU/);
    expect(body).toMatch(/region is selected for the account, so processing happens in EU/);
    expect(body).toMatch(/PoPs\./);
  });

  it("Headers + Failure-modes framing pinned: '### Headers + auth' + 'API keys in `Authorization: Bearer <plaintext>`.' + 'Server reads `X-Forwarded-For` (Cloudflare populates) into `request.ip`. The legal-acceptance audit log records this IP.' + '`request-id` propagated through requests via Fastify's `request-id` plugin (V-001 / V-006).' + '### Failure modes' + '**Cloudflare-side failure** (rare): `cf.driftstack.dev/health` fails; status page polls the Hetzner VM directly via SSH-tunnel fallback.' + '**Cloudflare Tunnel restart**: ~5 second blip; readiness probe catches it.' + '**Hetzner VM down**: 503s from Cloudflare. Customer SDK retry policy (V-005) handles transient ones; persistent failure triggers the alert path.' — pinned so the API-keys-Authorization-Bearer-plaintext + X-Forwarded-For-Cloudflare-populates-into-request.ip + legal-acceptance-audit-IP + V-001/V-006 request-id-plugin + 3-failure-mode (Cloudflare-side-rare + Tunnel-restart-~5s-blip + Hetzner-VM-down-503 + V-005-SDK-retry) commitment survives", () => {
    expect(body).toMatch(/### Headers \+ auth/);
    expect(body).toMatch(/- API keys in `Authorization: Bearer <plaintext>`\./);
    expect(body).toMatch(/- Server reads `X-Forwarded-For` \(Cloudflare populates\) into/);
    expect(body).toMatch(/`request\.ip`\. The legal-acceptance audit log records this IP\./);
    expect(body).toMatch(/- `request-id` propagated through requests via Fastify's/);
    expect(body).toMatch(/`request-id` plugin \(V-001 \/ V-006\)\./);
    expect(body).toMatch(/### Failure modes/);
    expect(body).toMatch(
      /- \*\*Cloudflare-side failure\*\* \(rare\): `cf\.driftstack\.dev\/health`/,
    );
    expect(body).toMatch(/fails; status page polls the Hetzner VM directly via SSH-tunnel/);
    expect(body).toMatch(/fallback\./);
    expect(body).toMatch(/- \*\*Cloudflare Tunnel restart\*\*: ~5 second blip; readiness probe/);
    expect(body).toMatch(/catches it\./);
    expect(body).toMatch(/- \*\*Hetzner VM down\*\*: 503s from Cloudflare\. Customer SDK retry/);
    expect(body).toMatch(/policy \(V-005\) handles transient ones; persistent failure/);
    expect(body).toMatch(/triggers the alert path\./);
  });

  it("§2 marketing-site edge-cacheable + app-tunneled split framing pinned: '## §2. Customer ↔ marketing site' + '`driftstack.dev` and `docs.driftstack.dev` deploy via Cloudflare Pages (Astro static-first build per Workstream B). No backend on the marketing site itself; the signup flow + customer dashboard surface live on the control plane.' + 'driftstack.dev' + 'docs.driftstack.dev' + 'app.driftstack.dev' + '(signup + acceptance + first-key)' + 'The split between `driftstack.dev` (static marketing) and `app.driftstack.dev` (dynamic onboarding + dashboard) keeps the marketing site cacheable at the edge while the dynamic surface goes through the Tunnel.' — pinned so the §2 marketing+docs CF Pages static-first + Workstream-B + signup-on-control-plane + app.driftstack.dev (signup+acceptance+first-key) + edge-cacheable-vs-tunneled split commitment survives", () => {
    expect(body).toMatch(/## §2\. Customer ↔ marketing site/);
    expect(body).toMatch(/`driftstack\.dev` and `docs\.driftstack\.dev` deploy via Cloudflare/);
    expect(body).toMatch(/Pages \(Astro static-first build per Workstream B\)\./);
    expect(body).toMatch(/No backend on the/);
    expect(body).toMatch(/marketing site itself; the signup flow \+ customer dashboard surface/);
    expect(body).toMatch(/live on the control plane\./);
    expect(body).toMatch(/driftstack\.dev/);
    expect(body).toMatch(/docs\.driftstack\.dev/);
    expect(body).toMatch(/app\.driftstack\.dev/);
    expect(body).toMatch(/\(signup \+ acceptance \+ first-key\)/);
    expect(body).toMatch(/The split between `driftstack\.dev` \(static marketing\) and/);
    expect(body).toMatch(/`app\.driftstack\.dev` \(dynamic onboarding \+ dashboard\) keeps the/);
    expect(body).toMatch(/marketing site cacheable at the edge while the dynamic surface goes/);
    expect(body).toMatch(/through the Tunnel\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
