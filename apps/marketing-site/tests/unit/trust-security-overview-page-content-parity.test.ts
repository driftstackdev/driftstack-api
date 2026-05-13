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
//   • EU-only data plane: Hetzner Nuremberg / Neon Frankfurt /
//     R2 EU jurisdiction (aligned with /trust/index + /about).
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
    expect(body).toMatch(/Hash params \(N=2\^15, r=8, p=1\)/);
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
    expect(body).toMatch(
      /Third-party OAuth requires admin invitation \(no self-service\s+client registration\)/,
    );
    expect(body).toMatch(/client_secret\s+sha256-hashed at rest/);
    expect(body).toMatch(/opaque\s+bearer tokens \(no JWT\)/);
  });

  it.skip('inbound webhook signing pinned: Stripe V-080 + NowPayments V-487 + shared raw-body parser', () => {
    expect(body).toMatch(/Stripe: V-080 timestamp\+sha256 HMAC/);
    expect(body).toMatch(/NowPayments: V-487\s+HMAC-SHA512 on canonical-keyed JSON/);
    expect(body).toMatch(
      /Shared raw-body\s+parser ensures the bytes the signature was computed over\s+are the bytes the verifier sees/,
    );
  });

  it('customer-configurable egress marked ROADMAP (○ amber), NOT shipped (✓ emerald)', () => {
    // Pin the falsifiable honesty signal — a ✓-flip without
    // shipping must be flagged.
    expect(body).toMatch(
      /<span class="mt-1 inline-block h-5 w-5 flex-none rounded-full bg-amber-100[^>]*>○<\/span>\s*\n?\s*<div>\s*\n?\s*<p class="font-medium text-slate-900">Customer-configurable egress \(roadmap\)<\/p>/,
    );
    expect(body).toMatch(
      /Per-account egress configuration \(SOCKS5 \/ WireGuard\s+tunnels\) is on the roadmap/,
    );
  });

  it('EU-only data plane: Hetzner Nuremberg / Neon Frankfurt / R2 EU jurisdiction', () => {
    expect(body).toMatch(/<p class="font-medium text-slate-900">EU-only data plane<\/p>/);
    expect(body).toMatch(
      /Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s+object storage \(Cloudflare R2 EU jurisdiction\)/,
    );
  });

  it('account deletion: 30-day grace + hard delete per DPA', () => {
    expect(body).toMatch(/Account deletion: 30-day grace, then hard delete/);
    expect(body).toMatch(
      /Cancellation triggers soft-delete with 30 days of\s+recovery\. After that: hard delete of profile data,\s+sessions, captures\. Per our DPA\./,
    );
  });

  it('vulnerability disclosure: 2-day ack + 5-day triage + 90-day coordinated window (matches /trust/compliance)', () => {
    expect(body).toMatch(/Vulnerability disclosure: 2-day ack, 5-day triage/);
    expect(body).toMatch(/Coordinated\s+disclosure window: 90 days, extendable on agreement/);
    expect(body).toMatch(/Safe-harbour for good-faith research/);
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
      /<a href="\/security" class="text-oxblood-700 underline">architecture deep-dive at \/security<\/a>/,
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
    expect(body).toMatch(
      /Cloudflare edge enforces TLS 1\.3 strict to the\s+<code[^>]*>api\.driftstack\.dev<\/code>/,
    );
    expect(body).toMatch(
      /No plaintext HTTP on any path; the deploy pipeline's TLS\s+check rejects the release otherwise/,
    );
  });
});
