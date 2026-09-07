// Additive agent-session create-body fields derived from a profile's local
// launch settings (T-26, owner #12).
//
// Kept a pure function rather than inlined into the launch handler so the
// "flag present iff the setting is on" rule is unit-testable without driving a
// full session launch (client + proxy + window open).

import type { ProfileMeta } from './profiles-meta';

/**
 * The `stop_on_exit_ip_change` create-body fragment for a profile's launch.
 *
 * T-26 (owner #12): when the profile opted in, the server ends the session if
 * its exit IP rotates mid-session (a proxy that silently changed exit is a
 * fingerprint/geo break). Omitted when off, exactly like `skip_proxy_probe` and
 * `geolocation`: an absent flag is the default (never stop), so a `false` is
 * never written onto the body.
 */
export function stopOnExitIpChangeCreateFields(
  meta: ProfileMeta | undefined,
): { stop_on_exit_ip_change: true } | Record<string, never> {
  return meta?.stopOnExitIpChange === true ? { stop_on_exit_ip_change: true } : {};
}
