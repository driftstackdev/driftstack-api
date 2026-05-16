// W246.A — drift-guard for /security (the public security marketing
// page). Previous revision asserted "mTLS, end to end" + "Customer-
// controlled egress (SOCKS5 / WireGuard / OpenVPN)" as shipped
// pillars; neither has a server-side implementation today. This
// guard pins the page to /trust/security-overview's truth.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'security.astro');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function serverSourceMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W246.A /security page doc parity', () => {
  const doc = read();

  it('does not assert mTLS without a server-side impl', () => {
    const hasMtls = serverSourceMatches(/mTLS|clientCert|client.cert/);
    if (!hasMtls) {
      expect(doc).not.toMatch(/mTLS,?\s+end to end/);
      expect(doc).not.toMatch(/client-cert validation/);
    }
  });

  it('flags customer-controlled egress as roadmap while no impl exists', () => {
    // V-540.E (2026-05-16): gate now requires the CONCRETE wire — the
    // interface-alone scaffolding (E1) is NOT a gate trip; only the
    // full backend (E2/E3/E4) + bootstrap wire (E8) flips it.
    const hasEgressImpl =
      serverSourceMatches(/sessionEgressService:\s*sessionEgressService/) &&
      serverSourceMatches(/implements SessionEgressService\b/);
    if (!hasEgressImpl) {
      // Must NOT call it shipped.
      expect(doc).not.toMatch(/Customer-controlled\.?\s*Always\./);
      // Must flag as roadmap and cross-link to security-overview.
      expect(doc).toMatch(/Customer-configurable egress/);
      expect(doc).toMatch(/roadmap/i);
      expect(doc).toMatch(/\/trust\/security-overview/);
    }
  });

  it('does not promise "session traffic exits through your proxy" as a current scope-exclusion', () => {
    expect(doc).not.toMatch(/session traffic exits through your\s+proxy/i);
  });

  it('keeps the genuine shipped pillars (scrypt keys, HMAC webhooks, RBAC, EU-resident infra)', () => {
    expect(doc).toMatch(/scrypt/);
    expect(doc).toMatch(/HMAC-SHA256/);
    expect(doc).toMatch(/Admin \/ member roles/);
    expect(doc).toMatch(/EU-default|EU-resident|EU \(Hetzner/);
  });

  it('aligns transport pillar with the helmet HSTS posture', () => {
    expect(doc).toMatch(/TLS 1\.2 \+ 1\.3|TLS 1\.3/);
    expect(doc).toMatch(/HSTS/i);
  });
});
