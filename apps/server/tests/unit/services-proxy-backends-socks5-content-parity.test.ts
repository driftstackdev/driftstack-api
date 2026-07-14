// Drift guard for apps/server/src/services/proxy-backends/socks5.ts.
// Pins EG-API-1.6 concrete SocksProxyBackend implementing
// SessionEgressService — Phase 1 SOCKS5 v1.0 launch path per founder
// verdict 2026-05-16. TCP-probe-before-handle pattern + per-WebContent
// env var contract per planning 133. OpenVPN + WireGuard explicitly
// out-of-scope until Phase 2/3 host-side harness work lands.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/proxy-backends/socks5.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/proxy-backends/socks5 content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("EG-API-1.6 module-level framing pinned: 'concrete SocksProxyBackend implementing SessionEgressService. Phase 1 SOCKS5 is the v1.0 launch path per the founder verdict 2026-05-16; OpenVPN and WireGuard remain 503-stubbed at this backend until their Phase 2/3 host-side harness work lands.' — pinned so the EG-API-1.6 anchor + Phase 1 v1.0-launch-path + 2026-05-16 verdict-date + Phase 2/3 deferral contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.6 — concrete SocksProxyBackend implementing\s*\n?\s*\/\/ SessionEgressService\. Phase 1 SOCKS5 is the v1.0 launch path\s*\n?\s*\/\/ per the founder verdict 2026-05-16; OpenVPN and WireGuard\s*\n?\s*\/\/ remain 503-stubbed at this backend until their Phase 2\/3 host-\s*\n?\s*\/\/ side harness work lands\./,
    );
  });

  it("4-responsibility-bullet framing pinned: 'Validate the customer-supplied SOCKS5 config (host + port present, port in range, optional auth credentials).' + 'TCP-probe the host:port with a short timeout before returning the EgressHandle (planning 133 §\"Phase 1 §5 — fail-fast on session create\"). Customers whose SOCKS5 host is unreachable get a 4xx with problem-type https://errors.driftstack.dev/egress-tunnel-unreachable instead of a delayed failure once the WebKit fork tries to connect.' + 'Return an EgressHandle whose envOverrides the harness reads when spawning the WebKit fork — DRIFTSTACK_SOCKS5_* env vars per planning 133's per-WebContent SOCKS5 config contract.' + 'releaseFromSession is a no-op for SOCKS5: env vars are process-scoped to the WebKit child; cleanup happens when the browser process exits.' — pinned so the 4-responsibility roster + planning-133-fail-fast + egress-tunnel-unreachable problem-type + per-WebContent env-var + no-op-release contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/\s+- Validate the customer-supplied SOCKS5 config \(host \+ port\s*\n?\s*\/\/\s+present, port in range, optional auth credentials\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- TCP-probe the host:port with a short timeout before\s*\n?\s*\/\/\s+returning the EgressHandle \(planning 133 §"Phase 1 §5 —\s*\n?\s*\/\/\s+fail-fast on session create"\)\. Customers whose SOCKS5 host\s*\n?\s*\/\/\s+is unreachable get a 4xx with problem-type\s*\n?\s*\/\/\s+`https:\/\/errors\.driftstack\.dev\/egress-tunnel-unreachable`/,
    );
    expect(body).toMatch(
      /\/\/\s+- releaseFromSession is a no-op for SOCKS5: env vars are\s*\n?\s*\/\/\s+process-scoped to the WebKit child; cleanup happens when\s*\n?\s*\/\/\s+the browser process exits\./,
    );
  });

  it('Out-of-scope 2-followup framing pinned: \'OpenVPN + WireGuard backends — return 503 at this layer until the harness-side macOS-VM-namespace work lands (planning 133 §"Phase 2" + §"Phase 3").\' + \'SOCKS5 handshake probe (vs raw TCP connect) — actual SOCKS5 greeting verification. The TCP probe today catches "wrong host / wrong port / firewall blocks" but doesn\'t verify the server is actually SOCKS5.\' — pinned so the 2-known-followup + TCP-probe-vs-real-SOCKS5-greeting-honesty contract all stay documented', () => {
    expect(body).toMatch(
      /\/\/ Out of scope for this slice \(planned follow-ups\):\s*\n?\s*\/\/\s+- OpenVPN \+ WireGuard backends — return 503 at this layer\s*\n?\s*\/\/\s+until the harness-side macOS-VM-namespace work lands\s*\n?\s*\/\/\s+\(planning 133 §"Phase 2" \+ §"Phase 3"\)\./,
    );
    expect(body).toMatch(
      /\/\/\s+- SOCKS5 handshake probe \(vs raw TCP connect\) — actual SOCKS5\s*\n?\s*\/\/\s+greeting verification\. The TCP probe today catches\s*\n?\s*\/\/\s+"wrong host \/ wrong port \/ firewall blocks" but doesn't\s*\n?\s*\/\/\s+verify the server is actually SOCKS5\./,
    );
  });

  it('DEFAULT_PROBE_TIMEOUT_MS = 3000 constant pinned. Drift to a longer timeout would delay session-create on a slow / unreachable proxy; drift to shorter would false-positive on a healthy-but-far proxy', () => {
    expect(body).toMatch(/const DEFAULT_PROBE_TIMEOUT_MS = 3_000;/);
  });

  it("SocksProxyBackendDeps 2-field shape pinned: optional tcpProbe (injectable for tests; default uses node:net's connect()) + optional probeTimeoutMs (default 3000). + 'Injectable TCP probe — tests pass a deterministic stub so we don't actually open sockets during unit tests.' framing — pinned so the test-injectable + default-via-node:net + 3000-ms-default contract stays documented", () => {
    expect(body).toMatch(/export interface SocksProxyBackendDeps \{/);
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s+Injectable TCP probe — tests pass a deterministic stub so we\s*\n?\s*\*\s+don't actually open sockets during unit tests\. Default uses\s*\n?\s*\*\s+node:net's connect\(\) with a short timeout\.\s*\n?\s*\*\/\s*\n?\s*tcpProbe\?: \(host: string, port: number, timeoutMs: number\) => Promise<void>;/,
    );
    expect(body).toMatch(/probeTimeoutMs\?: number;/);
  });

  it('defaultTcpProbe (exported for tests) retains actionable server-side diagnostics while customer routes map them to stable copy', () => {
    expect(body).toMatch(
      /export function defaultTcpProbe\(host: string, port: number, timeoutMs: number\): Promise<void> \{\s*\n?\s*return new Promise\(\(resolve, reject\) => \{\s*\n?\s*const socket: Socket = connect\(\{ host, port \}, \(\) => \{\s*\n?\s*clearTimeout\(timer\);[\s\S]*?socket\.end\(\);\s*\n?\s*resolve\(\);/,
    );
    expect(body).toMatch(
      /reject\(new Error\(`egress-tunnel-unreachable: timed out connecting to \$\{host\}:\$\{port\}`\)\);/,
    );
    expect(body).toMatch(
      /socket\.on\('error', \(err\) => \{\s*\n?\s*clearTimeout\(timer\);\s*\n?\s*reject\(new Error\(`egress-tunnel-unreachable: \$\{err\.message\}`\)\);/,
    );
  });

  it('W372 connection-time SSRF DNS-rebind layer pinned: the probe checks socket.remoteAddress (the ACTUAL resolved peer IP) via classifyUnsafeHost and rejects egress-proxy-host-not-allowed when it resolves to an internal address. Drift to dropping it would let a customer socks5.host that is a DOMAIN resolving to 169.254.169.254 / 10.x / loopback slip past the literal-host guard and reach the internal network', () => {
    expect(body).toMatch(/const peer = socket\.remoteAddress;/);
    expect(body).toMatch(/if \(peer !== undefined && classifyUnsafeHost\(peer\) !== null\) \{/);
    expect(body).toMatch(
      /egress-proxy-host-not-allowed: socks5\.host '\$\{host\}' resolved to internal address \$\{peer\}/,
    );
  });

  it("Non-socks5-proxy-type rejection framing pinned: 'OpenVPN + WireGuard backends are not yet wired at this backend. Surface a typed error that the route layer maps to 503 FeatureUnavailable — the customer sees a clean \"Phase X protocol not yet shipped\" message instead of a generic 500.' + Error('SocksProxyBackend does not handle proxy.type=\\'${proxy.type}\\'; OpenVPN + WireGuard are Phase 2/3 per planning 133 and ship with the harness-side macOS VM namespace work.') — pinned so the route-layer-maps-to-503 + Phase-2/3-cross-reference + harness-side-macOS-VM contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ OpenVPN \+ WireGuard backends are not yet wired at this\s*\n?\s*\/\/ backend\. Surface a typed error that the route layer maps\s*\n?\s*\/\/ to 503 FeatureUnavailable — the customer sees a clean\s*\n?\s*\/\/ "Phase X protocol not yet shipped" message instead of a\s*\n?\s*\/\/ generic 500\./,
    );
    expect(body).toMatch(
      /throw new Error\(\s*\n?\s*`SocksProxyBackend does not handle proxy\.type='\$\{proxy\.type\}'; ` \+\s*\n?\s*`OpenVPN \+ WireGuard are Phase 2\/3 per planning 133 and ship ` \+\s*\n?\s*`with the harness-side macOS VM namespace work\.`,\s*\n?\s*\);/,
    );
  });

  it('Config validation 4-rule pinned: host TRIMMED-then-non-empty (const host = rawHost.trim() so probe + env var get the clean host) + port integer in [1, 65535] + (username defined → password defined) + (password defined → username defined). Drift to dropping the both-or-neither auth rule would let half-configured auth slip through and the WebKit fork would silently authenticate as the host-OS user identity', () => {
    // The host is trimmed ONCE and the trimmed value used downstream (probe +
    // DRIFTSTACK_SOCKS5_PROXY_HOST env var). Validating rawHost.trim() but
    // propagating the untrimmed host let " host " pass then fail the probe.
    expect(body).toMatch(/const host = rawHost\.trim\(\);/);
    expect(body).toMatch(
      /if \(host\.length === 0\) \{\s*\n?\s*throw new Error\('socks5\.host must be non-empty'\);/,
    );
    expect(body).toMatch(
      /if \(!Number\.isInteger\(port\) \|\| port < 1 \|\| port > 65535\) \{\s*\n?\s*throw new Error\(`socks5\.port must be in \[1, 65535\]; got \$\{port\}`\);/,
    );
    expect(body).toMatch(
      /if \(username !== undefined && password === undefined\) \{\s*\n?\s*throw new Error\('socks5 requires both username \+ password, or neither'\);/,
    );
    expect(body).toMatch(
      /if \(password !== undefined && username === undefined\) \{\s*\n?\s*throw new Error\('socks5 requires both username \+ password, or neither'\);/,
    );
  });

  it('§4.17 SSRF guard pinned: socks5.host is classified via classifyUnsafeHost (shared webhook SSRF block list) + rejected with egress-proxy-host-not-allowed BEFORE the TCP probe. Drift to dropping it would let a customer point socks5.host at 169.254.169.254 / localhost / 10.x and have the backend (and the fork) connect into our internal network', () => {
    expect(body).toMatch(
      /import \{ classifyUnsafeHost \} from '\.\.\/\.\.\/lib\/webhook-target-guard\.js';/,
    );
    expect(body).toMatch(/const unsafeHostKind = classifyUnsafeHost\(host\);/);
    expect(body).toMatch(/egress-proxy-host-not-allowed: socks5\.host/);
  });

  it("Q.0.b TCP-probe-before-handle framing pinned: 'TCP-probe the customer's SOCKS5 host:port before returning the handle. Catches \"wrong host / wrong port / firewall blocks\" at session-create time so the customer sees a 4xx egress-tunnel-unreachable immediately rather than a delayed failure once the WebKit fork tries to connect (which surfaces 30+ seconds later with a less helpful error).' + await this.tcpProbe(host, port, this.probeTimeoutMs) — pinned so the Q.0.b verdict + fail-fast-at-create + actionable-immediate-vs-delayed-30s contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Q\.0\.b — TCP-probe the customer's SOCKS5 host:port before\s*\n?\s*\/\/ returning the handle\. Catches "wrong host \/ wrong port \/\s*\n?\s*\/\/ firewall blocks" at session-create time so the customer\s*\n?\s*\/\/ sees a 4xx egress-tunnel-unreachable immediately rather\s*\n?\s*\/\/ than a delayed failure once the WebKit fork tries to\s*\n?\s*\/\/ connect \(which surfaces 30\+ seconds later with a less\s*\n?\s*\/\/ helpful error\)\./,
    );
    expect(body).toMatch(/await this\.tcpProbe\(host, port, this\.probeTimeoutMs\);/);
  });

  it("envOverrides 5-key contract pinned: DRIFTSTACK_SOCKS5_PROXY_HOST + DRIFTSTACK_SOCKS5_PROXY_PORT + DRIFTSTACK_SOCKS5_UDP_ASSOCIATE + DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS + (conditional) USERNAME + PASSWORD. + 'UDP-ASSOCIATE defaults true so QUIC + HTTP/3 work end-to-end through the customer's proxy. If the customer's SOCKS5 server doesn't support UDP-ASSOCIATE, they pass udp_associate: false and lose QUIC/HTTP/3 (TCP-only egress remains).' + EG-WK-1.9 'when require_remote_dns is true, the WebKit fork uses SOCKS5 ATYP DOMAINNAME (0x03) so DNS lookups resolve through the proxy's resolver rather than the host's. Without propagating the schema flag through here, the WebKit fork has no way of knowing the customer asked for remote DNS — silent fallback to local resolution would leak the host's resolver behind the proxy.' — pinned so the env-var contract + UDP-ASSOCIATE-QUIC-tradeoff + EG-WK-1.9 remote-DNS-no-leak contract all stay documented", () => {
    expect(body).toMatch(
      /DRIFTSTACK_SOCKS5_PROXY_HOST: host,\s*\n?\s*DRIFTSTACK_SOCKS5_PROXY_PORT: String\(port\),\s*\n?\s*DRIFTSTACK_SOCKS5_UDP_ASSOCIATE: udp_associate \? '1' : '0',/,
    );
    expect(body).toMatch(
      /\/\/ EG-WK-1\.9 \(founder verdict 2026-05-17 ~20:15 UTC\) — when\s*\n?\s*\/\/ `require_remote_dns` is true, the WebKit fork uses SOCKS5\s*\n?\s*\/\/ ATYP DOMAINNAME \(0x03\) so DNS lookups resolve through the\s*\n?\s*\/\/ proxy's resolver rather than the host's\. Without propagating\s*\n?\s*\/\/ the schema flag through here, the WebKit fork has no way of\s*\n?\s*\/\/ knowing the customer asked for remote DNS — silent fallback\s*\n?\s*\/\/ to local resolution would leak the host's resolver behind\s*\n?\s*\/\/ the proxy\./,
    );
    expect(body).toMatch(/DRIFTSTACK_SOCKS5_REQUIRE_REMOTE_DNS: require_remote_dns \? '1' : '0',/);
    expect(body).toMatch(
      /if \(username !== undefined && password !== undefined\) \{\s*\n?\s*envOverrides\.DRIFTSTACK_SOCKS5_PROXY_USERNAME = username;\s*\n?\s*envOverrides\.DRIFTSTACK_SOCKS5_PROXY_PASSWORD = password;\s*\n?\s*\}/,
    );
  });

  it('releaseFromSession no-op framing pinned: "SOCKS5 env vars are scoped to the WebKit child process; cleanup is process-exit. No-op at the backend layer." + return Promise.resolve(). Drift to clearing env vars on release would race against still-running WebKit children', () => {
    expect(body).toMatch(
      /releaseFromSession\(_handle: EgressHandle\): Promise<void> \{\s*\n?\s*\/\/ SOCKS5 env vars are scoped to the WebKit child process;\s*\n?\s*\/\/ cleanup is process-exit\. No-op at the backend layer\.\s*\n?\s*return Promise\.resolve\(\);/,
    );
  });
});
