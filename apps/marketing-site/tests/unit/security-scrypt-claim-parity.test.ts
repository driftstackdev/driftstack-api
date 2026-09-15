// W313.B — drift guard for /security crypto claims. The page
// promises:
//   • scrypt-hashed API keys (logN=15)
//   • HMAC-SHA256 webhook signatures with 5-minute timestamp tolerance
//   • 24-hour grace on webhook secret rotation
// All three must match the live implementation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');
// 2026-09-15 plain-language pass: the scrypt tuning parameter left the
// plain-terms /security page; the developer-facing docs/security-overview
// page carries it, so the falsifiable logN pin moved there.
const DEV_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/security-overview.astro');
const SVC = resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts');
const SDK_WEBHOOK = resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W313.B /security crypto claim parity', () => {
  const page = read(PAGE);
  const svc = read(SVC);
  const sdk = read(SDK_WEBHOOK);

  it('page claims scrypt-hashed API keys; the developer page carries logN=15', () => {
    expect(page).toMatch(/API keys are scrambled one-way with scrypt/);
    expect(page).toMatch(/one-way scrypt hashes/);
    expect(read(DEV_PAGE)).toMatch(/scrypt<\/code> \(logN=15\)/);
  });

  it('server uses scrypt-kdf with logN: 15 r: 8 p: 1', () => {
    expect(svc).toMatch(/scryptKdf\.kdf/);
    expect(svc).toMatch(/logN:\s*15/);
    expect(svc).toMatch(/r:\s*8/);
    expect(svc).toMatch(/p:\s*1/);
  });

  it('page claims HMAC-SHA256 signed webhook deliveries', () => {
    expect(page).toMatch(/HMAC[- ]SHA[- ]?256/);
  });

  it('SDK uses HMAC + SHA-256 to verify (matches page claim)', () => {
    expect(sdk).toMatch(/name:\s*['"]HMAC['"]/);
    expect(sdk).toMatch(/hash:\s*['"]SHA-256['"]/);
  });

  it('page claims 5-minute replay window on webhook signatures', () => {
    expect(page).toMatch(/5[- ]minute/i);
  });

  it('SDK default tolerance is 300 seconds (5 min)', () => {
    expect(sdk).toMatch(/DEFAULT_TOLERANCE_SEC\s*=\s*300/);
  });

  it('page claims 24-hour grace on webhook-secret rotation', () => {
    expect(page).toMatch(/24[- ]hour grace/i);
  });
});
