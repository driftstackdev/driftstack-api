// T-2 — the local/private-host advice, wherever a proxy host is typed.
//
// Owner: "do not confuse a customer that they could add a local proxy and later
// find out it doesn't work." The advice existed and was rendered at exactly ONE
// of the five places a host can be entered — the Proxies form. The first-run
// wizard and both profile modals showed nothing, and the wizard's host field
// went further and offered `127.0.0.1` as its PLACEHOLDER, which suggests the
// one configuration that cannot work.
//
// The reason it drifted is the ordinary one: each entry point carries its own
// partly-filled state and `validateDraft` needs a label before it says anything,
// so every site would have had to re-derive the advice. One component, given a
// bare host string, removes that. It renders NOTHING for a reachable host, so it
// can sit unconditionally in a form without a guard at the call site — the
// condition it tests is the only condition it should ever depend on.

import { hostWarningFor } from '../lib/proxies';

/**
 * The advice for `host`, or nothing when the host is reachable from the servers.
 *
 * `data-component`/`role` match the original ProxiesView markup verbatim so the
 * existing selectors keep working and every site reads identically to a customer.
 */
export function ProxyHostWarning({ host }: { host: string }): React.ReactElement | null {
  const warning = hostWarningFor(host);
  if (warning === undefined) return null;
  return (
    <span
      data-component="proxy-host-warning"
      role="note"
      className="mt-1 text-2xs text-status-busy"
    >
      {warning}
    </span>
  );
}
