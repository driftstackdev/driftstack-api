// W315.B — drift guard for /trust/security-overview page. Pins the
// customer-visible security posture claims: scrypt at rest, AES-256-GCM
// for TOTP secrets, sha256-hashed CLI auth codes, TLS 1.3, HMAC-SHA256
// outbound webhooks, EU-only data plane (Hetzner Nuremberg / Neon
// Frankfurt / Cloudflare R2 EU).

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

  it('claims TLS 1.3 on customer-facing paths', () => {
    expect(body).toMatch(/TLS\s*1\.3/);
  });

  it('claims HMAC-SHA256 outbound webhook signing', () => {
    expect(body).toMatch(/HMAC[- ]SHA[- ]?256/);
  });

  it('positions EU-only data plane (Hetzner / Neon / Cloudflare R2 EU)', () => {
    expect(body).toMatch(/EU[- ]only data plane/i);
    expect(body).toMatch(/Hetzner\s+Nuremberg/);
    expect(body).toMatch(/Neon\s+Frankfurt/);
    expect(body).toMatch(/Cloudflare R2 EU/);
  });

  it('claims SHA-256 hashed CLI authorization codes', () => {
    expect(body).toMatch(/sha256-hashed/i);
  });
});
