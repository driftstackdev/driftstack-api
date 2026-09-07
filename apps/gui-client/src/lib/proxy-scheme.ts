// T-20 — the ONE definition of which saved proxies the native SOCKS5 probe can
// honestly test.
//
// Four surfaces gated on scheme before this existed, and the fifth — the
// pre-launch gate in ProfilesView — did not: it sent a SOCKS5 greeting to an
// OpenVPN remote (a UDP endpoint parsed from the config), got `reachable:false`
// forever, wrote that into the shared probe cache on mount, and then asked
// "The proxy was unreachable on its last test … Launch anyway?" on every
// launch of a VPN profile (owner #6). Each gating surface spelled the predicate
// out for itself (`scheme === undefined || scheme === 'socks5'`,
// `p.scheme !== undefined && p.scheme !== 'socks5'`, `scheme === 'socks5'`),
// which is how the fifth site came to have none. One predicate, imported.
//
// Deliberately a module of its own rather than an export of lib/proxies: a
// dozen view suites replace lib/proxies with a hand-listed factory, and a new
// export there is undefined in every one of them the moment a shared code path
// reads it. Nothing mocks this file.

import type { AccountProxyScheme } from './account-proxies';

/** Whether the native SOCKS5 probe (`proxy_test`) can honestly test this proxy.
 *  Only a SOCKS5 — or a legacy row with no scheme, which predates the field and
 *  is SOCKS5 — is probeable; a VPN endpoint is mostly UDP and an HTTP proxy
 *  fails the SOCKS5 greeting, so for both the handshake always fails and the
 *  "unreachable" it returns is a fact about the probe, not the proxy. */
export function isSocks5Probeable(scheme: AccountProxyScheme | undefined): boolean {
  return scheme === undefined || scheme === 'socks5';
}

/** A tunnel scheme whose host/port is the config's endpoint (OpenVPN `remote`,
 *  WireGuard `Endpoint`) rather than a proxy listener. */
export function isVpnScheme(scheme: AccountProxyScheme | undefined): boolean {
  return scheme === 'openvpn' || scheme === 'wireguard';
}

/**
 * T-20 — the pre-flight copy when a non-SOCKS5 endpoint does not resolve.
 *
 * The SOCKS5 confirm ladder ("was unreachable" / "rejected its credentials" /
 * "could not route traffic") describes a handshake this proxy never gets, so a
 * VPN row must never be shown any of it. A DNS miss has exactly one honest
 * sentence, and it names the line in the config the customer should look at:
 * OpenVPN's `remote`, WireGuard's `Endpoint`. An HTTP proxy has no config, so
 * it names the address.
 */
export function endpointUnresolvedCopy(
  scheme: AccountProxyScheme | undefined,
  host: string,
): string {
  if (scheme === 'openvpn')
    return `The VPN endpoint ${host} could not be resolved. Check the config's remote line.`;
  if (scheme === 'wireguard')
    return `The VPN endpoint ${host} could not be resolved. Check the config's Endpoint line.`;
  return `The proxy endpoint ${host} could not be resolved. Check its address.`;
}
