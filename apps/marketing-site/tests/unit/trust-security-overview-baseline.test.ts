// W315.B — drift guard for /trust/security-overview page. Pins the
// customer-visible security posture claims: scrypt at rest, AES-256-GCM
// for TOTP secrets, sha256-hashed CLI auth codes, TLS 1.2+, HMAC-SHA256
// outbound webhooks, EU-hosted core services (Hetzner Falkenstein / Neon
// Frankfurt / Cloudflare R2 with EU + US copies).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/security-overview.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W315.B /trust/security-overview baseline', () => {
  const body = read(PAGE);

  it('claims scrypt-hashed API keys at rest', () => {
    expect(body).toMatch(/scrypt-hashed at rest/i);
  });

  it('claims AES-256-GCM for TOTP secrets', () => {
    expect(body).toMatch(/AES-256-GCM/i);
  });

  it('claims scrypt for MFA recovery codes', () => {
    expect(body).toMatch(/[Rr]ecovery[\s\S]{0,40}scrypt-hashed/);
  });

  it('claims TLS 1.2 or newer on every connection (origin nginx: ssl_protocols TLSv1.2 TLSv1.3)', () => {
    expect(body).toMatch(/TLS 1\.2 or newer/);
    // The old "strict TLS 1.3" wording implied 1.2 clients are refused; they are not.
    expect(body).not.toMatch(/strict TLS 1\.3/);
  });

  it('claims HMAC-SHA256 outbound webhook signing', () => {
    expect(body).toMatch(/HMAC[- ]SHA[- ]?256/);
  });

  it('positions EU-hosted core services (Hetzner / Neon) + honestly-scoped R2 with iPhone Safari sessions on MacStadium US', () => {
    // The control plane is EU-only; the session-execution driver
    // fleet runs on MacStadium (US) under SCCs + EU-US DPF, so the
    // data plane is NOT "EU-only".
    // S30 2026-07-07 (founder decision: soften) — R2 buckets live in
    // Cloudflare's default jurisdiction (verified on the prod box),
    // so the old "Cloudflare R2 EU" positioning over-claimed; the page
    // now states the EU + US replication reality.
    // 2026-09-15 owner directive: "control plane" / "fleet" are banned on
    // customer surfaces; the heading now says what is hosted where.
    expect(body).toMatch(/Core services hosted in the EU/);
    expect(body).not.toMatch(/control plane/i);
    expect(body).not.toMatch(/EU[- ]only data plane/i);
    expect(body).toMatch(/Falkenstein, Germany \(Hetzner\)/);
    expect(body).toMatch(/Frankfurt \(Neon\)/);
    expect(body).toMatch(/Cloudflare R2, which\s+keeps copies in both the EU and the US/);
    expect(body).not.toMatch(/Cloudflare R2 EU\b/);
    expect(body).toMatch(/US infrastructure \(MacStadium\)/);
  });

  it('claims SHA-256 hashed CLI authorization codes', () => {
    expect(body).toMatch(/sha256-hashed/i);
  });
});
