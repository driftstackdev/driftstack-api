// W321.B — drift guard for /security page extras. Beyond the
// scrypt + HMAC + TLS claims (covered in W306/W313), the page makes
// architectural promises that customers may quote in their own
// compliance reviews:
//   • no-customer-data-access posture
//   • MFA TOTP secrets in AES-256-GCM ciphertext
//   • GDPR Article 20 portability — audit-log export shipped
//   • EU jurisdiction — sub-processor list cited at /trust/sub-processors
//   • realistic threat-model framing (no overclaim against
//     nation-state actors w/ sub-processor access)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W321.B /security extras baseline', () => {
  const body = read(PAGE);

  it('positions no-customer-data-access posture', () => {
    expect(body).toMatch(/no[- ]customer[- ]data[- ]access/i);
  });

  it('claims AES-256-GCM for TOTP secrets', () => {
    expect(body).toMatch(/AES-256-GCM/i);
  });

  it('promises audit-log export aligned with GDPR Article 20', () => {
    expect(body).toMatch(/GDPR Article 20/i);
  });

  it('cross-links to /trust/sub-processors', () => {
    expect(body).toContain('/trust/sub-processors');
  });

  it('honest framing about nation-state sub-processor access risk', () => {
    expect(body).toMatch(/[Nn]ation-state actors[^.]{0,80}sub-processor access/);
  });
});
