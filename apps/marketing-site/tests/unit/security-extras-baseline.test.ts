// W321.B — drift guard for /security page extras. Beyond the
// scrypt + HMAC + TLS claims (covered in W306/W313), the page makes
// architectural promises that customers may quote in their own
// compliance reviews:
//   • live-media handling boundary (LiveKit relay, no staff join
//     path, Capture artifacts inline + non-retained, desktop
//     recordings never uploaded)
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

  it('positions the implemented live-media / staff-access boundary (2026-07-17 e36e5b4e2 replaced the "no-customer-data-access" posture claim, which the Capture endpoint contradicted)', () => {
    expect(body).toMatch(/06 · Live-media handling/);
    // 2026-09-15 plain-language pass: same boundary, customer words
    // (LiveKit vendor name lives on the sub-processor register).
    expect(body).toMatch(
      /Live-session streams\s+are encrypted in transit, used to deliver the session to you,\s+and dropped when the session ends/,
    );
    expect(body).toMatch(
      /Driftstack staff have no\s+built-in way to join a customer's live session/,
    );
    expect(body).toMatch(/returned directly in\s+the API response and are not stored/);
    expect(body).toMatch(/desktop recordings stay\s+on your own computer and are not uploaded/);
    expect(body).not.toMatch(/no[- ]customer[- ]data[- ]access/i);
    expect(body).not.toMatch(/none of it ever reaches our servers/);
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
