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

  it('section header reads plain "Proxies" (no "(roadmap)" hedge)', () => {
    // 2026-09-15 plain-language pass: the eyebrow label dropped the
    // glossary word "Egress" for "Proxies"; the body still links the
    // glossary entry.
    expect(body).toMatch(/02 · Proxies/);
    expect(body).not.toMatch(/02 · Proxies \(roadmap\)/);
    expect(body).not.toMatch(/02 · Egress/);
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
    expect(body).toMatch(/02 · Proxies/);
    expect(body).toMatch(/Per-profile SOCKS5; UDP support shown once the session is running\./);
    expect(body).toMatch(
      /Whether WebRTC and HTTP\/3\s+traffic can use the proxy depends on your proxy's UDP support,\s+and is shown once the session is running/,
    );
    expect(body).not.toMatch(/OpenVPN/);
    expect(body).not.toMatch(/WireGuard/);
  });

  it('describes egress as a per-profile capability (shipped) with its fail-closed limits', () => {
    // 2026-09-15 plain-language pass: same facts (public address only,
    // pre-launch reachability check, DNS through the proxy, private /
    // local targets rejected) in customer words.
    expect(body).toMatch(/A profile can attach a SOCKS5 proxy at a public address as its\s+exit/);
    expect(body).toMatch(/website address lookups go through the proxy\s+too/);
    expect(body).toMatch(/Proxies on\s+private or local addresses[\s\S]{0,90}are not accepted/);
    expect(body).not.toMatch(/DNS\s+leaks blocked/);
  });
});
