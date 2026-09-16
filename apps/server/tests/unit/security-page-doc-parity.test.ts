// W246.A — drift-guard for /security (the public security marketing
// page). Previous revisions asserted unsupported mTLS and treated
// SOCKS5 / WireGuard / OpenVPN as one all-or-nothing capability.
// Production currently wires only the concrete SOCKS5 backend.
//
// 2026-09-15 truth pass: that backend is the LIVE CONNECTION CHECK; the VPN
// schemes ship as customer-attached egress (encrypted account_proxies rows,
// /v1/account/me/proxies, proxy_id → dispatch, the .ovpn directive sweep in
// packages/api-types/src/openvpn-directives.ts) and are named on the page
// with their own check described. The word-bans below became positive pins.

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

  it('scopes the live connection check to the concrete SOCKS5 backend and names the VPN schemes with their own check', () => {
    expect(serverSourceMatches(/class SocksProxyBackend implements SessionEgressService/)).toBe(
      true,
    );
    // 2026-09-15 plain-language pass: same facts (public-address SOCKS5),
    // customer words.
    expect(doc).toMatch(/SOCKS5 proxy at a public address/);
    // 2026-09-15 truth pass: the desktop app refuses to build a proxy-less
    // create body (apps/gui-client/src/views/ProfilesView.tsx, "Every session
    // needs a proxy"), and the OpenVPN / WireGuard word-bans became positive
    // pins with the check described per scheme.
    // 2026-09-15 refuter: the "managed exit" fallback was an INVENTED feature —
    // no Driftstack-run exit is configured for production (infra/env-templates/
    // production.env.template leaves DEFAULT_EGRESS_HOST/PORT empty on purpose:
    // "UNSET IS VALID AND DELIBERATE"; production.env carries no DEFAULT_EGRESS_*
    // line; apps/server/src/routes/agent-sessions.ts dispatches NO proxy when
    // proxy_id is omitted and a REQUIRE_PROXY=1 node refuses by name). The page
    // now says an API session names a saved proxy and that no shared Driftstack
    // exit exists; the old clause is negatively pinned so it cannot return.
    // 2026-09-15 refuter: VPN exits are tier-gated (TIER_FEATURES.free.vpnEgress
    // = false; routes/account-me.ts requireTierFeature('vpnEgress')), and the
    // line-naming refusal is OpenVPN-only (packages/api-types/src/
    // openvpn-directives.ts); a WireGuard .conf is parsed GUI-side into
    // structured fields and its PostUp/PreUp hooks are read but never consulted
    // (apps/gui-client/src/lib/parse-wireguard.ts). Both are now stated.
    expect(doc).toMatch(
      /a session created through the API names one of your\s+saved proxies when it is created\. Driftstack does not route your\s+traffic through a shared exit of its own\./,
    );
    expect(doc).not.toMatch(/managed exit/);
    expect(doc).toMatch(/or an OpenVPN file \(\.ovpn\) or WireGuard file \(\.conf\)/);
    expect(doc).toMatch(/VPN exits\s+are on paid plans/);
    expect(doc).toMatch(/a SOCKS5 proxy can be reached\s+with a real connection through it/);
    expect(doc).toMatch(/Driftstack does not run scripts\s+from VPN configs/);
    expect(doc).toMatch(
      /An OpenVPN file that carries a script directive\s+is refused with the line named/,
    );
    expect(doc).toMatch(/PostUp\/PreUp hooks are never used/);
    expect(doc).not.toMatch(/that (?:the|a) VPN[^.]{0,60}can be reached/);
  });

  it('does not promise "session traffic exits through your proxy" as a current scope-exclusion', () => {
    expect(doc).not.toMatch(/session traffic exits through your\s+proxy/i);
  });

  it('keeps the genuine shipped pillars (scrypt keys, HMAC webhooks, RBAC, EU-resident infra)', () => {
    expect(doc).toMatch(/scrypt/);
    expect(doc).toMatch(/HMAC-SHA256/);
    expect(doc).toMatch(/Admin and member roles/); // 2026-09-15 plain words
    expect(doc).toMatch(/EU-default|EU-resident|EU \(Hetzner/);
  });

  it('aligns transport pillar with the helmet HSTS posture', () => {
    expect(doc).toMatch(/TLS 1\.2 \+ 1\.3|TLS 1\.3/);
    expect(doc).toMatch(/HSTS/i);
  });

  it('aligns session access and recoverable-key wording with the implemented legal/crypto boundary', () => {
    // 2026-09-15 plain-language pass: the account-bound encryption, the
    // deliver-then-drop media boundary, the no-built-in-staff-join path
    // and the captures-not-stored boundary survive in customer words
    // (the LiveKit vendor name and "Capture endpoint" left the page).
    expect(doc).toMatch(/tying that encryption to your\s+account/);
    expect(doc).toMatch(/used to deliver the session to you,\s+and dropped when the session ends/);
    expect(doc).toMatch(/no\s+built-in way to join a customer's live session/);
    expect(doc).toMatch(/returned directly in\s+the API response and are not stored/);
    // 2026-09-15 refuter: "not stored" is true for POST /v1/sessions/:id/capture
    // only. In an AI-agent session every screenshot step IS retained — the
    // executor puts the bytes in a bounded in-memory SessionCaptureStore
    // (apps/server/src/services/session-capture-store.ts: CAPTURES_PER_SESSION =
    // 20, CAPTURE_SESSION_TTL_MS = 30 min, Map only — never disk) so the desktop
    // app can fetch GET /v1/agent-sessions/:id/captures/:captureId. The page
    // scopes the no-retention claim to the sessions API and discloses the agent
    // path.
    expect(doc).toMatch(/you request through the sessions API are\s+returned directly in/);
    expect(doc).toMatch(/held in server\s+memory for up to 30 minutes \(at most 20 per session\)/);
    expect(doc).toMatch(/never written to\s+disk/);
    expect(doc).not.toMatch(/We don't see your traffic\. We can't read your keys\./);
    expect(doc).not.toMatch(/Nobody at Driftstack can watch your sessions/);
    expect(doc).not.toMatch(/none of it ever reaches our servers/);
  });
});
