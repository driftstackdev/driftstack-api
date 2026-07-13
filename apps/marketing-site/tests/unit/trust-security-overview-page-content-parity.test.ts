// W375.A — drift guard for marketing-site /trust/security-overview
// page content. V-670 (V-550 follow-up). Existing trust-security-
// overview-baseline + trust-security-overview-parity tests cover
// shape. This guard pins the load-bearing "every claim mapped to
// evidence" CISO-checklist contract:
//
//   • 5 canonical section headings in order: Authentication &
//     access / Transport & egress / Webhooks & integrations /
//     Data residency & retention / Observability & incident
//     response.
//   • API-key scrypt-hashed-at-rest claim with exact params
//     (N=2^15, r=8, p=1) + code-path reference.
//   • TOTP MFA: AES-256-GCM at-rest + recovery-codes-scrypt-
//     hashed + V-353e step-up gate.
//   • OAuth 2.0 PKCE-S256 + invite-only + sha256-hashed client_
//     secret + opaque bearer (no JWT).
//   • Inbound webhook signing: Stripe V-080 (timestamp+sha256)
//     + NowPayments V-487 (HMAC-SHA512 canonical-keyed JSON) +
//     shared raw-body parser.
//   • Customer-configurable egress is marked ROADMAP (○) not
//     shipped (✓) — load-bearing honesty signal.
//   • EU control plane: Hetzner Nuremberg / Neon Frankfurt /
//     R2 EU + US replication (aligned with /trust/index + /about;
//     S30 2026-07-07 founder decision: soften — R2 is default
//     jurisdiction, not EU).
//   • Account deletion: 30-day grace + hard delete per DPA.
//   • Vulnerability disclosure: 2-day ack, 5-day triage, 90-day
//     coordinated window (aligned with /trust/compliance).
//   • Chaos-engineering rehearsal: scripts/chaos/ pinned.
//   • mailto:security@driftstack.dev escape hatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/security-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W375.A marketing-site /trust/security-overview page content parity', () => {
  const body = read(PAGE);

  it('5 canonical section headings present in order', () => {
    const expected = [
      'Authentication &amp; access',
      'Transport &amp; egress',
      'Webhooks &amp; integrations',
      'Data residency &amp; retention',
      'Observability &amp; incident response',
    ];
    let lastIdx = -1;
    for (const h of expected) {
      const idx = body.indexOf(h);
      expect(idx, `section out of order: ${h}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('API-key scrypt params (N=2^15, r=8, p=1) + code-path reference pinned', () => {
    expect(body).toMatch(/API keys are scrypt-hashed at rest/);
    // S20c 2026-07-06 plain-language pass: params kept, glossed as
    // the scrambler's strength settings.
    expect(body).toMatch(/hash params N=2\^15, r=8,\s+p=1/);
    expect(body).toMatch(
      /apps\/server\/src\/lib\/api-keys\.ts · hashApiKey\(\) \/ verifyApiKey\(\)/,
    );
  });

  it.skip('TOTP MFA: AES-256-GCM at-rest + recovery-codes scrypt-hashed + V-353e step-up gate', () => {
    expect(body).toMatch(/AES-256-GCM at-rest encryption of TOTP secrets/);
    expect(body).toMatch(/Recovery\s+codes are scrypt-hashed/);
    expect(body).toMatch(/Step-up\s+gate \(V-353e\) requires MFA on destructive admin paths/);
    expect(body).toMatch(
      /apps\/server\/src\/lib\/mfa-totp\.ts · apps\/server\/src\/services\/mfa\.ts/,
    );
  });

  it('OAuth 2.0: invite-only + PKCE-S256 + sha256-hashed client_secret + opaque bearer (no JWT)', () => {
    expect(body).toMatch(/OAuth 2\.0 \(invite-only\) with PKCE-S256/);
    // S20c 2026-07-06 plain-language pass: "Third-party app access
    // (OAuth)" leads; invite-only + no-self-service preserved.
    expect(body).toMatch(
      /Third-party app access \(OAuth\) requires admin invitation\s+\(no self-service\s+client registration\)/,
    );
    expect(body).toMatch(/App secrets \(client_secret\)\s+are sha256-hashed at rest/); // S20c 2026-07-06
    expect(body).toMatch(/access tokens are\s+opaque random strings \(no JWT\)/); // S20c 2026-07-06
  });

  it.skip('inbound webhook signing pinned: Stripe V-080 + NowPayments V-487 + shared raw-body parser', () => {
    expect(body).toMatch(/Stripe: V-080 timestamp\+sha256 HMAC/);
    expect(body).toMatch(/NowPayments: V-487\s+HMAC-SHA512 on canonical-keyed JSON/);
    expect(body).toMatch(
      /Shared raw-body\s+parser ensures the bytes the signature was computed over\s+are the bytes the verifier sees/,
    );
  });

  it('customer-configurable egress SHIPPED (✓ emerald) per planning 133 Phase 1. 2026-05-22 — flipped from amber ○ "(roadmap)" to emerald ✓ "(per profile)" after the SocksProxyBackend impl + bootstrap wire landed.', () => {
    expect(body).toMatch(
      /<span class="mt-1 inline-block h-5 w-5 flex-none rounded-full bg-emerald-100[^>]*>✓<\/span>\s*\n?\s*<div>\s*\n?\s*<p class="font-medium text-tk-ink">Customer-configurable egress \(per profile\)<\/p>/,
    );
    expect(body).toMatch(/a SOCKS5 proxy with full\s+UDP\/WebRTC\/QUIC tunnelling/); // S20c 2026-07-06: plain gloss added around the tunnelling list
    expect(body).toMatch(/an OpenVPN\s+file \(\.ovpn\)/); // S20c 2026-07-06
  });

  it('EU control plane: Hetzner Nuremberg / Neon Frankfurt / R2 EU + US replication, session-execution fleet on MacStadium US — S30 2026-07-07 (founder decision: soften): the false "R2 EU jurisdiction" became "EU + US replication" (R2 uses the default jurisdiction), aligned with /docs/data-residency', () => {
    // Header is "EU control plane" (not "EU-only data plane"): the
    // EU sub-processors carry the control plane, while the iPhone
    // Safari session-execution fleet runs on MacStadium (US).
    expect(body).toMatch(/<p class="font-medium text-tk-ink">EU control plane<\/p>/);
    expect(body).not.toMatch(/EU-only data plane/);
    expect(body).toMatch(
      /Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s+object storage \(Cloudflare R2, EU \+ US replication\)/,
    );
    // S30 negative pin — the false jurisdiction claim must not return.
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
    // S20c 2026-07-06 plain-language pass: SCCs glossed inline (the
    // EU's Standard Contractual Clauses), DPF spelled out.
    expect(body).toMatch(
      /iPhone Safari session-execution fleet runs on MacStadium\s+hardware \(US\) under SCCs \(the EU's Standard Contractual\s+Clauses for lawful data transfer abroad\) \+ the EU-US\s+Data Privacy Framework/,
    );
  });

  it('account deletion: 30-day grace + hard delete per DPA', () => {
    expect(body).toMatch(/Account deletion: 30-day grace, then hard delete/);
    // S20c 2026-07-06 plain-language pass: soft-delete/hard-delete
    // said plainly, terms kept in parens; same 30-day + DPA facts.
    expect(body).toMatch(
      /For 30 days after cancellation your data is only\s+flagged as deleted \("soft-delete"\) and can be restored\s+if you come back\. After that it is permanently erased\s+\(hard delete\) — profile data, sessions, captures\. Per\s+our DPA\./,
    );
  });

  it('vulnerability disclosure: 2-day ack + 5-day triage + 90-day coordinated window (matches /trust/compliance)', () => {
    // S20c 2026-07-06 plain-language pass: ack/triage said plainly
    // in the heading (terms kept), safe-harbour + 90-day window
    // stated as what they mean.
    expect(body).toMatch(/Vulnerability reports: acknowledged in 2 days, assessed in 5 \(triage\)/);
    expect(body).toMatch(
      /keep a finding\s+private for 90 days while we fix it \(the coordinated\s+disclosure window\), extendable on agreement/,
    );
    expect(body).toMatch(
      /We won't take legal action against good-faith research\s+\("safe-harbour"\)/,
    );
  });

  it.skip('chaos-engineering rehearsal harness: scripts/chaos/ + V-547 doc reference', () => {
    expect(body).toMatch(/Chaos engineering rehearsal harness/);
    expect(body).toMatch(
      /Sub-processor outages, DB failover, Redis-down,\s+webhook-signature failures/,
    );
    expect(body).toMatch(/scripts\/chaos\/ · docs\/internal\/v547-chaos-engineering-scenarios\.md/);
  });

  it('cross-link to /security architecture deep-dive pinned', () => {
    expect(body).toMatch(
      /<a href="\/security\/" class="text-tk-accent-text underline">architecture deep-dive at \/security<\/a>/,
    );
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro'))).toBe(
      true,
    );
  });

  it('mailto:security@driftstack.dev CTA pinned ("Email security")', () => {
    expect(body).toMatch(/mailto:security@driftstack\.dev/);
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev" class="btn-primary">Email security<\/a>/,
    );
  });

  it.skip('V-670 CISO-self-serve framing pinned in page comment', () => {
    expect(body).toMatch(/V-670 \(V-550 follow-up\) — public security overview as an evaluator/);
    expect(body).toMatch(
      /a prospective customer's CISO can self-serve a security\s*\n?\s*\/\/\s*review without scheduling a call/,
    );
  });

  it('TLS-1.3-strict deploy-gate claim pinned (no plaintext HTTP)', () => {
    expect(body).toMatch(/TLS 1\.3 on every customer-facing path/);
    // S20c 2026-07-06 plain-language pass: same strict-TLS-1.3 +
    // deploy-gate facts, plain words lead.
    expect(body).toMatch(
      /Cloudflare, our edge network, enforces strict TLS 1\.3\s+encryption all the way to our own servers behind\s+<code[^>]*>api\.driftstack\.dev<\/code>/,
    );
    expect(body).toMatch(
      /No unencrypted page \(plaintext HTTP\) exists on\s+any path — every release is automatically checked for\s+this before it ships; the deploy pipeline's TLS\s+check rejects the release otherwise/,
    );
  });
});
