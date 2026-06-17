// ARC A — account proxies service. Owns PROFILE_MASTER_KEY + the repo and
// resolves a stored proxy to a dispatch-ready SocksProxyConfig: unwrap the
// password under the account TMK + re-assert the SSRF host-guard, fail-closed.
// Encapsulates the two sensitive operations (cross-account decrypt + SSRF) in
// one tested place, used by the agent-session dispatch.

import type { SocksProxyConfig } from '@driftstack/api-types';
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
  }): Promise<SocksProxyConfig | null> {
    const row = await this.repo.findById({ id: args.proxyId, accountId: args.accountId });
    if (row === null) return null;
    if (row.scheme !== 'socks5') return null;
    // The host was validated at create/update; re-assert here so a row inserted
    // by any other path can't smuggle a private/loopback/metadata host.
    const unsafe = classifyUnsafeHost(row.host);
    if (unsafe !== null) throw new UnsafeProxyHostError(unsafe);
    let password: string | undefined;
    if (row.wrappedPassword !== null && this.masterKey !== null) {
      password = unwrapAccountSecret(this.masterKey, args.accountId, row.wrappedPassword).toString(
        'utf8',
      );
    }
    return {
      host: row.host,
      port: row.port,
      udp_associate: true,
      // Resolve DNS through the proxy, not the local host — avoids a DNS leak
      // that would reveal the real egress (the egress design's default intent).
      require_remote_dns: true,
      ...(row.username !== null ? { username: row.username } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }
}
