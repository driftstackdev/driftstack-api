// ARC A — account proxies service. Owns PROFILE_MASTER_KEY + the repo and
// resolves a stored proxy to a dispatch-ready SocksProxyConfig: unwrap the
// password under the account TMK + re-assert the SSRF host-guard, fail-closed.
// Encapsulates the two sensitive operations (cross-account decrypt + SSRF) in
// one tested place, used by the agent-session dispatch.

import type { InlineVpnProxyWire, SocksProxyConfig } from '@driftstack/api-types';
import { InlineVpnProxyWireSchema } from '@driftstack/api-types';
import type { AccountProxiesRepo, AccountProxyRow } from '../db/account-proxies-repo.js';
import { unwrapAccountSecret } from '../lib/profile-key-hierarchy.js';
import { classifyUnsafeHost } from '../lib/webhook-target-guard.js';

/** Thrown when a stored proxy's host resolves to an internal-reachable address
 *  at dispatch time (defense-in-depth; the host is also guarded at create). The
 *  best-effort dispatch caller catches it and skips — a session is NEVER run
 *  through an SSRF-unsafe proxy. */
export class UnsafeProxyHostError extends Error {
  constructor(public readonly kind: string) {
    super(`Proxy host is not allowed (${kind}).`);
    this.name = 'UnsafeProxyHostError';
  }
}

/** 7-day TTL for a verified per-proxy UDP capability (A3 W2756). A proxy's
 *  UDP_ASSOCIATE support is stable, but a customer can reconfigure the exit, so a
 *  verified value older than this is treated as unknown (→ omit → the fork
 *  re-probes). */
const UDP_CAPABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Read a FRESH verified UDP capability off a proxy row's `config` jsonb. Returns
 *  the bool only when `config.udp_capable` is a real bool AND `config.udp_verified_at`
 *  is an ISO timestamp within the TTL; otherwise undefined (→ resolveForDispatch
 *  omits `udp_capable` → harness leaves DRIFTSTACK_PROXY_UDP_CAPABLE unset → the
 *  fork's async probe = today's safe default). The value is only ever WRITTEN from a
 *  real data-path probe (the deferred Swift probe-writer; A3 to spec the
 *  server→harness control-command), never from a customer claim. */
function freshUdpCapable(config: Record<string, unknown>): boolean | undefined {
  const cap = config['udp_capable'];
  const at = config['udp_verified_at'];
  if (typeof cap !== 'boolean' || typeof at !== 'string') return undefined;
  const verifiedMs = Date.parse(at);
  if (Number.isNaN(verifiedMs)) return undefined;
  if (Date.now() - verifiedMs > UDP_CAPABLE_TTL_MS) return undefined;
  return cap;
}

export class AccountProxiesService {
  constructor(
    private readonly repo: AccountProxiesRepo,
    private readonly masterKey: Buffer | null,
  ) {}

  /** Owner-scoped existence check for the session-create validation path —
   *  null when not found / wrong account (the route maps null → 404). */
  findOwned(id: string, accountId: string): Promise<AccountProxyRow | null> {
    return this.repo.findById({ id, accountId });
  }

  /**
   * Resolve a stored proxy to a dispatch-ready SocksProxyConfig. Owner-scoped.
   * Returns null when the proxy isn't found for this account, or isn't `socks5`
   * (http proxies aren't injectable through the SocksProxyConfig dispatch slot
   * yet). Unwraps the password under THIS account's TMK (a row wrapped under a
   * different account can't be decrypted) and re-asserts the SSRF host-guard —
   * an internal-reachable host throws UnsafeProxyHostError (fail-closed).
   */
  async resolveForDispatch(args: {
    proxyId: string;
    accountId: string;
  }): Promise<(SocksProxyConfig & { udp_capable?: boolean | null }) | InlineVpnProxyWire | null> {
    const row = await this.repo.findById({ id: args.proxyId, accountId: args.accountId });
    if (row === null) return null;
    // The host (socks5 host / VPN endpoint host) was validated at create; re-assert
    // here so a row inserted by any other path can't smuggle a private/loopback/
    // metadata host into egress. Applies to ALL schemes.
    const unsafe = classifyUnsafeHost(row.host);
    if (unsafe !== null) throw new UnsafeProxyHostError(unsafe);

    if (row.scheme === 'openvpn' || row.scheme === 'wireguard') {
      return this.resolveVpnForDispatch(row, args.accountId);
    }
    if (row.scheme !== 'socks5') return null; // http isn't an inline-dispatch target

    let password: string | undefined;
    if (row.wrappedPassword !== null && this.masterKey !== null) {
      password = unwrapAccountSecret(this.masterKey, args.accountId, row.wrappedPassword).toString(
        'utf8',
      );
    }
    // Proxy UDP pre-detection (A3 W2756): emit the verified capability when fresh
    // so the harness can skip the per-session ~3s probe; omitted (→ fork async-probe
    // = today's behavior) until the deferred probe-writer populates config.
    const udpCapable = freshUdpCapable(row.config);
    return {
      host: row.host,
      port: row.port,
      udp_associate: true,
      ...(udpCapable !== undefined ? { udp_capable: udpCapable } : {}),
      // Resolve DNS through the proxy, not the local host — avoids a DNS leak
      // that would reveal the real egress (the egress design's default intent).
      require_remote_dns: true,
      ...(row.username !== null ? { username: row.username } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }

  /**
   * Build the FLAT inline VPN dispatch wire (A3 W2163: sibling fields, NOT
   * nested) from a stored VPN row. Unwraps the secret under THIS account's TMK —
   * a row wrapped under a different account CANNOT be decrypted (GCM auth fails),
   * the same cross-account isolation the socks5 password + profile DEK rely on.
   * The non-secret fields ride `config` (jsonb). Returns null when encryption
   * isn't configured or the row is malformed (fail-closed; the session just runs
   * without this proxy rather than dispatching a broken VPN).
   */
  private resolveVpnForDispatch(
    row: AccountProxyRow,
    accountId: string,
  ): InlineVpnProxyWire | null {
    if (row.wrappedSecret === null || this.masterKey === null) return null;
    let secret: string;
    try {
      secret = unwrapAccountSecret(this.masterKey, accountId, row.wrappedSecret).toString('utf8');
    } catch {
      return null; // wrong-account TMK / corrupted blob → fail-closed
    }
    const cfg = row.config;
    const str = (k: string): string | undefined =>
      typeof cfg[k] === 'string' ? cfg[k] : undefined;

    let candidate: unknown;
    if (row.scheme === 'openvpn') {
      // secret = JSON { config_blob, password? }; username rides config.
      let parsed: { config_blob?: unknown; password?: unknown };
      try {
        parsed = JSON.parse(secret) as typeof parsed;
      } catch {
        return null;
      }
      if (typeof parsed.config_blob !== 'string') return null;
      candidate = {
        type: 'openvpn',
        config_blob: parsed.config_blob,
        ...(str('username') !== undefined ? { username: str('username') } : {}),
        ...(typeof parsed.password === 'string' ? { password: parsed.password } : {}),
      };
    } else {
      // wireguard: secret = the raw private_key; the rest rides config.
      candidate = {
        type: 'wireguard',
        private_key: secret,
        peer_public_key: str('peer_public_key'),
        endpoint: str('endpoint'),
        allowed_ips: str('allowed_ips'),
        address: str('address'),
        ...(str('dns') !== undefined ? { dns: str('dns') } : {}),
      };
    }
    // Validate the FLAT wire before it leaves the server — a missing field
    // (e.g. a WG row stored before `address` was captured) fails closed here
    // rather than erroring every session at the harness provision step.
    const parsed = InlineVpnProxyWireSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
}
