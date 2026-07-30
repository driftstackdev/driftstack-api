// W332.B — drift guard for /security egress framing. Customer-
// configurable egress ships as a per-profile SOCKS5 exit (planning 133
// Phase 1 + the SocksProxyBackend impl wired in bootstrap). Phases 2/3
// (OpenVPN / WireGuard) have saved-proxy plumbing + a desktop-client UI
// but NO server-side egress backend and no pre-launch connectivity
// check, so the 2026-07-17 truth pass (e36e5b4e2) narrowed this page to
// the SOCKS5 exit and made UDP/QUIC routing + remote DNS explicitly
// proxy-capability-dependent. This guard now protects BOTH directions:
// no drift back to roadmap-style hedging of the shipped SOCKS5 exit,
// and no drift forward into advertising VPN modalities or the removed
// "DNS leaks blocked" / "traffic types many proxies drop" absolutes.

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

describe('W332.B /security egress framing (shipped)', () => {
  const body = read(PAGE);

  it('section header reads plain "Egress" (no "(roadmap)" hedge)', () => {
    expect(body).toMatch(/02 · Egress/);
    expect(body).not.toMatch(/02 · Egress \(roadmap\)/);
  });

  it('lists the egress modality that is actually wired server-side (SOCKS5) and keeps its capability caveat', () => {
    // 2026-07-17 (e36e5b4e2): OpenVPN / WireGuard pins retired here.
    // Server-side the ONLY implementation is `class SocksProxyBackend
    // implements SessionEgressService` (apps/server/src/services/
    // proxy-backends/socks5.ts); the pre-launch proxy gate explicitly
    // skips VPN schemes (apps/server/src/routes/agent-sessions.ts), and
    // apps/server/tests/unit/security-page-doc-parity.test.ts (W246.A,
    // green) forbids both words on this page until a backend ships.
    // Marketing must not re-advertise them here first.
    expect(body).toMatch(/02 · Egress/);
    expect(body).toMatch(/Per-profile SOCKS5; capability reported after launch\./);
    expect(body).toMatch(
      /UDP \/ WebRTC \/ QUIC routing depends on the proxy's\s+reported UDP capability/,
    );
    expect(body).not.toMatch(/OpenVPN/);
    expect(body).not.toMatch(/WireGuard/);
  });

  it('describes egress as a per-profile capability (shipped) with its fail-closed limits', () => {
    expect(body).toMatch(/A profile can attach a public SOCKS5 proxy as its exit/);
    expect(body).toMatch(/blocks internal proxy targets, and requests\s+remote DNS/);
    expect(body).not.toMatch(/DNS\s+leaks blocked/);
  });
});
