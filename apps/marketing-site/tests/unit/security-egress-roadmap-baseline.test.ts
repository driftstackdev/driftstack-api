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
//
// 2026-09-15 truth pass: the VPN half of "no drift forward" is retired —
// customer-attached OpenVPN / WireGuard egress ships (encrypted
// account_proxies rows, /v1/account/me/proxies, proxy_id → dispatch, the
// .ovpn directive sweep) and is named on /, /comparison, /about and
// /trust/security-overview. This guard now pins the honest per-scheme
// description of the pre-launch check instead of banning the words.

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
    // 2026-09-15 refuter: the Test cannot MEASURE HTTP/3 before launch — the
    // native probe has no QUIC signal and apps/gui-client/src/components/
    // ProxyCapabilities.tsx renders it as an inference ("~", never green) until
    // a session or relay check measured it — so the small print says what to
    // expect, not what the proxy "carries".
    expect(body).toMatch(
      /Per-profile SOCKS5, OpenVPN or WireGuard; the Test button shows what to expect from a proxy before you launch\./,
    );
    expect(body).not.toMatch(/shows what your proxy carries/);
    expect(body).toMatch(
      /proxy depends on your proxy's UDP support: the Test button\s+shows what to expect before you launch, and a running session\s+shows whether HTTP\/3 is actually in use/,
    );
    // 2026-09-15 truth pass — the OpenVPN / WireGuard word-bans flipped to
    // positive pins. Customer-attached VPN egress IS shipped: account_proxies
    // rows carry scheme openvpn|wireguard (apps/server/src/db/schema.ts,
    // migration 0082) with AES-256-GCM secrets (apps/server/src/lib/
    // account-proxy-secret-encryption.ts), /v1/account/me/proxies CRUD is
    // live, a proxy_id resolves into the dispatch's inlineProxyConfig, the
    // .ovpn directive sweep refuses program-running lines (packages/api-types/
    // src/openvpn-directives.ts), and the public API docs (apps/docs/src/pages/
    // api/proxies.md) document all three schemes. What the old ban actually
    // guarded — claiming the SOCKS5 live connection check covers a VPN tunnel
    // — is pinned directly instead: the check is scoped to SOCKS5 and the VPN
    // check is described as what it is. The desktop app never builds a
    // proxy-less create body (apps/gui-client/src/views/ProfilesView.tsx,
    // "Every session needs a proxy").
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
    expect(body).toMatch(/or an OpenVPN file \(\.ovpn\) or WireGuard file \(\.conf\)/);
    expect(body).toMatch(/VPN exits\s+are on paid plans/);
    expect(body).toMatch(/a SOCKS5 proxy can be reached\s+with a real connection through it/);
    expect(body).toMatch(/Driftstack does not run scripts\s+from VPN configs/);
    expect(body).toMatch(
      /An OpenVPN file that carries a script directive\s+is refused with the line named/,
    );
    expect(body).toMatch(/PostUp\/PreUp hooks are never used/);
    expect(body).toMatch(
      /Driftstack does not route your\s+traffic through a shared exit of its own/,
    );
    expect(body).not.toMatch(/managed exit/);
    // The live connection check must never be attributed to a VPN tunnel.
    expect(body).not.toMatch(/that (?:the|a) VPN[^.]{0,60}can be reached/);
    // A VPN tunnel carries everything; a TCP-only proxy switches HTTP/3 off
    // rather than leaking it (house form from index.astro / comparison.astro).
    expect(body).toMatch(
      /A VPN tunnel carries\s+everything the profile does, including WebRTC and HTTP\/3\./,
    );
    expect(body).toMatch(/cannot carry HTTP\/3, it is switched off rather than leaked/);
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
