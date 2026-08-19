// W246.A — drift-guard for /security (the public security marketing
// page). Previous revisions asserted unsupported mTLS and treated
// SOCKS5 / WireGuard / OpenVPN as one all-or-nothing capability.
// Production currently wires only the concrete SOCKS5 backend.

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

  // V-921: a CONCRETE marker, not a mention. The gate here was
  // /mTLS|clientCert|client.cert/ over apps/server/src, which is satisfied by
  // three files that contain no implementation at all: two comments and an
  // OpenAPI description string, all describing the OPERATOR fleet-node edge
  // (Cloudflare Authenticated Origin Pulls — infra, not server code). So the
  // arm below had already retired on prose, and the page could have claimed
  // customer-facing mTLS with nothing objecting. Customer mTLS would mean a TLS
  // server asking for a client certificate, so that is what is checked.
  const hasCustomerMtls = serverSourceMatches(/requestCert:\s*true/);

  it('CRITICAL no customer-facing mTLS is implemented, which is the fact the arm below depends on. Asserted separately so that if it ever ships, THIS fails first and the claim becomes sayable — rather than the old gate, which a comment mentioning mTLS was enough to open.', () => {
    expect(hasCustomerMtls, 'no TLS listener requests a client certificate').toBe(false);
  });

  it.skipIf(hasCustomerMtls)('does not assert mTLS without a server-side impl', () => {
    expect(doc).not.toMatch(/mTLS,?\s+end to end/);
    expect(doc).not.toMatch(/client-cert validation/);
  });

  it('publishes only the concrete SOCKS5 egress backend', () => {
    expect(serverSourceMatches(/class SocksProxyBackend implements SessionEgressService/)).toBe(
      true,
    );
    expect(doc).toMatch(/public SOCKS5 proxy/);
    expect(doc).toMatch(
      /Without an\s+attached config, session traffic exits via Driftstack-managed\s+infrastructure/,
    );
    expect(doc).not.toMatch(/OpenVPN/);
    expect(doc).not.toMatch(/WireGuard/);
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

  it('aligns session access and recoverable-key wording with the implemented legal/crypto boundary', () => {
    expect(doc).toMatch(/platform-held keys/);
    expect(doc).toMatch(/processed through LiveKit/);
    expect(doc).toMatch(/no administrative\s+path for Driftstack staff to join/);
    expect(doc).toMatch(/not retained by the Capture endpoint/);
    expect(doc).not.toMatch(/We don't see your traffic\. We can't read your keys\./);
    expect(doc).not.toMatch(/Nobody at Driftstack can watch your sessions/);
    expect(doc).not.toMatch(/none of it ever reaches our servers/);
  });
});
